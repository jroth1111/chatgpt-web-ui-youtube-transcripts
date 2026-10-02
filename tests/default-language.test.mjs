import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDefaultTrack, selectionProof, reusableDefault, DEFAULT_JOB_LANGUAGE } from '../lib/caption-default.mjs';
import { YouTubeExtractor } from '../lib/youtube-extractor.mjs';
import { SnapshotCache, digest } from '../lib/snapshot-cache.mjs';
import { AcquisitionQueue } from '../lib/acquisition-queue.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { creatorTranscripts } from '../lib/creator-transcripts.mjs';
import { PrivateWorker } from '../scripts/private-acquisition-worker.mjs';
import { localDb } from './sqlite-adapter.mjs';
const id='abcdefghij0',owner='owner';
const tracks=['ar','de','es','en','fr'].map(code=>({languageCode:code,kind:'asr',vssId:'a.'+code,baseUrl:`https://www.youtube.com/api/timedtext?v=${id}&lang=${code}`}));
const renderer=(code='en')=>({captionTracks:tracks,defaultAudioTrackIndex:17,audioTracks:Array.from({length:18},(_,i)=>i===17?{audioTrackId:code+'-US.4',defaultCaptionTrackIndex:tracks.findIndex(t=>t.languageCode===code),captionTrackIndices:tracks.map((_,i)=>i)}:{audioTrackId:'ar.0'})});
const languages=tracks.map(t=>({language:t.languageCode,track_id:t.vssId,name:t.languageCode,caption_type:'auto_generated'}));
const fixture=(code='en',opts={})=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:code,track_id:'a.'+code,caption_type:'auto_generated',extractor_version:'legacy',extraction_method:'innertube/timedtext/json3',retrieved_at:'2026-10-01T00:00:00.000Z',languages,segments:Array.from({length:121},(_,i)=>({text:code+' synthetic cue '+i,start:i,duration:1,duration_source:'upstream'})),...opts});
function extractor(r,requests=[]){return new YouTubeExtractor({fetchImpl:async url=>{requests.push(String(url));if(String(url).includes('/player'))return Response.json({playabilityStatus:{status:'OK'},videoDetails:{},captions:{playerCaptionsTracklistRenderer:r}});if(String(url).includes('/watch'))return new Response('var ytInitialPlayerResponse = '+JSON.stringify({playabilityStatus:{status:'OK'},videoDetails:{},captions:{playerCaptionsTracklistRenderer:r}})+';');const u=new URL(url);return Response.json({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:u.searchParams.get('lang')+' synthetic speech'}]}]});}});}
test('default policy uses advertised audio/caption default amid alphabetically ordered ASR dubs, without English preference',async()=>{
  for(const code of ['en','fr','ar']){const r=renderer(code);assert.equal(resolveDefaultTrack(tracks,r).track.languageCode,code);const requests=[],result=await extractor(r,requests).transcript(id);assert.equal(result.selected_language,code);assert.equal(result.default_selection.policy,'upstream-default-v1');assert.ok(requests[1].includes('lang='+code));}
});
test('default policy supports caption-only default and unique audio-language matching; invalid/conflicting/ambiguous metadata cannot pick first',()=>{
  assert.equal(resolveDefaultTrack(tracks,{defaultCaptionTrackIndex:3}).track.languageCode,'en');
  assert.equal(resolveDefaultTrack(tracks,{defaultAudioTrackIndex:0,audioTracks:[{audioTrackId:'fr-FR.2'}]}).track.languageCode,'fr');
  for(const r of [{},{defaultCaptionTrackIndex:50},{defaultCaptionTrackIndex:'3'},{defaultAudioTrackIndex:50,audioTracks:[]},{...renderer(),defaultCaptionTrackIndex:0},{defaultAudioTrackIndex:0,audioTracks:[{audioTrackId:'xx.0'}]},{defaultAudioTrackIndex:0,audioTracks:[{audioTrackId:'en.0',defaultCaptionTrackIndex:0}]}])assert.equal(resolveDefaultTrack(tracks,r),null);
  const regional=[{languageCode:'en-US'},{languageCode:'en-GB'}];assert.equal(resolveDefaultTrack(regional,{defaultAudioTrackIndex:0,audioTracks:[{audioTrackId:'en.0'}]}),null);
  assert.equal(resolveDefaultTrack([tracks[4]],{}).track.languageCode,'fr');
});
test('explicit language stays exact and does not depend on missing/default metadata',async()=>{
  const r=renderer();for(const code of ['ar','fr']){const result=await extractor(r).transcript(id,code);assert.equal(result.selected_language,code);assert.equal(result.default_selection,undefined);}
  assert.equal((await extractor({captionTracks:tracks}).transcript(id,'ar')).selected_language,'ar');
  await assert.rejects(extractor(r).transcript(id,'en-US'),e=>e.code==='unavailable_language');
});
test('missing multi-language defaults fail before any caption request, rather than fabricating a default',async()=>{
  const requests=[];await assert.rejects(extractor({captionTracks:tracks},requests).transcript(id),e=>e.code==='parsing_failure'&&e.details.reason==='ambiguous_default_language');assert.equal(requests.length,2);assert.ok(requests.every(u=>!u.includes('/api/timedtext')));
});
test('old ambiguous default does not mask repair; mapping reuses same-track immutable snapshot/hash/pages and preserves Arabic and old cursors',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),arabic=await cache.write(owner,fixture('ar'),undefined),english=await cache.write(owner,fixture('en'),'en');
  const oldAr=await cache.page(owner,id,undefined,null,arabic),oldEn=await cache.page(owner,id,'en',null,english),before=db.sqlite.prepare('SELECT * FROM transcript_snapshots ORDER BY id').all();
  assert.equal(await cache.latest(owner,id),null);assert.equal((await cache.latest(owner,id,'ar')).id,arabic.id);
  const queue=new AcquisitionQueue(db);await queue.enqueue(owner,id);const job=await queue.claim('worker');
  const chosen=resolveDefaultTrack(tracks,renderer()),result=fixture('en',{default_selection:selectionProof(chosen,'a.en')});
  const receipt=await queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:result});assert.equal(receipt.snapshot_id,english.id);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM transcript_snapshots ORDER BY id').all(),before);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,2);
  const service=new TranscriptService(db,{acquirer:queue,extractorFactory:()=>assert.fail('must not use Sites extractor')});const repeat=await service.call('get_transcript',{url:id},owner);assert.equal(repeat.snapshot_id,english.id);assert.equal(repeat.segment_hash,oldEn.segment_hash);assert.equal(repeat.cache_status,'hit');
  const terminal=await service.call('get_transcript',{url:id,next_cursor:repeat.next_cursor},owner);assert.equal(terminal.has_more,false);assert.equal(terminal.snapshot_id,english.id);
  const arTerminal=await service.call('get_transcript',{url:id,next_cursor:oldAr.next_cursor},owner);assert.equal(arTerminal.snapshot_id,arabic.id);assert.equal(arTerminal.selected_language,'ar');assert.equal(arTerminal.segment_hash,oldAr.segment_hash);
});
test('old completed default job cannot pin ambiguous Arabic; prior explicit denials remain terminal across policy change',async()=>{
  for(const code of [null,'access_restriction']){const db=localDb(),queue=new AcquisitionQueue(db),now=Date.now(),key=await digest(JSON.stringify([owner,id,'__default__']));await db.prepare("INSERT INTO acquisition_jobs (id,owner_key,video_id,lang_key,status,created_ms,next_attempt_ms,attempts,lease_expires,failure_code) VALUES (?,?,?,'__default__',?,?,?,0,0,?)").bind(key,owner,id,code?'failed':'complete',now,now,code).run();const repaired=await queue.enqueue(owner,id);assert.notEqual(repaired,key);assert.equal(db.sqlite.prepare('SELECT lang_key FROM acquisition_jobs WHERE id=?').get(repaired).lang_key,DEFAULT_JOB_LANGUAGE);if(code)assert.equal(await queue.claim('worker'),null);else assert.ok(await queue.claim('worker'));}
});
test('single-language legacy cache, including explicit Arabic, remains reusable without re-fetch',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),record=fixture('ar',{languages:[languages[0]]}),row=await cache.write(owner,record,'ar');assert.equal(reusableDefault(record),true);assert.equal((await cache.latest(owner,id)).id,row.id);
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('legacy single track must not fetch')});assert.equal((await service.call('get_transcript',{url:id},owner)).snapshot_id,row.id);
});
test('Mac ambiguous cache resolves player metadata once and reuses stored same-track captions; explicit Arabic and later defaults never refetch',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'youtube-default-policy-test-')),namespace='a'.repeat(64),directory=path.join(root,'snapshots',namespace),job={job_id:'b'.repeat(64),owner_namespace:namespace,video_id:id};await mkdir(directory,{recursive:true});
  const sha=value=>createHash('sha256').update(value).digest('hex');const originals={};
  try{for(const code of ['ar','en']){const transcript=fixture(code),bytes=JSON.stringify({transcript,segment_sha256:sha(JSON.stringify(transcript.segments))});originals[code]=bytes;await writeFile(path.join(directory,id+'.'+code+'.json'),bytes);}
    const requests=[],worker=new PrivateWorker({root,extractorFactory:()=>extractor(renderer(),requests)});const result=await worker.localResult(job);assert.equal(result.transcript.selected_language,'en');assert.equal(result.transcript.default_selection.policy,'upstream-default-v1');assert.equal(requests.length,1);assert.ok(requests[0].includes('/player'));assert.deepEqual(result.transcript.segments,fixture('en').segments);
    assert.equal((await worker.localResult(job)).local_cache,'hit');assert.equal((await worker.localResult({...job,lang:'ar'})).transcript.selected_language,'ar');assert.equal(requests.length,1);for(const code of ['ar','en'])assert.equal(await readFile(path.join(directory,id+'.'+code+'.json'),'utf8'),originals[code]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('old worker cannot submit ambiguous multi-language results into repaired default',async()=>{
  const db=localDb(),queue=new AcquisitionQueue(db);await queue.enqueue(owner,id);const job=await queue.claim('worker');await assert.rejects(queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:fixture('ar')}),e=>e.code==='invalid_input');assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,0);
});
test('creator defaults use repaired cache and cannot replay old default manifests',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),proof=selectionProof(resolveDefaultTrack(tracks,renderer()),'a.en');await cache.write(owner,fixture('ar'),undefined);const en=await cache.write(owner,fixture('en',{default_selection:proof}),undefined);
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('creator must reuse corrected captions')}),catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:[{id}],continuation:null})});
  const response=await creatorTranscripts(service,db,{creator_url:'https://www.youtube.com/@Synthetic',limit:1},owner,{catalogFactory});assert.equal(response.results[0].selected_language,'en');assert.equal(response.results[0].snapshot_id,en.id);
  const row=db.sqlite.prepare('SELECT request_key FROM creator_jobs').get();assert.equal(row.request_key,await digest(JSON.stringify([owner,'https://www.youtube.com/@Synthetic/videos',1,DEFAULT_JOB_LANGUAGE,'full-text-v1','full'])));
});
test('claimed selection can reuse an existing Sites track without exposing caption text or downloading captions; cannot select another owner/video',async()=>{
  const db=localDb(),queue=new AcquisitionQueue(db),cache=queue.cache,english=await cache.write(owner,fixture('en'),'en');await cache.write('other',fixture('fr'),'fr');await queue.enqueue(owner,id);const job=await queue.claim('worker'),chosen=resolveDefaultTrack(tracks,renderer()),selection={selected_language:'en',track_id:'a.en',default_selection:selectionProof(chosen,'a.en')};
  const missing=await queue.submit('worker',{job_id:job.job_id,token:job.token,selection:{...selection,track_id:'foreign',default_selection:{...selection.default_selection,track_id:'foreign'}}});assert.equal(missing.status,'needs_captions');assert.equal(db.sqlite.prepare('SELECT status FROM acquisition_jobs').get().status,'leased');
  const receipt=await queue.submit('worker',{job_id:job.job_id,token:job.token,selection});assert.equal(receipt.snapshot_id,english.id);assert.equal(receipt.status,'complete');assert.equal(receipt.segments,undefined);assert.equal((await cache.latest(owner,id)).id,english.id);
});
test('Mac worker with empty local cache reuses the same Sites track after one synthetic player request and no caption request',async()=>{
  const {generateKeyPairSync}=await import('node:crypto');const {signedRequest}=await import('../scripts/private-acquisition-worker.mjs');const {handleAcquisition}=await import('../lib/acquisition-handler.mjs');
  const db=localDb(),queue=new AcquisitionQueue(db),english=await queue.cache.write(owner,fixture('en'),'en'),keys=generateKeyPairSync('ed25519'),env={DB:db,ACQUISITION_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')};await queue.enqueue(owner,id);
  const root=await mkdtemp(path.join(tmpdir(),'youtube-sites-track-test-')),requests=[];
  try{const worker=new PrivateWorker({root,privateKey:keys.privateKey,extractorFactory:()=>extractor(renderer(),requests),fetchImpl:request=>handleAcquisition(request,env,{queueFactory:()=>queue})});const result=await worker.once();assert.equal(result.status,'complete');assert.equal(result.local_cache,'site_hit');assert.equal(result.snapshot_id,english.id);assert.equal(requests.length,1);assert.ok(requests[0].includes('/player'));assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_snapshots').get().n,1);}finally{await rm(root,{recursive:true,force:true});}
});
test('additive default alias migration changes no prior snapshot, chunk or acquisition row',async()=>{
  const {DatabaseSync}=await import('node:sqlite');const {readFileSync}=await import('node:fs');const db=new DatabaseSync(':memory:');for(const name of ['0000_typical_blink.sql','0001_faithful_dracula.sql','0002_cooing_tigra.sql','0003_spotty_red_hulk.sql'])db.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));db.prepare('INSERT INTO transcript_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy',owner,id,'__default__','ar','a.ar','old','key',1,0,10,1,'{}');const before=db.prepare('SELECT * FROM transcript_snapshots').get();const sql=readFileSync(new URL('../drizzle/0004_demonic_dragon_lord.sql',import.meta.url),'utf8');assert.match(sql.trim(),/^CREATE TABLE/);db.exec(sql);assert.deepEqual(db.prepare('SELECT * FROM transcript_snapshots').get(),before);db.close();
});
test('missing legacy language lists cannot mask conflicting stored languages; claimed job asks Mac to resolve metadata',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),ar=fixture('ar'),en=fixture('en');delete ar.languages;delete en.languages;await cache.write(owner,ar,'ar');await cache.write(owner,en,'en');assert.equal(await cache.latest(owner,id),null);const queue=new AcquisitionQueue(db);await queue.enqueue(owner,id);const job=await queue.claim('worker');assert.equal(job.resolve_default,true);await assert.rejects(queue.submit('worker',{job_id:job.job_id,token:job.token,transcript:ar}),e=>e.code==='invalid_input');
});

