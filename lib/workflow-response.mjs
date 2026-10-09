import {TranscriptError} from './transcript-errors.mjs';
import {digest,DATABASE_NOW_MS_SQL} from './snapshot-cache.mjs';

const stores={creator:{table:'creator_response_chunks',parent:'creator_jobs',pages:'creator_job_pages',key:'job_id'},playlist:{table:'playlist_response_chunks',parent:'playlist_sessions',pages:'playlist_pages',key:'session_id'}};
// At most 1.5 MB of UTF-8 (3 bytes per UTF-16 code unit), below D1's
// 2,000,000-byte row ceiling including keys. Never split a surrogate pair.
const PART_CHARS=500000;
// D1 has a real per-row limit. Split durable replay records internally instead
// of limiting or paginating the response sent to the client. Small/legacy
// receipts retain the existing inline JSON format.
export async function planWorkflowResponse(db,kind,row,token,_now,response){
  const store=stores[kind],json=JSON.stringify(response);
  if(json.length<=PART_CHARS)return {json,statements:[],parts:0};
  const parts=[];
  for(let start=0;start<json.length;){let end=Math.min(json.length,start+PART_CHARS);if(end<json.length&&/[\uD800-\uDBFF]/.test(json[end-1]))end--;parts.push(json.slice(start,end));start=end;}
  const statements=parts.map((body,part)=>db.prepare(`INSERT INTO ${store.table} (${store.key},revision,part,body) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM ${store.parent} WHERE id=? AND revision=? AND lease_token=? AND lease_expires>${DATABASE_NOW_MS_SQL} AND owner_key=?)`).bind(row.id,row.revision,part,body,row.id,row.revision,token,row.owner_key));
  return {json:JSON.stringify({$stored_response:{v:1,parts:parts.length,sha256:await digest(json)}}),statements,parts:parts.length};
}
export function assertWorkflowResponse(db,kind,row,prepared,stateJson){
  const s=stores[kind];
  // Conditional writes that affect zero rows do not make D1 batch() fail.
  // If ANY part/receipt was written but the fenced state transition or another
  // part was skipped, violate NOT NULL to roll the WHOLE transaction back.
  // A wholly lost CAS writes nothing and leaves any winning revision alone.
  return db.prepare(`UPDATE ${s.parent} SET state_json=CASE WHEN owner_key=? AND revision=? AND state_json=? AND EXISTS (SELECT 1 FROM ${s.pages} WHERE ${s.key}=? AND revision=? AND response_json=?) AND (SELECT COUNT(*) FROM ${s.table} WHERE ${s.key}=? AND revision=?)=? THEN state_json ELSE NULL END WHERE id=? AND (EXISTS (SELECT 1 FROM ${s.pages} WHERE ${s.key}=? AND revision=? AND response_json=?) OR EXISTS (SELECT 1 FROM ${s.table} WHERE ${s.key}=? AND revision=?))`).bind(row.owner_key,row.revision+1,stateJson,row.id,row.revision,prepared.json,row.id,row.revision,prepared.parts,row.id,row.id,row.revision,prepared.json,row.id,row.revision);
}
export async function readWorkflowResponse(db,kind,row,revision,json){
  const value=JSON.parse(json),manifest=value.$stored_response;
  if(!manifest)return value;
  if(manifest.v!==1||!Number.isSafeInteger(manifest.parts)||manifest.parts<1||!/^[a-f0-9]{64}$/.test(manifest.sha256??''))throw new TranscriptError('storage_unavailable','Stored workflow response manifest is invalid.',{},true);
  const store=stores[kind],parts=[];
  for(let p=0;p<manifest.parts;p+=8){
    const end=Math.min(manifest.parts,p+8),{results}=await db.prepare(`SELECT part,body FROM ${store.table} WHERE ${store.key}=? AND revision=? AND part>=? AND part<? AND EXISTS (SELECT 1 FROM ${store.parent} WHERE id=? AND owner_key=?) ORDER BY part`).bind(row.id,revision,p,end,row.id,row.owner_key).all();
    if(results?.length!==end-p)throw new TranscriptError('storage_unavailable','Stored workflow response is incomplete.',{},true);
    for(let i=0;i<results.length;i++){if(results[i].part!==p+i||typeof results[i].body!=='string')throw new TranscriptError('storage_unavailable','Stored workflow response ordering is invalid.',{},true);parts.push(results[i].body);}
  }
  const restored=parts.join('');
  if(await digest(restored)!==manifest.sha256)throw new TranscriptError('storage_unavailable','Stored workflow response checksum changed.',{},true);
  return JSON.parse(restored);
}
