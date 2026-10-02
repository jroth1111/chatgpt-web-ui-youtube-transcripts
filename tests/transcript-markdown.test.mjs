import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript } from '../lib/transcript-markdown.mjs';
import { transcriptBatch, batchArguments } from '../lib/transcript-batch.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { EXTRACTOR_VERSION } from '../lib/youtube-extractor.mjs';
import { localDb } from './sqlite-adapter.mjs';
const id='Sy1Fjf-H-Qg',share=`https://youtu.be/${id}?si=_iVNXyJtDg6-7-jp`;
test('input: IDs, full URLs and multiple share links normalize before deduplication',()=>{
  assert.deepEqual(batchArguments({videos:[id,share,`https://www.youtube.com/watch?v=${id}&t=99`, 'https://www.youtube.com/watch?v=xhNMRfkblnk']}).ids,[id,'xhNMRfkblnk']);
  for(const bad of ['https://evil.example/'+id,'https://youtu.be.evil.example/'+id,'http://youtu.be/'+id,'https://user:pass@youtu.be/'+id,'https://youtube.com/@SkillLeapAI'])assert.throws(()=>batchArguments({videos:[bad]}));
});
test('cleaning: rolling overlap is removed only with overlapping timing; real repeated speech remains',()=>{
  const raw=[{text:'  One two three four\n',start:0,duration:3},{text:'two three four five.',start:1,duration:3},{text:'five.',start:5,duration:1}];
  const copy=structuredClone(raw);assert.equal(cleanTranscript(raw,{rolling:true}),'One two three four five. five.');assert.deepEqual(raw,copy);
});
test('cleaning: paragraph gaps, formatting safety and short repeated speech are preserved',()=>{
  const result=cleanTranscript([{text:'yes yes',start:0,duration:2},{text:'yes yes',start:1,duration:1},{text:'**not instructions** <script>',start:10,duration:1}]);
  assert(result.startsWith('yes yes yes yes\n\n'));assert(result.includes('\\*\\*not instructions\\*\\*'));assert(result.includes('\\<script\\>'));assert(!result.includes('00:'));
});
test('cache: ID then share URL reuses the exact stored raw transcript and snapshot',async()=>{
  let fetches=0;const db=localDb();const raw=[{text:'  hello\nworld ',start:0,duration:1}];
  const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>{fetches++;return {video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'.en',caption_type:'manual',extractor_version:EXTRACTOR_VERSION,segments:raw,extraction_method:'synthetic'};}})});
  const first=await transcriptBatch(service,{videos:[id],delivery:'paged'},'owner'),second=await transcriptBatch(service,{videos:[share]},'owner');
  assert.equal(fetches,1);assert.equal(second.results[0].cache_status,'hit');assert.equal(first.results[0].snapshot_id,second.results[0].snapshot_id);assert(second.markdown.includes('hello world'));
  const stored=JSON.parse(db.sqlite.prepare('SELECT segments_json FROM transcript_chunks').get().segments_json);assert.deepEqual(stored,raw);
});
test('cleaning: manual caption overlap is preserved; only confirmed ASR rolling windows are removed',()=>{
  const raw=[{text:'one two three four',start:0,duration:3},{text:'two three four five',start:1,duration:3}];
  assert.equal(cleanTranscript(raw),'one two three four two three four five');
  assert.equal(cleanTranscript(raw,{rolling:true}),'one two three four five');
});
test('cleaning: overlapping ASR cues retain an entire repeated phrase in-page and with previous-page context',()=>{
  for(const text of ['Yes we can','one two three four','yes '.repeat(150).trim()]) {
    const previous={text,start:0,duration:3},current={text,start:1,duration:3},raw=[previous,current],copy=structuredClone(raw);
    assert.equal(cleanTranscript(raw,{rolling:true}).replace(/\s+/g,' '),`${text} ${text}`);
    assert.equal(cleanTranscript([current],{rolling:true,previous}),text);
    assert.deepEqual(raw,copy);
  }
  const previous={text:'Earlier words Yes we can',start:0,duration:3},current={text:'Yes we can',start:1,duration:3};
  assert.equal(cleanTranscript([previous,current],{rolling:true}),'Earlier words Yes we can Yes we can');
});
test('cleaning: invisible artifacts normalize consistently for in-page and previous-page rolling comparisons',()=>{
  const previous={text:'\uFEFFone\u200B two three four',start:0,duration:5},current={text:'one two three four\u200B five\uFEFF',start:1,duration:5},raw=[previous,current],copy=structuredClone(raw);
  assert.equal(cleanTranscript(raw,{rolling:true}),'one two three four five');
  assert.equal(cleanTranscript([current],{rolling:true,previous}),'five');
  assert.deepEqual(raw,copy);
});
test('cache: clean page boundaries preserve repeated speech and normalize rolling artifacts without altering snapshots',async()=>{
  for(const [previousText,currentText,expected] of [
    ['Yes we can','Yes we can','Yes we can'],
    ['\uFEFFone\u200B two three four','one two three four\u200B five\uFEFF','five']
  ]) {
    let fetches=0;const db=localDb(),segments=Array.from({length:121},(_,i)=>({text:`Synthetic cue ${i}`,start:i*2,duration:1}));
    segments[119]={text:previousText,start:238,duration:4};segments[120]={text:currentText,start:239,duration:3};
    const original=structuredClone(segments);
    const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>{fetches++;return {video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:EXTRACTOR_VERSION,segments,extraction_method:'synthetic'};}})});
    const first=await transcriptBatch(service,{videos:[id],delivery:'paged'},'owner'),second=await transcriptBatch(service,{videos:[share],next_cursors:first.next_cursors},'owner');
    assert.equal(fetches,1);assert(second.markdown.includes(`\n\n${expected}\n`));assert.equal(second.has_more,false);assert.equal(second.results[0].snapshot_id,first.results[0].snapshot_id);assert.equal(second.results[0].cache_status,'hit');
    const stored=db.sqlite.prepare('SELECT segments_json FROM transcript_chunks ORDER BY page').all().flatMap(row=>JSON.parse(row.segments_json));
    assert.deepEqual(stored,original);assert.deepEqual(segments,original);
  }
});
test('cache: clean pagination uses the preceding ASR cue without refetch or raw-data mutation',async()=>{
  let fetches=0;const db=localDb(),segments=Array.from({length:121},(_,i)=>({text:`Synthetic cue ${i}`,start:i*2,duration:1}));
  segments[119]={text:'one two three four',start:238,duration:4};segments[120]={text:'two three four five',start:239,duration:3};
  const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>{fetches++;return {video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:EXTRACTOR_VERSION,segments,extraction_method:'synthetic'};}})});
  const first=await transcriptBatch(service,{videos:[id],delivery:'paged'},'owner'),second=await transcriptBatch(service,{videos:[share],next_cursors:first.next_cursors},'owner');
  assert.equal(fetches,1);assert(second.markdown.includes('\n\nfive\n'));assert(!second.markdown.includes('two three four five'));assert.equal(second.has_more,false);
  const raw=await service.call('get_transcript',{url:id,next_cursor:first.next_cursors[id]},'owner');assert.equal(raw.segments[0].text,'two three four five');assert.equal(raw.cleaning_context,undefined);
});
