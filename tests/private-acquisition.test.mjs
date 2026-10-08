import {SOFTWARE_VERSION} from "../lib/version.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { localDb } from './sqlite-adapter.mjs';
import { AcquisitionQueue, validateCaptionResult } from '../lib/acquisition-queue.mjs';
import { handleAcquisition } from '../lib/acquisition-handler.mjs';
import { PrivateWorker, signedRequest, createWorkerIdentity } from '../scripts/private-acquisition-worker.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { TranscriptError } from '../lib/transcript-errors.mjs';
import { transcriptBatch } from '../lib/transcript-batch.mjs';
import { creatorTranscripts } from '../lib/creator-transcripts.mjs';
import { handleMcp } from '../lib/mcp-handler.mjs';
import { retryAfterSeconds } from '../lib/youtube-extractor.mjs';
const ids=Array.from({length:10},(_,i)=>`abcdefghij${i}`),base='https://synthetic.example',clock=1700000000000;
const fixture=(id=ids[0])=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'.en',language:'en',caption_type:'manual',extractor_version:'synthetic-test-fixture',extraction_method:'innertube/timedtext/srv3',retrieved_at:new Date(clock).toISOString(),title:'Synthetic title',languages:[{language:'en',track_id:'.en',name:'English',caption_type:'manual'}],segments:[{text:'Synthetic faithful captions.',start:0,duration:1,duration_source:'upstream'}]});
function harness(){let time=clock;const db=localDb(),queue=new AcquisitionQueue(db,{now:()=>time,sleep:async ms=>{time+=ms;}}),keys=generateKeyPairSync('ed25519');
  db.setClock(()=>time);const env={DB:db,ACQUISITION_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')};
  return {db,queue,env,privateKey:keys.privateKey,now:()=>time,advance:ms=>{time+=ms;},request:(route,input={},opts={})=>signedRequest(keys.privateKey,route,input,{base,now:time,...opts}),fetch:request=>handleAcquisition(request,env,{now:()=>time,queueFactory:()=>queue})};
}
test('worker auth rejects missing signatures, timestamp drift, changed body/path, cross-origin and nonce replay',async()=>{
  const h=harness(),route='/api/acquisition/claim';
  assert.equal((await h.fetch(new Request(base+route,{method:'POST',body:'{}'}))).status,401);
  assert.equal((await h.fetch(h.request(route,{}, {now:clock-120001}))).status,401);
  const changed=h.request(route);assert.equal((await h.fetch(new Request(changed.url,{method:'POST',headers:changed.headers,body:'{"x":1}'}))).status,401);
  const pathChanged=h.request(route);assert.equal((await h.fetch(new Request(base+'/api/acquisition/submit',{method:'POST',headers:pathChanged.headers,body:'{}'}))).status,401);
  const cross=h.request(route);cross.headers.set('origin','https://wrong.example');assert.equal((await h.fetch(cross)).status,403);
  const same=h.request(route),replay=same.clone();assert.equal((await h.fetch(same)).status,200);assert.equal((await h.fetch(replay)).status,401);
});
test('worker route is disabled without a registered public key; arbitrary routes/methods are rejected',async()=>{
  const h=harness();assert.equal((await handleAcquisition(h.request('/api/acquisition/claim'),{DB:h.db})).status,503);
  assert.equal((await h.fetch(h.request('/mcp'))).status,400);assert.equal((await h.fetch(new Request(base+'/api/acquisition/claim'))).status,400);
});
test('synthetic worker identity recovers without reminting; mismatched/missing private key fails closed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'youtube-worker-identity-test-'));
  try{const first=await createWorkerIdentity(root),again=await createWorkerIdentity(root);assert.deepEqual(first,again);
    await rm(path.join(root,'public-key.json'));assert.deepEqual(await createWorkerIdentity(root),first);
    await writeFile(path.join(root,'public-key.json'),JSON.stringify({public_key:'0'.repeat(64)}));await assert.rejects(createWorkerIdentity(root),/identity mismatch/);
    await rm(path.join(root,'private-key.pem'));await assert.rejects(createWorkerIdentity(root),/without its private key/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('job enqueue normalizes language, is idempotent and isolates owner namespaces',async()=>{
  const h=harness(),a=await h.queue.enqueue('a',ids[0],'EN'),b=await h.queue.enqueue('a',ids[0],'en'),c=await h.queue.enqueue('b',ids[0],'en');
  assert.equal(a,b);assert.notEqual(a,c);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM acquisition_jobs').get().n,2);
});
test('at most two global worker leases; each video claim is fenced; expiry permits recovery',async()=>{
  const h=harness();for(const id of ids.slice(0,3))await h.queue.enqueue('owner',id);
  const a=await h.queue.claim('worker'),b=await h.queue.claim('worker');assert.ok(a);assert.ok(b);assert.notEqual(a.video_id,b.video_id);assert.equal(await h.queue.claim('worker'),null);
  h.advance(55001);await assert.rejects(h.queue.submit('worker',{job_id:a.job_id,token:a.token,transcript:fixture(a.video_id)}),e=>e.code==='claim_expired');
  const fresh=await h.queue.claim('worker');assert.ok(fresh);assert.notEqual(fresh.token,a.token);
  await assert.rejects(h.queue.submit('other-worker',{job_id:fresh.job_id,token:fresh.token,transcript:fixture(fresh.video_id)}),e=>e.code==='forbidden');
});
test('successful job submission is durable, owner isolated, idempotent and never reclaims/refetches',async()=>{
  const h=harness();await h.queue.enqueue('owner',ids[0]);const job=await h.queue.claim('worker'),input={job_id:job.job_id,token:job.token,transcript:fixture()};
  const first=await h.queue.submit('worker',input),repeat=await h.queue.submit('worker',input);assert.equal(first.snapshot_id,repeat.snapshot_id);assert.equal(repeat.replayed,true);
  assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,1);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM extractor_leases').get().n,0);
  assert.equal(await h.queue.claim('worker'),null);h.advance(10*365*24*60*60*1000);
  assert.equal((await h.queue.request('owner',ids[0],'en',{budgetMs:0})).id,first.snapshot_id);assert.equal(await h.queue.cache.latest('other',ids[0]),null);
});
test('denial is terminal and replayable; non-denial acquisition retries are delayed and capped at three',async()=>{
  for(const code of ['access_restriction','network_failure']){
    const h=harness();await h.queue.enqueue('owner',ids[0]);
    for(let i=0;i<(code==='access_restriction'?1:3);i++){
      const job=await h.queue.claim('worker');assert.ok(job);const input={job_id:job.job_id,token:job.token,failure_code:code};
      const result=await h.queue.submit('worker',input);assert.equal((await h.queue.submit('worker',input)).replayed,true);
      assert.equal(result.status,code==='access_restriction'||i===2?'failed':'queued');assert.equal(await h.queue.claim('worker'),null);h.advance(30001);
    }
    assert.equal(await h.queue.claim('worker'),null);await assert.rejects(h.queue.request('owner',ids[0],undefined,{budgetMs:0}),e=>e.code===code&&!e.retryable);
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,0);
  }
});
test('caption validation rejects wrong video/language, malformed timing, unsupported provenance and unsafe metadata; preserves raw repetitions',()=>{
  const raw=fixture();raw.segments.push({...raw.segments[0]});assert.deepEqual(validateCaptionResult(raw,ids[0]).segments,raw.segments);
  for(const changed of [{video_id:ids[1]},{source_url:'https://evil.example'},{selected_language:'fr'},{segments:[{...raw.segments[0],start:-1}]},{segments:[{...raw.segments[0],duration_source:'invented'}]},{extraction_method:'made-up'},{author:{password:'synthetic'}}])assert.throws(()=>validateCaptionResult({...raw,...changed},ids[0],'en'));
  assert.equal(validateCaptionResult({...raw,untrusted_extra:'discard'},ids[0]).untrusted_extra,undefined);
});
test('invalid submissions and expired tokens cannot contaminate another job or snapshot',async()=>{
  const h=harness();for(const id of ids.slice(0,2))await h.queue.enqueue('owner',id);const a=await h.queue.claim('worker'),b=await h.queue.claim('worker');
  await assert.rejects(h.queue.submit('worker',{job_id:b.job_id,token:a.token,transcript:fixture(b.video_id)}),e=>e.code==='claim_expired');
  await assert.rejects(h.queue.submit('worker',{job_id:a.job_id,token:a.token,transcript:fixture(b.video_id)}),e=>e.code==='invalid_input');
  const good=await h.queue.submit('worker',{job_id:b.job_id,token:b.token,transcript:fixture(b.video_id)});assert.ok(good.snapshot_id);assert.equal(await h.queue.cache.latest('owner',a.video_id),null);
});
test('private acquisition queues before any Sites extraction; cache hits bypass queue and extractor',async()=>{
  const h=harness(),service=new TranscriptService(h.db,{acquirer:h.queue,extractorFactory:()=>assert.fail('Sites extractor must not run')});
  await assert.rejects(service.call('get_transcript',{url:ids[0]},'owner',{budgetMs:0}),e=>e.code==='acquisition_pending');
  const job=await h.queue.claim('worker');await h.queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:fixture()});
  service.acquirer={request:()=>assert.fail('cache must bypass acquisition')};assert.equal((await service.call('get_transcript',{url:ids[0]},'owner')).cache_status,'hit');
});
test('worker persists before upload and crash/reclaim/language alias reuses the exact original snapshot',async()=>{
  const h=harness(),root=await mkdtemp(path.join(tmpdir(),'youtube-worker-test-'));let fetched=0;const worker=new PrivateWorker({root,privateKey:h.privateKey,fetchImpl:h.fetch,now:h.now,base,extractorFactory:()=>({transcript:async id=>{fetched++;return fixture(id);}})});
  try{await h.queue.enqueue('owner',ids[0]);const job=await h.queue.claim('worker');const first=await worker.localResult(job);assert.equal(first.local_cache,'miss');
    const directory=path.join(root,'snapshots',job.owner_namespace),record=JSON.parse(await readFile(path.join(directory,(await readdir(directory))[0]),'utf8'));assert.equal(record.segment_sha256,createHash('sha256').update(JSON.stringify(first.transcript.segments)).digest('hex'));
    const restarted=new PrivateWorker({root,extractorFactory:()=>assert.fail('recovery must not fetch again')});const again=await restarted.localResult({...job,lang:'en'});assert.equal(again.local_cache,'hit');assert.deepEqual(again.transcript.segments,first.transcript.segments);assert.equal(fetched,1);
    await writeFile(path.join(directory,(await readdir(directory))[0]),'{"bad":true}');await assert.rejects(restarted.localResult(job),/local_snapshot_corrupt/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('ten queued IDs/URLs/share links traverse signed claim, acquisition, upload, clean MCP and immutable repeat cache',async()=>{
  const h=harness(),root=await mkdtemp(path.join(tmpdir(),'youtube-worker-batch-test-'));let fetched=0;
  const worker=new PrivateWorker({root,privateKey:h.privateKey,fetchImpl:h.fetch,now:h.now,base,extractorFactory:()=>({transcript:async id=>{fetched++;return fixture(id);}})});
  const service=new TranscriptService(h.db,{acquirer:{request:(owner,id,lang)=>h.queue.request(owner,id,lang,{budgetMs:0})},extractorFactory:()=>assert.fail('no Sites acquisition')});
  const videos=ids.map((id,i)=>i%3===0?id:i%3===1?`https://youtu.be/${id}?si=synthetic`:`https://www.youtube.com/watch?v=${id}`);
  try{const pending=await transcriptBatch(service,{videos},'service:mcp');assert.equal(pending.success_count,0);assert.ok(pending.results.every(r=>r.error.code==='acquisition_pending'));
    for(let i=0;i<10;i++)assert.equal((await worker.once()).status,'complete');
    const rpc=(name,args)=>new Request(base+'/mcp',{method:'POST',headers:{authorization:('Bearer '+'fixture'.repeat(8)),'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:name,params:args})});
    const env={...h.env,MCP_AUTH_KEY:'fixture'.repeat(8),ACQUISITION_MODE:'private_mac'};
    const init=await (await handleMcp(rpc('initialize',{protocolVersion:'2025-03-26'}),env)).json();assert.equal(init.result.serverInfo.version,SOFTWARE_VERSION);
    const list=await (await handleMcp(rpc('tools/list',{}),env)).json();assert.equal(list.result.tools.length,10);
    const call=async()=> (await (await handleMcp(rpc('tools/call',{name:'get_transcripts',arguments:{videos}}),env,{serviceFactory:()=>service})).json()).result;
    const first=await call(),again=await call();assert.equal(first.structuredContent.success_count,10);assert.equal(again.structuredContent.success_count,10);assert.equal(fetched,10);assert.deepEqual(first.structuredContent.results.map(r=>r.snapshot_id),again.structuredContent.results.map(r=>r.snapshot_id));assert.match(first.content[0].text,/Synthetic faithful captions/);assert.doesNotMatch(first.content[0].text,/00:00:00/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('creator pending acquisitions neither advance bounded scan nor abandon newer uploads',async()=>{
  const h=harness();let ready=false;const service={cache:h.queue.cache,call:async(_name,args)=>{if(!ready)throw new TranscriptError('acquisition_pending','Synthetic pending',{},true);return {snapshot_id:args.url,selected_language:'en',caption_type:'manual',page_index:0,page_count:1,segments:fixture(args.url).segments,has_more:false,next_cursor:null,cache_status:'hit',segment_count:1,returned_segment_count:1};}};
  const catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic creator',context:{},videos:ids.map(id=>({id})),continuation:null})}),input={creator_url:'https://www.youtube.com/@Synthetic',limit:2};
  let response=await creatorTranscripts(service,h.db,input,'owner',{catalogFactory,now:h.now});
  for(let i=0;i<3;i++){assert.equal(response.scanned_count,0);assert.equal(response.collected_count,0);assert.equal(response.has_more_creator,true);response=await creatorTranscripts(service,h.db,{...input,creator_cursor:response.creator_cursor},'owner',{catalogFactory,now:h.now});}
  ready=true;response=await creatorTranscripts(service,h.db,{...input,creator_cursor:response.creator_cursor},'owner',{catalogFactory,now:h.now});assert.equal(response.scanned_count,2);assert.equal(response.collected_count,2);assert.equal(response.selection_status,'fulfilled');assert.deepEqual(response.collected_video_ids,ids.slice(0,2));
});
test('additive acquisition migration preserves deployed snapshot and creator data',()=>{
  const db=new DatabaseSync(':memory:');for(const file of ['0000_typical_blink.sql','0001_faithful_dracula.sql','0002_cooing_tigra.sql'])db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  db.prepare('INSERT INTO transcript_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','owner',ids[0],'en','en','.en','legacy-version','legacy-key',1,0,1,1,'{}');
  const before=db.prepare('SELECT * FROM transcript_snapshots').get(),sql=readFileSync(new URL('../drizzle/0003_spotty_red_hulk.sql',import.meta.url),'utf8');
  for(const statement of sql.replace(/-->[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))assert.match(statement,/^CREATE (?:TABLE|INDEX) /i);
  db.exec(sql);assert.deepEqual(db.prepare('SELECT * FROM transcript_snapshots').get(),before);db.close();
});
test('R1: saved terminal denial survives lost upload, reclaim, restart and default/en alias without another extraction',async()=>{
  const h=harness(),root=await mkdtemp(path.join(tmpdir(),'youtube-denial-recovery-test-'));let calls=0;
  try{await h.queue.enqueue('owner',ids[0]);const first=await h.queue.claim('worker'),factory=()=>({transcript:async()=>{calls++;throw new TranscriptError('access_restriction','Synthetic denial');}});
    const worker=new PrivateWorker({root,now:h.now,extractorFactory:factory});await assert.rejects(worker.localResult(first),e=>e.code==='access_restriction');
    h.advance(55001);const second=await h.queue.claim('worker');assert.notEqual(second.token,first.token);
    const restarted=new PrivateWorker({root,now:h.now,extractorFactory:factory});await assert.rejects(restarted.localResult({...second,lang:'en'}),e=>e.code==='access_restriction');assert.equal(calls,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('R2: API authentication/access denial stops both scheduler loops; stale claims remain recoverable',async()=>{
  for(const status of [401,403]){
    const h=harness();let requests=0,extractions=0,sleeps=0;const receipts=[];
    const worker=new PrivateWorker({privateKey:h.privateKey,fetchImpl:async()=>{requests++;return new Response('{}',{status});},extractorFactory:()=>({transcript:()=>{extractions++;assert.fail();}}),sleep:async()=>{sleeps++;}});
    await worker.run({onReceipt:r=>receipts.push(r)});assert.equal(worker.stopped,true);assert.ok(requests<=2);assert.equal(extractions,0);assert.equal(sleeps,0);assert.equal(receipts.length,1);assert.equal(receipts[0].http_status,status);
    await assert.rejects(worker.api('/api/acquisition/claim',{}),e=>e.terminal);assert.ok(requests<=2);
  }
  const h=harness(),worker=new PrivateWorker({privateKey:h.privateKey,fetchImpl:async()=>new Response('{}',{status:409})});await assert.rejects(worker.api('/api/acquisition/claim',{}),/worker_http_409/);assert.equal(worker.stopped,false);
});
test('R3: simultaneous identical submissions commit one snapshot and return one stable receipt',async()=>{
  const h=harness();await h.queue.enqueue('owner',ids[0]);const job=await h.queue.claim('worker'),payload={job_id:job.job_id,token:job.token,transcript:fixture()};
  const [a,b]=await Promise.all([h.queue.submit('worker',payload),h.queue.submit('worker',payload)]);assert.equal(a.snapshot_id,b.snapshot_id);assert.ok(a.replayed||b.replayed);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,1);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_chunks').get().n,1);
});
test('R3: execution-time expiry/replaced claim and transaction failure leave no new snapshot/chunk/receipt',async()=>{
  for(const fault of ['expiry','replace','transaction']){
    const h=harness();await h.queue.enqueue('owner',ids[0]);const job=await h.queue.claim('worker'),original=h.db.batch.bind(h.db);let injected=false;
    h.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes('INSERT INTO transcript_snapshots'))){injected=true;if(fault==='expiry')h.advance(60000);else if(fault==='replace')h.db.sqlite.prepare('UPDATE transcript_claims SET token=?').run('replaced');else return original([...statements,{sql:'INSERT INTO table_that_does_not_exist VALUES (1)',args:[]}]);}return original(statements);};
    await assert.rejects(h.queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:fixture()}));assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,0);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_chunks').get().n,0);assert.equal(h.db.sqlite.prepare('SELECT status FROM acquisition_jobs').get().status,'leased');
  }
});
test('R4: numeric/date-derived Retry-After survives lost upload and restart; claims wait for the exact deadline',async()=>{
  for(const header of ['120',new Date(clock+3600000).toUTCString()]){const seconds=retryAfterSeconds(header,clock);
    const h=harness(),root=await mkdtemp(path.join(tmpdir(),'youtube-retry-after-test-'));let calls=0;
    try{await h.queue.enqueue('owner',ids[0]);const first=await h.queue.claim('worker'),factory=()=>({transcript:async()=>{calls++;throw new TranscriptError('rate_limiting','Synthetic hint',{retry_after_seconds:seconds},true);}});
      const worker=new PrivateWorker({root,now:h.now,extractorFactory:factory});await assert.rejects(worker.localResult(first),e=>e.code==='rate_limiting');h.advance(55001);
      const second=await h.queue.claim('worker'),restarted=new PrivateWorker({root,now:h.now,extractorFactory:factory});let saved;await assert.rejects(restarted.localResult(second),e=>{saved=e;return e.code==='rate_limiting';});assert.equal(calls,1);assert.equal(saved.details.retry_not_before_ms,clock+seconds*1000);
      await h.queue.submit('worker',{job_id:second.job_id,token:second.token,failure_code:'rate_limiting',retry_not_before_ms:saved.details.retry_not_before_ms});h.advance(seconds*1000-55002);assert.equal(await h.queue.claim('worker'),null);h.advance(2);assert.ok(await h.queue.claim('worker'));
      for(const bad of [NaN,Infinity,-1,'3600',1.5])await assert.rejects(h.queue.submit('worker',{job_id:second.job_id,token:second.token,failure_code:'rate_limiting',retry_not_before_ms:bad}),e=>e.code==='invalid_input');
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('R5: only a later authenticated request resets one transient cycle after cooldown; denials never reset',async()=>{
  const h=harness();await h.queue.enqueue('owner',ids[0]);for(let i=0;i<3;i++){const job=await h.queue.claim('worker');await h.queue.submit('worker',{job_id:job.job_id,token:job.token,failure_code:'network_failure'});h.advance(30001);}
  h.advance(15*60*1000);assert.equal(await h.queue.claim('worker'),null);await Promise.all([h.queue.enqueue('owner',ids[0]),h.queue.enqueue('owner',ids[0])]);assert.equal(h.db.sqlite.prepare('SELECT attempts FROM acquisition_jobs').get().attempts,0);assert.ok(await h.queue.claim('worker'));
  const d=harness();await d.queue.enqueue('owner',ids[0]);const denied=await d.queue.claim('worker');await d.queue.submit('worker',{job_id:denied.job_id,token:denied.token,failure_code:'access_restriction'});d.advance(10*365*24*60*60*1000);await d.queue.enqueue('owner',ids[0]);assert.equal(await d.queue.claim('worker'),null);
});
test('R6: offline/backlogged creator queues all ten selected uploads and never scans/discards pending videos',async()=>{
  const h=harness(),service=new TranscriptService(h.db,{acquirer:h.queue}),catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic creator',context:{},videos:ids.map(id=>({id})),continuation:null})}),input={creator_url:'https://www.youtube.com/@Synthetic'};
  let response=await creatorTranscripts(service,h.db,input,'owner',{catalogFactory,now:h.now});assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM acquisition_jobs').get().n,10);assert.equal(response.scanned_count,0);
  response=await creatorTranscripts(service,h.db,{...input,creator_cursor:response.creator_cursor},'owner',{catalogFactory,now:h.now});assert.equal(response.scanned_count,0);assert.equal(response.selection_complete,false);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM acquisition_jobs').get().n,10);
});
test('R7: exhausted transient newer upload remains a cumulative gap even when an older transcript fills the limit',async()=>{
  for(const code of ['network_failure','timeout','rate_limiting']){
    const h=harness(),service={cache:h.queue.cache,call:async(_name,args)=>{if(args.url===ids[0])throw new TranscriptError(code,'Synthetic exhausted cycle',{},false);return {snapshot_id:args.url,selected_language:'en',caption_type:'manual',page_index:0,page_count:1,segments:fixture(args.url).segments,has_more:false,next_cursor:null,cache_status:'hit',segment_count:1,returned_segment_count:1};}},catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic creator',context:{},videos:ids.map(id=>({id})),continuation:null})}),input={creator_url:'https://www.youtube.com/@Synthetic',limit:1};
    let result=await creatorTranscripts(service,h.db,input,'owner',{catalogFactory,now:h.now});result=await creatorTranscripts(service,h.db,{...input,creator_cursor:result.creator_cursor},'owner',{catalogFactory,now:h.now});assert.equal(result.selection_status,'fulfilled_with_retrieval_gaps');assert.equal(result.partial_reason,'unresolved_newer_uploads');assert.deepEqual(result.unresolved_retrievals,[{video_id:ids[0],code}]);
  }
});
test('R8: signature expiry during body read rejects before nonce/job mutation or dispatch',async()=>{
  const h=harness(),signed=h.request('/api/acquisition/claim');let reads=0,claims=0;const request={url:signed.url,method:signed.method,headers:signed.headers,body:{getReader:()=>({read:async()=>reads++?{done:true}:(h.advance(600000),{done:false,value:new TextEncoder().encode('{}')}),cancel:async()=>{}})}};
  const response=await handleAcquisition(request,h.env,{now:h.now,queueFactory:()=>({claim:async()=>{claims++;return null;}})});assert.equal(response.status,401);assert.equal(claims,0);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM acquisition_nonces').get().n,0);
});
test('R9: blocked same-video language alias does not stall a later unrelated video',async()=>{
  const h=harness();await h.queue.enqueue('owner',ids[0],'en');h.advance(1);await h.queue.enqueue('owner',ids[0],'fr');h.advance(1);await h.queue.enqueue('owner',ids[1],'en');const first=await h.queue.claim('worker'),second=await h.queue.claim('worker');assert.equal(first.video_id,ids[0]);assert.equal(second.video_id,ids[1]);assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM extractor_leases').get().n,2);
});

test('independent R3 review: expiry after receipt CAS rolls back every caption mutation and retains claim tokens',async()=>{
  for(const fault of ['lease','authorization']){
    const h=harness();await h.queue.enqueue('owner',ids[0]);const job=await h.queue.claim('worker');
    const original=h.db.batch.bind(h.db);let injected=false;
    h.db.batch=async statements=>{
      if(!injected&&statements.some(s=>s.sql.includes('INSERT INTO transcript_snapshots'))){
        injected=true;
        // SQLite evaluates this hook within the transaction, after the winning
        // receipt CAS and before the snapshot insert. The next expiry fence
        // must roll the receipt and chunks back together.
        h.db.sqlite.function('review_expire',()=>{h.advance(fault==='lease'?60000:2000);return 1;});
        return original([statements[0],{sql:'SELECT review_expire()',args:[]},...statements.slice(1)]);
      }
      return original(statements);
    };
    await assert.rejects(h.queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:fixture()},{authValidUntil: fault==='authorization'?h.now()+1000:Number.MAX_SAFE_INTEGER}));
    assert.equal(injected,true);
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,0);
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_chunks').get().n,0);
    assert.equal(h.db.sqlite.prepare('SELECT status FROM acquisition_jobs').get().status,'leased');
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_claims').get().n,1);
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) n FROM extractor_leases').get().n,1);
  }
});
