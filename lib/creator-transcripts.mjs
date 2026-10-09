import { DEFAULT_JOB_LANGUAGE } from './caption-default.mjs';
import { CreatorCatalog, creatorUrl } from './creator-catalog.mjs';
import { TranscriptError } from './transcript-errors.mjs';
import { validateLanguage } from './youtube-extractor.mjs';
import { digest } from './snapshot-cache.mjs';
import { transcriptBatch } from './transcript-batch.mjs';
import {planWorkflowResponse,readWorkflowResponse} from './workflow-response.mjs';

const SESSION_TTL=24*60*60*1000,MANIFEST_TTL=5*60*1000;
export function creatorArguments(args) {
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['creator_url','limit','lang','creator_cursor','delivery'].includes(key)))throw new TranscriptError('invalid_input','Use creator_url, optional limit (default 10), lang and creator_cursor.');
  const url=creatorUrl(args.creator_url),limit=args.limit??10;validateLanguage(args.lang);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TranscriptError('invalid_input','Creator limit must be an integer from 1 to 100. Results are returned in bounded batches.');
  if(args.creator_cursor!==undefined&&(typeof args.creator_cursor!=='string'||args.creator_cursor.length>256))throw new TranscriptError('invalid_cursor','Invalid creator cursor.');
  if(args.delivery!==undefined&&!['full','paged'].includes(args.delivery))throw new TranscriptError('invalid_input','delivery must be full or paged.');
  return {url,limit,lang:args.lang,cursor:args.creator_cursor,delivery:args.delivery??'full'};
}
const cursor=(id,revision)=>btoa(JSON.stringify({v:1,id,revision})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function decode(value) {try{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const parsed=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));if(parsed.v!==1||! /^[a-f0-9-]{36}$/.test(parsed.id)||!Number.isSafeInteger(parsed.revision)||parsed.revision<1)throw new Error();return parsed;}catch{throw new TranscriptError('invalid_cursor','Malformed creator cursor.');}}
class JobStore {
  constructor(db,now){this.db=db;this.now=now;}
  async read(fn){try{return await fn();}catch(error){if(error instanceof TranscriptError)throw error;throw new TranscriptError('storage_unavailable','Creator workflow storage could not complete the operation.',{},true);}}
  async recent(key){return this.read(()=>this.db.prepare('SELECT * FROM creator_jobs WHERE request_key = ? AND created_ms > ? AND expires_at > ? ORDER BY created_ms DESC LIMIT 1').bind(key,this.now()-MANIFEST_TTL,this.now()).first());}
  async get(id,owner){const row=await this.read(()=>this.db.prepare('SELECT * FROM creator_jobs WHERE id = ? AND owner_key = ? AND expires_at > ?').bind(id,owner,this.now()).first());if(!row)throw new TranscriptError('invalid_cursor','Creator cursor is unavailable or belongs to another authorized namespace.');return row;}
  async page(job,revision){return this.read(async()=>{const row=await this.db.prepare('SELECT response_json FROM creator_job_pages WHERE job_id = ? AND revision = ?').bind(job.id,revision).first();return row?readWorkflowResponse(this.db,'creator',job,revision,row.response_json):null;});}
  async create(key,owner,args,state){const id=crypto.randomUUID(),now=this.now();await this.read(()=>this.db.prepare('INSERT INTO creator_jobs (id, request_key, owner_key, creator_url, lang_key, requested_limit, state_json, created_ms, expires_at, revision, lease_token, lease_expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0)').bind(id,key,owner,args.url,args.lang??DEFAULT_JOB_LANGUAGE,args.limit,JSON.stringify(state),now,now+SESSION_TTL).run());return this.get(id,owner);}
  async lock(row){const token=crypto.randomUUID(),now=this.now();const result=await this.read(()=>this.db.prepare('UPDATE creator_jobs SET lease_token = ?, lease_expires = ? WHERE id = ? AND revision = ? AND lease_expires <= ?').bind(token,now+120000,row.id,row.revision,now).run());if(result.meta?.changes!==1)throw new TranscriptError('extraction_in_progress','This creator workflow is already running. Retry the same cursor later.',{retry_after_seconds:2},true);return token;}
  async release(id,token){await this.read(()=>this.db.prepare('UPDATE creator_jobs SET lease_token = NULL, lease_expires = 0 WHERE id = ? AND lease_token = ?').bind(id,token).run());}
  async commit(row,token,state,response){const now=this.now(),stateJson=JSON.stringify(state),prepared=await planWorkflowResponse(this.db,'creator',row,token,now,response);
    if(new TextEncoder().encode(stateJson).length>128*1024)throw new TranscriptError('response_too_large','Creator selection state exceeded its storage bound; no captions were truncated.');
    const mutations=await this.read(()=>this.db.batch([
      ...prepared.statements,
      this.db.prepare('INSERT INTO creator_job_pages (job_id, revision, response_json) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM creator_jobs WHERE id = ? AND revision = ? AND lease_token = ? AND lease_expires > ?)').bind(row.id,row.revision,prepared.json,row.id,row.revision,token,now),
      this.db.prepare('UPDATE creator_jobs SET state_json = ?, revision = revision + 1, lease_token = NULL, lease_expires = 0 WHERE id = ? AND revision = ? AND lease_token = ? AND lease_expires > ?').bind(stateJson,row.id,row.revision,token,now)
    ]));
    if(mutations?.length!==prepared.statements.length+2||mutations.some(m=>m.meta?.changes!==1))throw new TranscriptError('extraction_in_progress','Creator workflow lease changed; retry the same cursor.',{retry_after_seconds:2},true);
  }
}
export async function creatorTranscripts(service,db,input,owner,{now=()=>Date.now(),catalogFactory=options=>new CreatorCatalog(options),budgetMs=45000}={}) {
  const args=creatorArguments(input),store=new JobStore(db,now),key=await digest(JSON.stringify([owner,args.url,args.limit,args.lang??DEFAULT_JOB_LANGUAGE,'full-text-v1',args.delivery])),deadline=now()+budgetMs;
  let row;
  if(args.cursor){const parsed=decode(args.cursor);row=await store.get(parsed.id,owner);if(row.request_key!==key&&row.request_key!==await digest(JSON.stringify([owner,args.url,args.limit,args.lang??DEFAULT_JOB_LANGUAGE])))throw new TranscriptError('invalid_cursor','Keep creator URL, limit and language unchanged.');const previous=await store.page(row,parsed.revision);if(previous)return {...previous,replayed:true};if(row.revision!==parsed.revision)throw new TranscriptError('invalid_cursor','Creator cursor revision does not match this workflow.');}
  else{row=await store.recent(key);if(row){const previous=await store.page(row,0);if(previous)return {...previous,replayed:true};if(row.revision!==0)throw new TranscriptError('extraction_in_progress','Creator workflow initialization is in progress.',{retry_after_seconds:2},true);}}
  const catalog=catalogFactory({now,budgetMs:Math.max(1,deadline-now())});
  if(!row){const releaseInitialization=await service.cache.claim(owner,`creator:${key}`);
    try{row=await store.recent(key);if(row){const previous=await store.page(row,0);if(previous)return {...previous,replayed:true};}
      else{const release=await service.cache.lease();let feed;try{feed=await catalog.start(args.url);}finally{await release().catch(()=>{});}
        row=await store.create(key,owner,args,{channel_id:feed.channel_id,channel_title:feed.channel_title,context:feed.context,pending:feed.videos,continuation:feed.continuation,
          scanned:[],succeeded:[],discovered_ids:feed.videos.map(video=>video.id),unresolved:[],retry_counts:{},continuation_hashes:[],scan_limit:Math.min(300,args.limit*3),discovery_pages:1,discovery_page_limit:Math.min(20,Math.ceil(args.limit*3/10)+2),exhausted:false});}
    }finally{await releaseInitialization().catch(()=>{});}
  }
  const token=await store.lock(row);
  try {
    let state=JSON.parse(row.state_json);const before=state.succeeded.length;
    // Skip repeated feed entries before making any transcript request.
    state.pending=state.pending.filter((video,index,all)=>!state.scanned.includes(video.id)&&all.findIndex(item=>item.id===video.id)===index);
    let pages=0;
    while(!state.pending.length&&state.continuation&&pages<2&&state.discovery_pages<state.discovery_page_limit&&state.scanned.length<state.scan_limit&&now()<deadline){
      const hash=await digest(state.continuation);if(state.continuation_hashes.includes(hash))throw new TranscriptError('parsing_failure','Creator continuation repeated; refusing an unbounded scan.');
      state.continuation_hashes.push(hash);const release=await service.cache.lease();let feed;try{feed=await catalog.next(state);}finally{await release().catch(()=>{});}
      state.pending=feed.videos.filter((video,index,all)=>!state.scanned.includes(video.id)&&all.findIndex(item=>item.id===video.id)===index);
      for(const video of state.pending)if(!state.discovered_ids.includes(video.id))state.discovered_ids.push(video.id);
      state.continuation=feed.continuation;state.discovery_pages++;pages++;
    }
    const count=Math.min(10,args.limit-state.succeeded.length,state.scan_limit-state.scanned.length);
    const picked=state.pending.slice(0,count),ids=picked.map(video=>video.id);
    let batch={markdown:'# Creator transcripts\n\nNo additional videos were processed in this page.',results:[],success_count:0,has_more:false,next_cursors:{},requested_count:0,unique_count:0,status:'partial'};
    if(ids.length)batch=await transcriptBatch(service,{videos:ids,delivery:args.delivery,...(args.lang?{lang:args.lang}: {})},owner,{now,budgetMs:Math.max(0,deadline-now())});
    const baseState=structuredClone(state);
    function buildResponse() {
      state=structuredClone(baseState);
      const retry=[];
      for(const result of batch.results){
        if(result.ok){state.scanned.push(result.video_id);state.succeeded.push(result.video_id);}
        else if(result.error?.code==='acquisition_pending'){retry.push(picked.find(video=>video.id===result.video_id));}
        else if(result.error?.retryable&&['service_busy','extraction_in_progress','timeout','network_failure','storage_unavailable','rate_limiting'].includes(result.error.code)&&(state.retry_counts[result.video_id]??0)<1){state.retry_counts[result.video_id]=(state.retry_counts[result.video_id]??0)+1;retry.push(picked.find(video=>video.id===result.video_id));}
        else{state.scanned.push(result.video_id);if(result.error?.retryable||['timeout','network_failure','rate_limiting','parsing_failure','storage_unavailable','service_busy','extraction_in_progress','response_too_large'].includes(result.error?.code))state.unresolved.push({video_id:result.video_id,code:result.error.code});}
      }
      state.pending=[...retry,...state.pending.slice(picked.length)];state.exhausted=!state.pending.length&&!state.continuation;
      state.succeeded.sort((a,b)=>state.discovered_ids.indexOf(a)-state.discovered_ids.indexOf(b));
      const discoveryLimited=!state.pending.length&&state.continuation&&state.discovery_pages>=state.discovery_page_limit;
      const selectionMore=state.succeeded.length<args.limit&&!state.exhausted&&!discoveryLimited&&state.scanned.length<state.scan_limit;
      const response={...batch,creator:{url:args.url,channel_id:state.channel_id,title:state.channel_title,order:'verified_latest_first',content:'Videos uploads; Shorts/Streams are not included'},
        requested_limit:args.limit,collected_count:state.succeeded.length,collected_video_ids:state.succeeded,scanned_count:state.scanned.length,scan_limit:state.scan_limit,
        successes_this_page:state.succeeded.length-before,selection_complete:!selectionMore,has_more_creator:selectionMore,creator_cursor:selectionMore?cursor(row.id,row.revision+1):null,
        selection_status:state.succeeded.length>=args.limit?(state.unresolved.length?'fulfilled_with_retrieval_gaps':'fulfilled'):selectionMore?'in_progress':'partial',
        unresolved_retrievals:state.unresolved,partial_reason:selectionMore?null:state.succeeded.length<args.limit?(state.exhausted?'creator_feed_exhausted':discoveryLimited?'discovery_page_bound_exhausted':'bounded_scan_exhausted'):state.unresolved.length?'unresolved_newer_uploads':null,
        replayed:false,manifest_freshness_ms:MANIFEST_TTL,caption_pagination_tool:'get_transcripts',caption_pagination_instructions:'Finish only successful videos with has_more using videos + next_cursors. Continue creator selection separately using creator_cursor.'};
      return response;
    }
    const response=buildResponse();
    await store.commit(row,token,state,response);return response;
  }finally{await store.release(row.id,token).catch(()=>{});}
}