test('21 alphabetical ASR dub tracks reproduce advertised audio index 17 and caption index 3',()=>{
  const codes=['ar','bg','de','en','es','fr','hi','id','it','ja','ko','nl','pl','pt','ro','ru','sv','ta','th','tr','vi'];const many=codes.map(languageCode=>({languageCode,kind:'asr'}));const r={defaultAudioTrackIndex:17,audioTracks:Array.from({length:21},(_,i)=>({audioTrackId:i===17?'en-US.4':'ar.0',defaultCaptionTrackIndex:i===17?3:0,captionTrackIndices:codes.map((_,j)=>j)}))};assert.equal(resolveDefaultTrack(many,r).index,3);assert.equal(resolveDefaultTrack(many,r).track.languageCode,'en');
});
test('unproven legacy default remains reusable only while stored language evidence is single-language',async()=>{
  const db=localDb(),cache=new SnapshotCache(db);const ar=fixture('ar');delete ar.languages;const row=await cache.write(owner,ar,undefined);assert.equal((await cache.latest(owner,id)).id,row.id);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM transcript_defaults').get().n,0);const en=fixture('en');delete en.languages;await cache.write(owner,en,'en');assert.equal(await cache.latest(owner,id),null);assert.equal((await cache.latest(owner,id,'ar')).id,row.id);
});
