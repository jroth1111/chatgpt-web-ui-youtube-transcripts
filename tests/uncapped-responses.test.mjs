import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotCache} from '../lib/snapshot-cache.mjs';
import {TranscriptService} from '../lib/transcript-service.mjs';
import {transcriptBatch,responseBytes} from '../lib/transcript-batch.mjs';
import {handleMcp} from '../lib/mcp-handler.mjs';
import {creatorTranscripts} from '../lib/creator-transcripts.mjs';
import {playlistTool} from '../lib/playlist-tools.mjs';
import {transcriptRange} from '../lib/chapter-range-tools.mjs';
import {cleanTranscript} from '../lib/transcript-markdown.mjs';
import {localDb} from './sqlite-adapter.mjs';
import {planWorkflowResponse,readWorkflowResponse} from '../lib/workflow-response.mjs';
import {digest,chunkSegments} from '../lib/snapshot-cache.mjs';
import {readFileSync} from 'node:fs';

const owner='owner',ids=Array.from({length:10},(_,i)=>`uncapped_${String(i).padStart(2,'0')}`);
const fixture=(id,count=2000)=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'manual',extractor_version:'synthetic-uncapped',extraction_method:'synthetic',segments:Array.from({length:count},(_,i)=>({text:`Cue ${i}: ${'字幕🦜 "\\* '.repeat(12)}END${i}.`,start:i*2,duration:1}))});
async function setup(count=1){const db=localDb(),fixtures=ids.slice(0,count).map(id=>fixture(id));for(const f of fixtures)await new SnapshotCache(db).write(owner,f);return {db,fixtures,service:new TranscriptService(db,{extractorFactory:()=>assert.fail('Stored captions must not refetch')})};}
const canonical=text=>text.replace(/\s+/g,' ').trim();
const body=markdown=>markdown.split(/Language: [^\n]*\n\n/)[1].split(/\n\n\*\*(?:More captions remain|Transcript snapshot complete)/)[0];
function complete(result,fixtures){assert.equal(result.success_count,fixtures.length);assert.equal(result.has_more,false);assert.deepEqual(result.next_cursors,{});for(let i=0;i<fixtures.length;i++){const r=result.results[i];assert.equal(r.delivery,'full');assert.equal(r.returned_segment_count,fixtures[i].segments.length);assert.equal(r.next_cursor,null);assert.equal(r.overflow_reason,null);}assert(responseBytes(result)>256*1024);}

test('uncapped: one cleaned response above 256 KiB contains every stored cue',async()=>{const {db,service,fixtures}=await setup();try{const result=await transcriptBatch(service,{videos:[ids[0]]},owner);complete(result,fixtures);assert.equal(canonical(body(result.markdown)),canonical(cleanTranscript(fixtures[0].segments)));}finally{db.sqlite.close();}});
test('uncapped: actual JSON-RPC tool replies above 256 KiB are delivered, not replaced with an error',async()=>{const {db,service,fixtures}=await setup();try{const request=new Request('https://private.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','oai-authenticated-user-id':owner,'oai-authenticated-user-email':'owner@example.test'},body:JSON.stringify({jsonrpc:'2.0',id:'unicode-🦜',method:'tools/call',params:{name:'get_transcripts',arguments:{videos:[ids[0]]}}})});const response=await handleMcp(request,{OWNER_EMAIL:'owner@example.test',DB:db},{serviceFactory:()=>service}),wire=await response.text(),rpc=JSON.parse(wire);assert(Buffer.byteLength(wire)>256*1024);assert.equal(rpc.result.isError,false);assert.equal(rpc.result.structuredContent.results[0].returned_segment_count,fixtures[0].segments.length);assert.equal(canonical(body(rpc.result.content[0].text)),canonical(cleanTranscript(fixtures[0].segments)));}finally{db.sqlite.close();}});
test('uncapped: ten full transcripts and creator replay exceed a D1 single-row size without client pagination',async()=>{const {db,service,fixtures}=await setup(10);try{const batch=await transcriptBatch(service,{videos:ids},owner);complete(batch,fixtures);assert(responseBytes(batch)>2000000);const input={creator_url:'https://www.youtube.com/@SyntheticUncapped',limit:10},options={catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:ids.map(id=>({id})),continuation:null})})};const first=await creatorTranscripts(service,db,input,owner,options);complete(first,fixtures);const replay=await creatorTranscripts(service,db,input,owner,options);assert.equal(replay.replayed,true);assert.equal(replay.markdown,first.markdown);assert.deepEqual(replay.results,first.results);}finally{db.sqlite.close();}});
test('uncapped: playlist full bodies and exact replay are not subject to an aggregate response cap',async()=>{const {db,service,fixtures}=await setup(10);try{const metadata={request:async()=>({title:'Synthetic',entries:ids.map((id,i)=>({video_id:id,reported_position:i+1,availability:'reported_public',url:`https://www.youtube.com/watch?v=${id}`})),continuation:null,metadata_id:'fixture-metadata',acquisition_worker_id:'fixture-worker'})},input={playlist:'PLabcdefghijklmnop',limit:10};const first=await playlistTool('get_playlist_transcripts',service,db,input,owner,{metadata});complete(first,fixtures);const replay=await playlistTool('get_playlist_transcripts',service,db,input,owner,{metadata});assert.equal(replay.replayed,true);assert.equal(replay.markdown,first.markdown);assert.deepEqual(replay.positions,first.positions);}finally{db.sqlite.close();}});
test('uncapped: cleaned ranges above 256 KiB return the entire requested cue coverage',async()=>{const {db,service,fixtures}=await setup();try{const result=await transcriptRange(service,db,{url:ids[0],start:0,end:4000},owner);assert.equal(result.delivery,'full');assert.equal(result.has_more,false);assert.equal(result.returned_segment_count,fixtures[0].segments.length);assert(responseBytes(result)>256*1024);}finally{db.sqlite.close();}});

