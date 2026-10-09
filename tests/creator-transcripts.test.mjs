import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorArguments, creatorTranscripts } from '../lib/creator-transcripts.mjs';
import { TranscriptError } from '../lib/transcript-errors.mjs';
import { localDb } from './sqlite-adapter.mjs';
import { SnapshotCache } from '../lib/snapshot-cache.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleMcp } from '../lib/mcp-handler.mjs';
const url='https://www.youtube.com/@SkillLeapAI',channel='UCwSozl89jl2zUDzQ4jGJD3g';
const ids=Array.from({length:100},(_,i)=>`video_${String(i).padStart(5,'0')}`);
const result=id=>({video_id:id,title:'Synthetic upload',selected_language:'en',caption_type:'manual',snapshot_id:crypto.randomUUID(),page_index:0,page_count:1,returned_segment_count:1,segment_count:1,has_more:false,next_cursor:null,cache_status:'hit',retention:'durable',segments:[{text:'Synthetic speech without cue timestamps.',start:0,duration:1}],extractor_version:'synthetic',extraction_method:'synthetic'});
function harness({denied=[],limitVideos=40,transient=[]}={}) {
  const db=localDb(),calls=[],counts=new Map();let discoveries=0;
  const catalogFactory=()=>({start:async()=>{discoveries++;return {channel_id:channel,channel_title:'Synthetic creator',context:{client:{clientName:'WEB',clientVersion:'2.1'}},videos:ids.slice(0,Math.min(limitVideos,30)).map(id=>({id})),continuation:limitVideos>30?'page-two':null};},next:async()=>({videos:ids.slice(30,limitVideos).map(id=>({id})),continuation:null})});
  const service={cache:new SnapshotCache(db),call:async(_name,args)=>{calls.push(args.url);counts.set(args.url,(counts.get(args.url)??0)+1);if(denied.includes(args.url))throw new TranscriptError('access_restriction','Synthetic denial');if(transient.includes(args.url)&&counts.get(args.url)===1)throw new TranscriptError('service_busy','Synthetic contention',{},true);return result(args.url);}};
  return {db,service,catalogFactory,calls,discoveries:()=>discoveries};
}
const options=h=>({catalogFactory:h.catalogFactory});
test('creator: default 10, bounded custom limit, creator URL and cursor input validation',()=>{
  assert.equal(creatorArguments({creator_url:url}).limit,10);
  assert.equal(creatorArguments({creator_url:url,limit:25}).limit,25);
  for(const args of [{creator_url:url,limit:0},{creator_url:url,limit:101},{creator_url:url,limit:1.5},{creator_url:'https://evil.example/'},{creator_url:url,creator_cursor:42},{creator_url:url,extra:true}])assert.throws(()=>creatorArguments(args));
});
test('creator: newer denied uploads are not retried; older originals fill 10 in order',async()=>{
  const h=harness({denied:ids.slice(0,2)});
  const first=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));
  assert.equal(first.collected_count,8);assert.equal(first.has_more_creator,true);assert.equal(first.creator.order,'verified_latest_first');assert(!first.markdown.includes('00:00'));
  const last=await creatorTranscripts(h.service,h.db,{creator_url:url,creator_cursor:first.creator_cursor},'owner',options(h));
  assert.equal(last.collected_count,10);assert.equal(last.selection_status,'fulfilled');assert.equal(last.has_more_creator,false);assert.equal(last.scanned_count,12);
  assert.deepEqual(last.collected_video_ids,ids.slice(2,12));assert.equal(h.calls.filter(id=>id===ids[0]).length,1);
});
test('creator: continuation and initial response replay are durable and never repeat tool fetches',async()=>{
  const h=harness({denied:ids.slice(0,2)}),first=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));
  const input={creator_url:url,creator_cursor:first.creator_cursor};const last=await creatorTranscripts(h.service,h.db,input,'owner',options(h)),calls=h.calls.length;
  const replay=await creatorTranscripts(h.service,h.db,input,'owner',options(h));assert.equal(replay.replayed,true);assert.deepEqual(replay.collected_video_ids,last.collected_video_ids);assert.equal(h.calls.length,calls);
  const initialReplay=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));assert.equal(initialReplay.replayed,true);assert.equal(h.discoveries(),1);assert.equal(h.calls.length,calls);
});
test('creator: 25-result custom limit proceeds in pages of at most 10 attempts',async()=>{
  const h=harness();let response=await creatorTranscripts(h.service,h.db,{creator_url:url,limit:25},'owner',options(h));
  while(response.has_more_creator){assert(response.requested_count<=10);response=await creatorTranscripts(h.service,h.db,{creator_url:url,limit:25,creator_cursor:response.creator_cursor},'owner',options(h));}
  assert.equal(response.collected_count,25);assert.equal(h.calls.length,25);assert.equal(h.discoveries(),1);
});
test('creator: bounded scan and feed exhaustion yield explicit partial results',async()=>{
  const h=harness({denied:ids});let response=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));
  while(response.has_more_creator)response=await creatorTranscripts(h.service,h.db,{creator_url:url,creator_cursor:response.creator_cursor},'owner',options(h));
  assert.equal(response.scanned_count,30);assert.equal(h.calls.length,30);assert.equal(response.partial_reason,'bounded_scan_exhausted');assert.equal(response.collected_count,0);
  const small=harness({limitVideos:3});const exhausted=await creatorTranscripts(small.service,small.db,{creator_url:url},'owner',options(small));assert.equal(exhausted.partial_reason,'creator_feed_exhausted');assert.equal(exhausted.collected_count,3);
});
test('creator: cursor owner/limit/language boundaries fail before source calls',async()=>{
  const h=harness({denied:ids.slice(0,2)}),first=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));const count=h.calls.length;
  for(const [owner,args] of [['other',{creator_url:url,creator_cursor:first.creator_cursor}],['owner',{creator_url:url,limit:20,creator_cursor:first.creator_cursor}],['owner',{creator_url:url,lang:'fr',creator_cursor:first.creator_cursor}]])await assert.rejects(creatorTranscripts(h.service,h.db,args,owner,options(h)),e=>e.code==='invalid_cursor');
  assert.equal(h.calls.length,count);
});
test('creator: transient non-denial contention is deferred once, not discarded as absent captions',async()=>{
  const h=harness({transient:[ids[0]]});const first=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));assert.equal(first.collected_count,9);
  const last=await creatorTranscripts(h.service,h.db,{creator_url:url,creator_cursor:first.creator_cursor},'owner',options(h));assert.equal(last.collected_count,10);assert.equal(h.calls.filter(id=>id===ids[0]).length,2);assert.deepEqual(last.collected_video_ids,ids.slice(0,10));
});
test('creator: older successful captions never hide an unresolved newer retrieval',async()=>{
  const h=harness(),original=h.service.call;h.service.call=async(...args)=>{if(args[1].url===ids[0])throw new TranscriptError('network_failure','Synthetic temporary failure',{},true);return original(...args);};
  let response=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));
  while(response.has_more_creator)response=await creatorTranscripts(h.service,h.db,{creator_url:url,creator_cursor:response.creator_cursor},'owner',options(h));
  assert.equal(response.collected_count,10);assert.equal(response.selection_status,'fulfilled_with_retrieval_gaps');assert.equal(response.partial_reason,'unresolved_newer_uploads');assert.deepEqual(response.unresolved_retrievals,[{video_id:ids[0],code:'network_failure'}]);
});
test('creator: empty discovery pages terminate at a hard page bound, even with unique continuation tokens',async()=>{
  const h=harness();let n=0;const catalogFactory=()=>({start:async()=>({channel_id:channel,channel_title:'Synthetic creator',context:{},videos:[],continuation:'page-0'}),next:async()=>({videos:[],continuation:`page-${++n}`})});
  let response=await creatorTranscripts(h.service,h.db,{creator_url:url,limit:1},'owner',{catalogFactory});
  while(response.has_more_creator)response=await creatorTranscripts(h.service,h.db,{creator_url:url,limit:1,creator_cursor:response.creator_cursor},'owner',{catalogFactory});
  assert.equal(response.partial_reason,'discovery_page_bound_exhausted');assert.equal(n,2);assert.equal(h.calls.length,0);
});
test('creator: concurrent initialization performs one discovery and leaves no orphan claim',async()=>{
  const h=harness();let started,finish;const running=new Promise(resolve=>started=resolve),pause=new Promise(resolve=>finish=resolve);
  const catalogFactory=()=>({start:async()=>{started();await pause;return {channel_id:channel,channel_title:'Synthetic creator',context:{},videos:ids.slice(0,10).map(id=>({id})),continuation:null};}});
  const first=creatorTranscripts(h.service,h.db,{creator_url:url},'owner',{catalogFactory});await running;
  await assert.rejects(creatorTranscripts(h.service,h.db,{creator_url:url},'owner',{catalogFactory}),e=>e.code==='extraction_in_progress');finish();await first;
  assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM creator_jobs').get().n,1);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
});
test('creator migration: only workflow tables/index are added; legacy transcripts are untouched',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const path of ['0000_typical_blink.sql','0001_faithful_dracula.sql'])db.exec(readFileSync(new URL('../drizzle/'+path,import.meta.url),'utf8'));
  db.prepare('INSERT INTO transcript_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy','owner',ids[0],'en','en','.en','legacy-version','legacy-key',1,0,1,1,'{}');db.prepare('INSERT INTO transcript_chunks VALUES (?, ?, ?, ?)').run('legacy',0,0,'[]');
  const before=db.prepare('SELECT * FROM transcript_snapshots').get(),migration=readFileSync(new URL('../drizzle/0002_cooing_tigra.sql',import.meta.url),'utf8');
  for(const statement of migration.replace(/^-->[^\n]*$/gm,'').split(';').map(value=>value.trim()).filter(Boolean))assert.match(statement,/^CREATE (?:TABLE|INDEX) /i);
  db.exec(migration);
  assert.deepEqual(db.prepare('SELECT * FROM transcript_snapshots').get(),before);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
});
test('MCP: unauthenticated creator discovery is denied before catalog/network access',async()=>{
  let constructed=0;const request=new Request('https://private.example/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_creator_transcripts',arguments:{creator_url:url}}})});
  const response=await handleMcp(request,{OWNER_EMAIL:'owner@example.test',MCP_AUTH_KEY:'fixture'.repeat(8)},{serviceFactory:()=>{constructed++;throw new Error('must not construct');}});assert.equal(response.status,401);assert.equal(constructed,0);
});
test('creator: simultaneous identical cursor cannot overwrite workflow or repeat extraction',async()=>{
  const h=harness({denied:ids.slice(0,2)}),first=await creatorTranscripts(h.service,h.db,{creator_url:url},'owner',options(h));
  let started,finish;const running=new Promise(resolve=>started=resolve),pause=new Promise(resolve=>finish=resolve);const original=h.service.call;
  h.service.call=async(...args)=>{started();await pause;return original(...args);};const input={creator_url:url,creator_cursor:first.creator_cursor};
  const pending=creatorTranscripts(h.service,h.db,input,'owner',options(h));await running;
  await assert.rejects(creatorTranscripts(h.service,h.db,input,'owner',options(h)),e=>e.code==='extraction_in_progress');finish();await pending;
  assert.equal(h.calls.length,12);
});
test('creator: expired writer cannot return an unsaved response after a replacement commits',async()=>{
  const db=localDb();let time=0,attempts=0,started,finish;db.setClock(()=>time);
  const running=new Promise(resolve=>started=resolve),pause=new Promise(resolve=>finish=resolve);
  const service={cache:new SnapshotCache(db,{now:()=>time}),call:async()=>{
    const attempt=++attempts;if(attempt===1){started();await pause;}
    return {...result(ids[0]),snapshot_id:`synthetic-attempt-${attempt}`,segments:[{text:`Synthetic speech from attempt ${attempt}.`,start:0,duration:1}]};
  }};
  const catalogFactory=()=>({start:async()=>({channel_id:channel,channel_title:'Synthetic creator',context:{},videos:[{id:ids[0]}],continuation:null})});
  const options={now:()=>time,catalogFactory},input={creator_url:url,limit:1};
  const expired=creatorTranscripts(service,db,input,'owner',options);await running;
  time=120001;const winner=await creatorTranscripts(service,db,input,'owner',options);
  const rejected=assert.rejects(expired,error=>error.code==='extraction_in_progress');finish();await rejected;
  assert.equal(winner.results[0].snapshot_id,'synthetic-attempt-2');
  const saved=JSON.parse(db.sqlite.prepare('SELECT response_json FROM creator_job_pages WHERE revision = 0').get().response_json);
  assert.deepEqual(saved,winner);assert.equal(db.sqlite.prepare('SELECT revision FROM creator_jobs').get().revision,1);
  const replay=await creatorTranscripts(service,db,input,'owner',options);
  assert.deepEqual(replay,{...saved,replayed:true});assert.equal(attempts,2);
});
