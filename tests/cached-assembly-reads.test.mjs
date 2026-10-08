import test from 'node:test';
import assert from 'node:assert/strict';
import {localDb} from './sqlite-adapter.mjs';
import {SnapshotCache,storageFailureClass} from '../lib/snapshot-cache.mjs';
import {TranscriptService} from '../lib/transcript-service.mjs';
import {transcriptBatch,FULL_RESPONSE_BUDGET,responseBytes} from '../lib/transcript-batch.mjs';

const id='readbudget0';
const fixture={video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:'synthetic',extraction_method:'synthetic',segments:Array.from({length:10390},(_,i)=>({text:`Cue ${i} 字幕🦜 "\\*.`,start:i*2,duration:1}))};
function measuredDb(db,limit=Infinity){
 const sqls=[];function wrap(s,sql){return {bind(...args){return wrap(s.bind(...args),sql);},async first(){sqls.push(sql);if(sqls.length>limit)throw Error('Synthetic per-invocation read budget exceeded');return s.first();},run:()=>s.run()};}
 return {sqls,db:{...db,prepare:sql=>wrap(db.prepare(sql),sql)}};
}
test('cached assembly: one chunk read per following page, not repeated manifests and ASR context queries',async()=>{
 const db=localDb();try{
  await new SnapshotCache(db).write('owner',fixture);const measured=measuredDb(db,150),service=new TranscriptService(measured.db,{extractorFactory:()=>assert.fail('No refetch')});
  const result=await transcriptBatch(service,{videos:[id]},'owner'),r=result.results[0];
  assert.equal(r.ok,true,'a bounded stored window must not exhaust the synthetic query budget');
  assert(r.storage_pages_consumed>50);assert(responseBytes(result)<=FULL_RESPONSE_BUDGET);
  assert.equal(measured.sqls.filter(sql=>sql==='SELECT segments_json FROM transcript_chunks WHERE snapshot_id = ? AND page = ?').length,0,'the incremental cleaner already holds preceding cues');
  assert.equal(measured.sqls.filter(sql=>sql==='SELECT * FROM transcript_snapshots WHERE id = ? AND owner_key = ?').length,0,'reuse the authenticated immutable manifest within this invocation');
  assert(measured.sqls.length<=r.storage_pages_consumed+5);
 }finally{db.sqlite.close();}
});
test('cached assembly: provider failures expose only fixed nonsecret classes',async()=>{
 assert.equal(storageFailureClass(Error('Too many API requests; private.operator.invalid token-value')),'request_limit');
 assert.equal(storageFailureClass({message:'D1_ERROR',cause:Error('database is overloaded; SELECT private_owner_value')}),'overloaded');
 const db=localDb();try{
  await new SnapshotCache(db).write('owner',fixture);
  const broken={...db,prepare:()=>({bind(){return this;},first:async()=>{throw Error('Too many API requests; private.operator.invalid token-value');}})};
  const result=await transcriptBatch(new TranscriptService(broken),{videos:[id]},'owner');
  assert.equal(result.results[0].error.storage_error_class,'request_limit');assert.doesNotMatch(JSON.stringify(result),/private\.operator|token-value/);
 }finally{db.sqlite.close();}
});
test('cached assembly: retained manifest cannot cross owner, snapshot, video or language boundaries',async()=>{
 const db=localDb();try{
  await new SnapshotCache(db).write('owner-a',fixture);
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('No refetch')}),first=await service.call('get_transcript',{url:id},'owner-a');
  assert.equal(service.cache.retainedManifest(first,'owner-b'),null);
  await assert.rejects(service.call('get_transcript',{url:id,next_cursor:first.next_cursor},'owner-b',{continuationContext:first}),e=>e.code==='snapshot_unavailable');
  for(const args of [{url:'othervideo0',next_cursor:first.next_cursor},{url:id,lang:'fr',next_cursor:first.next_cursor}])await assert.rejects(service.call('get_transcript',args,'owner-a',{continuationContext:first}),e=>e.code==='invalid_cursor');
  assert.equal(service.cache.retainedManifest({...first},'owner-a'),null,'a JSON-shaped object is not a trusted manifest capability');
 }finally{db.sqlite.close();}
});