test('uncapped: replay chunks preserve Unicode and reject missing/corrupt/foreign-owner parts',async()=>{
 const {db,service}=await setup();try{
  const input={creator_url:'https://www.youtube.com/@ChunkIntegrity',limit:1},options={catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:[{id:ids[0]}],continuation:null})})};
  await creatorTranscripts(service,db,input,owner,options);
  const row=db.sqlite.prepare('SELECT * FROM creator_jobs').get();row.revision=1;row.lease_token='fixture-token';row.lease_expires=Date.now()+120000;
  db.sqlite.prepare('UPDATE creator_jobs SET lease_token=?,lease_expires=? WHERE id=?').run(row.lease_token,row.lease_expires,row.id);
  const value={markdown:'x'.repeat(499983)+'🦜字幕'.repeat(300000),marker:'END'},plan=await planWorkflowResponse(db,'creator',row,row.lease_token,Date.now(),value);await db.batch(plan.statements);
  assert(plan.statements.length>1);assert.deepEqual(await readWorkflowResponse(db,'creator',row,1,plan.json),value);
  const physical=db.sqlite.prepare('SELECT part,body,length(CAST(body AS BLOB)) AS bytes FROM creator_response_chunks WHERE job_id=? AND revision=1 ORDER BY part').all(row.id);
  assert(physical.every(p=>p.bytes<2000000&&!/[\uD800-\uDBFF]$/.test(p.body)));
  await assert.rejects(readWorkflowResponse(db,'creator',{...row,owner_key:'wrong-owner'},1,plan.json),e=>e.code==='storage_unavailable');
  db.sqlite.prepare('UPDATE creator_response_chunks SET body=? WHERE job_id=? AND revision=1 AND part=0').run('corrupted',row.id);
  await assert.rejects(readWorkflowResponse(db,'creator',row,1,plan.json),e=>e.code==='storage_unavailable');
  db.sqlite.prepare('DELETE FROM creator_response_chunks WHERE job_id=? AND revision=1 AND part=0').run(row.id);
  await assert.rejects(readWorkflowResponse(db,'creator',row,1,plan.json),e=>e.code==='storage_unavailable');
 }finally{db.sqlite.close();}
});
test('uncapped: a failed replay-part write rolls back the entire creator receipt and revision',async()=>{
 const {db,service}=await setup(3);try{
  db.sqlite.exec("CREATE TRIGGER fail_response_part BEFORE INSERT ON creator_response_chunks WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
  const input={creator_url:'https://www.youtube.com/@AtomicReplay',limit:3},options={catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:ids.slice(0,3).map(id=>({id})),continuation:null})})};
  await assert.rejects(creatorTranscripts(service,db,input,owner,options),e=>e.code==='storage_unavailable');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM creator_response_chunks').get().n,0);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM creator_job_pages').get().n,0);assert.equal(db.sqlite.prepare('SELECT revision FROM creator_jobs').get().revision,0);
  assert.equal(db.sqlite.prepare('SELECT lease_token FROM creator_jobs').get().lease_token,null);
 }finally{db.sqlite.close();}
});
test('uncapped: bulk snapshot reads retain capability and cue-index checks',async()=>{
 const {db,service}=await setup();try{
  const first=await service.call('get_transcript',{url:ids[0]},owner);
  await assert.rejects(async()=>{for await(const _page of service.cache.followingPages({...first},owner,ids[0])){}},e=>e.code==='snapshot_unavailable');
  await assert.rejects(async()=>{for await(const _page of service.cache.followingPages(first,'wrong-owner',ids[0])){}},e=>e.code==='snapshot_unavailable');
  db.sqlite.prepare('UPDATE transcript_chunks SET first_index=999 WHERE snapshot_id=? AND page=1').run(first.snapshot_id);
  const result=await transcriptBatch(service,{videos:[ids[0]]},owner);assert.equal(result.results[0].ok,false);assert.equal(result.results[0].error.code,'storage_unavailable');
 }finally{db.sqlite.close();}
});
test('uncapped: old bound range cursors finish their whole tail and still reject changed inputs',async()=>{
 const {db,service,fixtures}=await setup();try{
  const row=await service.cache.latest(owner,ids[0]),range=await digest(JSON.stringify([owner,ids[0],null,row.id,0,4000,null]));
  const cursor=btoa(JSON.stringify({v:1,snapshot:row.id,range,page:1})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const result=await transcriptRange(service,db,{url:ids[0],start:0,end:4000,next_cursor:cursor},owner);
  assert.equal(result.delivery,'paged');assert.equal(result.has_more,false);assert.equal(result.next_cursor,null);assert.equal(result.returned_segment_count,fixtures[0].segments.length-chunkSegments(fixtures[0].segments)[0].length);
  await assert.rejects(transcriptRange(service,db,{url:ids[0],start:1,end:4000,next_cursor:cursor},owner),e=>e.code==='invalid_cursor');
 }finally{db.sqlite.close();}
});
test('uncapped: replay-storage migration is additive and preserves existing tables',()=>{
 const db=localDb();try{db.sqlite.exec('DROP TABLE creator_response_chunks; DROP TABLE playlist_response_chunks;');const before=db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),sql=readFileSync(new URL('../drizzle/0006_cooing_the_renegades.sql',import.meta.url),'utf8');assert(!/^\s*(?:DROP|ALTER|DELETE|UPDATE|REPLACE)\b/im.test(sql));db.sqlite.exec(sql);assert.deepEqual(db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('creator_response_chunks','playlist_response_chunks') ORDER BY name").all(),before);assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.sqlite.close();}
});
