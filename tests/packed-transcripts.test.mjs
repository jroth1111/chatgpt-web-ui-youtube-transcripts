import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptBatch,responseBytes} from '../lib/transcript-batch.mjs';
import {cleanTranscript} from '../lib/transcript-markdown.mjs';
import {SnapshotCache} from '../lib/snapshot-cache.mjs';
import {TranscriptService} from '../lib/transcript-service.mjs';
import {localDb} from './sqlite-adapter.mjs';

const id='packedvid00',owner='owner';
const body=markdown=>markdown.split(/Language: [^\n]*\n\n/)[1].split(/\n\n\*\*(?:More captions remain|Transcript snapshot complete)/)[0];
const canonical=text=>text.replace(/\s+/g,' ').trim();
const fixture=(count,width=80)=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:'synthetic-packed',extraction_method:'synthetic',segments:Array.from({length:count},(_,i)=>({text:`Cue ${i} ${'字幕🦜 "\\*'.repeat(width)}.`,start:i*2,duration:1}))});

test('packed: cached oversize stops before the assembly deadline and returns resumable progress',async()=>{
 let clock=0,reads=0;
 const raw=fixture(28480,18).segments;
 const service={call:async(_name,args)=>{
  const p=args.next_cursor?Number(args.next_cursor):0,segments=raw.slice(p*120,(p+1)*120),more=(p+1)*120<raw.length;
  clock+=5000;reads++;
  return {snapshot_id:'synthetic-snapshot',segment_hash:'stable-hash',selected_language:'en',caption_type:'auto_generated',page_index:p,page_count:Math.ceil(raw.length/120),first_segment_index:p*120,segments,returned_segment_count:segments.length,segment_count:raw.length,has_more:more,next_cursor:more?String(p+1):null,cache_status:'hit',retention:'durable'};
 }};
 const result=await transcriptBatch(service,{videos:[id]},owner,{now:()=>clock,budgetMs:45000});
 assert.equal(result.success_count,1,'available cached text must not be replaced with service_busy');
 assert.equal(result.results[0].delivery,'paged');assert(result.has_more);assert(result.results[0].returned_segment_count>120);
 assert(reads<20,'must not assemble past the execution deadline');assert.equal(result.results[0].overflow_reason,'assembly_time_budget');
 assert.equal(Number(result.next_cursors[id]),result.results[0].storage_page_end+1);
});

test('packed: few complete Unicode/ASR windows preserve all stored cues, cursors and normalized text',async()=>{
 const db=localDb();try{
  const f=fixture(10390,8);f.segments[599]={text:'one two three four',start:1198,duration:4};f.segments[600]={text:'two three four five',start:1199,duration:3};
  await new SnapshotCache(db).write(owner,f);
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('cached text must not refetch')});
  let args={videos:[id]},calls=0,count=0,hash,snapshot,texts=[],previousEnd=-1;
  do{
   const result=await transcriptBatch(service,args,owner,{measure:value=>responseBytes(value,'🦜'.repeat(1000))});
   const r=result.results[0];assert.equal(r.ok,true);assert.equal(result.response_budget_bytes,null);
   if(count>0)assert.equal(r.delivery,'paged','a fitting tail is not the complete transcript');
   assert.equal(r.first_segment_index,count);assert.equal(r.page_index,previousEnd+1);assert(r.storage_pages_consumed>1||!result.has_more);
   hash??=r.segment_hash;snapshot??=r.snapshot_id;assert.equal(r.segment_hash,hash);assert.equal(r.snapshot_id,snapshot);
   count+=r.returned_segment_count;previousEnd=r.storage_page_end;texts.push(body(result.markdown));calls++;
   if(!result.has_more)break;
   assert.equal(r.delivery,'paged');args={videos:[id],next_cursors:result.next_cursors};
  }while(calls<20);
  assert.equal(count,f.segments.length);assert.equal(calls,1,'stored chunks must not force client pagination');
  assert.equal(canonical(texts.join(' ')),canonical(cleanTranscript(f.segments,{rolling:true})));
 }finally{db.sqlite.close();}
});

test('packed: changed snapshot indices are an integrity failure, never partial success',async()=>{
 let calls=0;
 const service={call:async()=>({snapshot_id:'stable',segment_hash:'hash',selected_language:'en',caption_type:'manual',page_count:2,page_index:calls++,first_segment_index:calls===1?0:99,segment_count:2,returned_segment_count:1,segments:[{text:'One cue',start:calls,duration:1}],has_more:calls===1,next_cursor:calls===1?'next':null,cache_status:'hit'})};
 const result=await transcriptBatch(service,{videos:[id]},owner);assert.equal(result.success_count,0);assert.equal(result.results[0].error.code,'storage_unavailable');
});

test('packed: raw and explicitly paged clean delivery keep immutable storage granularity',async()=>{
 const db=localDb();try{
  await new SnapshotCache(db).write(owner,fixture(1000,8));
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('No refetch')});
  const raw=await service.call('get_transcript',{url:id},owner),clean=await transcriptBatch(service,{videos:[id],delivery:'paged'},owner);
  assert.equal(raw.returned_segment_count,120);assert.equal(clean.results[0].returned_segment_count,120);
  assert.equal(raw.next_cursor,clean.next_cursors[id]);
 }finally{db.sqlite.close();}
});

test('packed: a near-safe-budget full text stays complete rather than using a conservative raw-size cap',async()=>{
 const db=localDb();try{
  const f=fixture(1200,1);f.segments=f.segments.map((s,i)=>({...s,text:`Cue ${i} `+'x'.repeat(184)}));
  await new SnapshotCache(db).write(owner,f);const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('No refetch')});
  const result=await transcriptBatch(service,{videos:[id]},owner);
  assert.equal(result.results[0].delivery,'full');assert.equal(result.results[0].returned_segment_count,1200);assert.equal(result.has_more,false);
  assert(responseBytes(result)>224*1024);assert.equal(result.response_budget_bytes,null);
 }finally{db.sqlite.close();}
});
