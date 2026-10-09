import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { SnapshotCache } from '../lib/snapshot-cache.mjs';
import { transcriptBatch,responseBytes } from '../lib/transcript-batch.mjs';
import { creatorTranscripts } from '../lib/creator-transcripts.mjs';
import { cleanTranscript } from '../lib/transcript-markdown.mjs';
import { localDb } from './sqlite-adapter.mjs';
export const ids=Array.from({length:10},(_,i)=>`fulltext_${String(i).padStart(2,'0')}`);
export const fixture=(id,count=898,wide=false)=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:'synthetic-full-text',extraction_method:'synthetic',segments:Array.from({length:count},(_,i)=>({text:wide?`Cue ${i} ${'字幕🦜 "\\*'.repeat(18)}.`:`Complete cue ${i}.`,start:i*2,duration:1}))});
const speech=markdown=>markdown.split(/Language: [^\n]*\n\n/)[1].split(/\n\n\*\*(?:More captions remain|Transcript snapshot complete)/)[0];
const canonical=text=>text.replace(/\s+/g,' ').trim();
async function setup(fixtures) {const db=localDb(),cache=new SnapshotCache(db);for(const f of fixtures)await cache.write('owner',f);return {db,service:new TranscriptService(db,{extractorFactory:()=>assert.fail('stored captions must never refetch')})};}
test('SQLite: complete 898/717 fixtures and ten mixed full-fit inputs keep all cues and stable hashes',async()=>{
 const fixtures=ids.map((id,i)=>fixture(id,i===1?717:898)),{service}=await setup(fixtures);
 const inputs=ids.map((id,i)=>i%3===0?id:i%3===1?`https://youtu.be/${id}?si=mixed`:`https://www.youtube.com/watch?v=${id}&t=9`);
 const result=await transcriptBatch(service,{videos:inputs},'owner');assert.equal(result.success_count,10);assert.equal(result.has_more,false);assert.equal(result.response_budget_bytes,null);
 for(let i=0;i<10;i++){assert.equal(result.results[i].delivery,'full');assert.equal(result.results[i].returned_segment_count,fixtures[i].segments.length);assert.equal(result.results[i].next_cursor,null);assert(result.markdown.includes(`Complete cue ${fixtures[i].segments.length-1}.`));}
 const repeat=await transcriptBatch(service,{videos:ids},'owner');assert.deepEqual(repeat.results.map(x=>x.segment_hash),result.results.map(x=>x.segment_hash));assert(repeat.results.every(x=>x.cache_status==='hit'));
});
test('SQLite: explicitly requested pages and cursors reconstruct complete immutable cleaned content',async()=>{
 const f=fixture(ids[0],1400,true);f.segments[119]={text:'one two three four',start:238,duration:4};f.segments[120]={text:'two three four five',start:239,duration:3};const {service}=await setup([f]);
 let page=await transcriptBatch(service,{videos:[ids[0]],delivery:'paged'},'owner'),texts=[],hash=page.results[0].segment_hash;assert.equal(page.results[0].delivery,'paged');assert.equal(page.results[0].overflow_reason,null);
 while(true){assert.equal(page.response_budget_bytes,null);texts.push(speech(page.markdown));assert.equal(page.results[0].segment_hash,hash);if(!page.has_more)break;const cursor=page.next_cursors[ids[0]];const again=await transcriptBatch(service,{videos:[ids[0]],delivery:'paged',next_cursors:{[ids[0]]:cursor}},'owner');assert(again.results[0].page_index>page.results[0].page_index);page=again;}
 assert.equal(canonical(texts.join(' ')),canonical(cleanTranscript(f.segments,{rolling:true})));
});
test('SQLite: mixed oversized, denial and small full results stay ordered and bound JSON escaping/Unicode envelope',async()=>{
 const {service}=await setup([fixture(ids[0],1400,true),fixture(ids[1],717)]),original=service.call.bind(service);
 service.call=async(name,args,...rest)=>{if(args.url===ids[2])throw Object.assign(new Error('denied'),{code:'access_restriction'});return original(name,args,...rest);};
 const result=await transcriptBatch(service,{videos:ids.slice(0,3)},'owner');assert.equal(result.status,'partial');assert.equal(result.results[0].delivery,'full');assert.equal(result.results[1].delivery,'full');assert.equal(result.results[2].ok,false);assert(responseBytes(result,'🦜'.repeat(1000))>256*1024);
 assert(!JSON.stringify(result.results).includes('Complete cue'));assert(!JSON.stringify(result.results).includes('字幕'));
});
test('SQLite: creator full default, explicit paging and custom cursor replay reuse saved snapshots',async()=>{
 const {db,service}=await setup(ids.map(id=>fixture(id,717))),catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:ids.map(id=>({id})),continuation:null})});
 const input={creator_url:'https://www.youtube.com/@Synthetic',limit:7},options={catalogFactory};
 const full=await creatorTranscripts(service,db,input,'owner',options);assert.equal(full.collected_count,7);assert(full.results.every(x=>x.delivery==='full'&&!x.has_more));assert.equal(full.response_budget_bytes,null);
 const replay=await creatorTranscripts(service,db,input,'owner',options);assert.equal(replay.replayed,true);assert.equal(replay.markdown,full.markdown);
 const paged=await creatorTranscripts(service,db,{...input,delivery:'paged'},'owner',options);assert(paged.results.every(x=>x.delivery==='paged'&&x.has_more));assert.equal(paged.replayed,false);
});
test('SQLite: aggregate envelopes above the former cap keep every complete transcript',async()=>{
 const fixtures=ids.map(id=>{const f=fixture(id,898);f.segments=f.segments.map(x=>({...x,text:x.text+' 🦜字幕 "\\*'.repeat(3)}));return f;});const {service}=await setup(fixtures);
 const result=await transcriptBatch(service,{videos:ids},'owner');assert.equal(result.response_budget_bytes,null);assert.equal(result.success_count,10);assert(result.results.every(x=>x.delivery==='full'&&!x.has_more));assert(responseBytes(result)>256*1024);assert.deepEqual(result.results.map(x=>x.video_id),ids);
});
test('SQLite: large creator replies and exact replay keep every collected transcript',async()=>{
 const {db,service}=await setup(ids.map(id=>fixture(id,1400,true))),catalogFactory=()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:ids.map(id=>({id})),continuation:null})});const input={creator_url:'https://www.youtube.com/@Wide',limit:10};
 const first=await creatorTranscripts(service,db,input,'owner',{catalogFactory});assert.equal(first.response_budget_bytes,null);assert.equal(first.collected_count,10);assert.equal(first.unresolved_retrievals.length,0);assert.equal(first.status,'success');assert(first.results.every(x=>x.delivery==='full'&&!x.has_more));assert(responseBytes(first)>2000000);
 const replay=await creatorTranscripts(service,db,input,'owner',{catalogFactory});assert.equal(replay.replayed,true);assert.equal(replay.markdown,first.markdown);assert.deepEqual(replay.collected_video_ids,first.collected_video_ids);
});
