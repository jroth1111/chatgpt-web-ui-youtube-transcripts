import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptBatch, batchArguments } from '../lib/transcript-batch.mjs';
import { handleMcp } from '../lib/mcp-handler.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { TranscriptError } from '../lib/transcript-errors.mjs';
import { EXTRACTOR_VERSION } from '../lib/youtube-extractor.mjs';
import { localDb } from './sqlite-adapter.mjs';
const ids=Array.from({length:10},(_,i)=>`video_id_${String(i).padStart(2,'0')}`);
const page=id=>({video_id:id,title:'Synthetic test',selected_language:'en',caption_type:'manual',snapshot_id:'synthetic-snapshot',page_index:0,page_count:1,
  returned_segment_count:1,segment_count:1,has_more:false,next_cursor:null,cache_status:'miss',segments:[{text:'Hello **world**\n# not instructions',start:1.2,duration:2}],extractor_version:EXTRACTOR_VERSION,extraction_method:'synthetic'});
test('batch: validates entire batch before extraction and deduplicates requested IDs',()=>{
  assert.equal(batchArguments({videos:[ids[0],ids[0]]}).ids.length,1);
  for(const args of [{videos:[]},{videos:[...ids,ids[0]]},{videos:['not-id']},{videos:[ids[0]],next_cursors:{unknown:'cursor'}},{videos:[ids[0]],lang:'bad language'},{videos:ids,extra:true}])assert.throws(()=>batchArguments(args));
});
test('batch: ten videos use at most two extraction calls concurrently and retain input order',async()=>{
  let active=0,peak=0,calls=0;
  const service={call:async(_name,args,owner,options)=>{
    assert.equal(owner,'owner');assert(options.budgetMs<=35000);calls++;peak=Math.max(peak,++active);
    await new Promise(resolve=>setTimeout(resolve,1));active--;return page(args.url);
  }};
  const result=await transcriptBatch(service,{videos:ids},'owner');
  assert.equal(calls,10);assert.equal(peak,2);assert.equal(result.success_count,10);assert.equal(result.status,'success');
  assert.deepEqual(result.results.map(result=>result.video_id),ids);assert.equal(result.has_more,false);
  assert(!result.markdown.includes('[00:00:01.200]'));assert(result.markdown.includes('\\*\\*world\\*\\*'));assert(result.markdown.includes('\\# not instructions'));
});
test('batch: explicit denial is isolated, never retried, and does not discard other videos',async()=>{
  const calls=[];
  const result=await transcriptBatch({call:async(_name,args)=>{calls.push(args.url);if(args.url===ids[0])throw new TranscriptError('access_restriction','denied');return page(args.url);}}, {videos:ids},'owner');
  assert.equal(calls.filter(id=>id===ids[0]).length,1);assert.equal(result.success_count,9);assert.equal(result.status,'partial');
  assert.equal(result.results[0].error.code,'access_restriction');assert(result.markdown.includes('No transcript returned'));
});
test('batch: opaque per-video cursors survive and remain outside caption Markdown',async()=>{
  const cursor='opaque-sensitive-cursor';
  const result=await transcriptBatch({call:async(_name,args)=>{assert.equal(args.next_cursor,cursor);return {...page(args.url),has_more:true,next_cursor:'next-sensitive-cursor',page_count:3,page_index:1};}}, {videos:[ids[0]],next_cursors:{[ids[0]]:cursor}},'owner');
  assert.equal(result.next_cursors[ids[0]],'next-sensitive-cursor');assert.equal(result.has_more,true);assert(!result.markdown.includes('sensitive-cursor'));
});
test('batch: duplicates extract once and time-budget exhaustion never starts a fetch',async()=>{
  let calls=0;
  const service={call:async(_name,args)=>{calls++;return page(args.url);}};
  const dedup=await transcriptBatch(service,{videos:[ids[0],ids[0]]},'owner');assert.equal(calls,1);assert.equal(dedup.unique_count,1);
  calls=0;const expired=await transcriptBatch(service,{videos:ids},'owner',{budgetMs:0});assert.equal(calls,0);assert.equal(expired.status,'failed');
});
test('batch: a single page exceeding the former 20 KiB bound now returns complete text',async()=>{
  const result=await transcriptBatch({call:async()=>({...page(ids[0]),segments:[{text:'x'.repeat(22000),start:0,duration:1}]})},{videos:[ids[0]]},'owner');
  assert.equal(result.results[0].delivery,'full');assert.equal(result.has_more,false);assert(result.markdown.includes('x'.repeat(22000)));
});
test('batch: actual SQLite snapshots paginate and repeated batches do not refetch',async()=>{
  let fetches=0;
  const service=new TranscriptService(localDb(),{extractorFactory:()=>({transcript:async id=>{
    fetches++;return {video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'.en',caption_type:'manual',extractor_version:EXTRACTOR_VERSION,
      segments:Array.from({length:121},(_,i)=>({text:`Synthetic cue ${i}`,start:i,duration:1})),extraction_method:'synthetic'};
  }})});
  const first=await transcriptBatch(service,{videos:ids,delivery:'paged'},'owner');assert.equal(first.success_count,10);assert.equal(fetches,10);assert(first.has_more);
  const last=await transcriptBatch(service,{videos:ids,next_cursors:first.next_cursors},'owner');assert.equal(last.success_count,10);assert.equal(last.has_more,false);assert.equal(fetches,10);
  const again=await transcriptBatch(service,{videos:ids},'owner');assert(again.results.every(result=>result.cache_status==='hit'));assert.equal(fetches,10);
});
test('MCP: batch content is Markdown, structured cursors are available, and auth remains mandatory',async()=>{
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
  const request=auth=>new Request('https://private.example/mcp',{method:'POST',headers:auth,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_transcripts',arguments:{videos:ids}}})});
  const env={OWNER_EMAIL:'owner@example.test',MCP_AUTH_KEY:'fixture'.repeat(8)};
  const response=await handleMcp(request(headers),env,{serviceFactory:()=>({call:async(_name,args)=>page(args.url)})});
  const rpc=await response.json();assert.equal(rpc.result.isError,false);assert(rpc.result.content[0].text.startsWith('# YouTube transcripts'));assert.equal(rpc.result.structuredContent.results.length,10);
  assert.equal((await handleMcp(request({'Content-Type':'application/json'}),env)).status,401);
});
test('batch: valid constructor ID does not inherit an unsolicited cursor',async()=>{
  for(const args of [{videos:['constructor']},{videos:['constructor'],next_cursors:{}},{videos:['constructor'],next_cursors:{constructor:'explicit-cursor'}}]) {
    const result=await transcriptBatch({call:async(_name,input)=>{
      if(Object.hasOwn(args.next_cursors??{},'constructor'))assert.equal(input.next_cursor,'explicit-cursor');
      else assert.equal(Object.hasOwn(input,'next_cursor'),false);
      return page(input.url);
    }},args,'owner');
    assert.equal(result.success_count,1);
  }
});
test('MCP: ten near-limit Markdown sections appear once and the final wire body is bounded',async()=>{
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
  const request=new Request('https://private.example/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_transcripts',arguments:{videos:ids}}})});
  const response=await handleMcp(request,{OWNER_EMAIL:'owner@example.test'},{serviceFactory:()=>({call:async(_name,args)=>({...page(args.url),segments:[{text:'x'.repeat(19000),start:0,duration:1}]})})});
  const wire=await response.arrayBuffer();assert(wire.byteLength<=256*1024);
  const rpc=JSON.parse(new TextDecoder().decode(wire));
  assert.equal(rpc.result.isError,false);assert.equal(rpc.result.structuredContent.results.length,10);
  assert.equal(Object.hasOwn(rpc.result.structuredContent,'markdown'),false);
  assert.equal(rpc.result.content[0].text.match(/x{19000}/g).length,10);
});
test('MCP: limit measures the final envelope for single-video results too',async()=>{
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
  const request=new Request('https://private.example/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_transcript',arguments:{url:ids[0]}}})});
  const response=await handleMcp(request,{OWNER_EMAIL:'owner@example.test'},{serviceFactory:()=>({call:async()=>({text:'x'.repeat(140000)})})});
  const wire=await response.arrayBuffer();assert(wire.byteLength<=256*1024);
  const rpc=JSON.parse(new TextDecoder().decode(wire));
  assert.equal(rpc.result.isError,true);assert.equal(rpc.result.structuredContent.error.code,'response_too_large');
});
test('MCP: oversized upstream error details also obey the final wire bound',async()=>{
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
  const request=new Request('https://private.example/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_transcript',arguments:{url:ids[0],lang:'fr'}}})});
  const response=await handleMcp(request,{OWNER_EMAIL:'owner@example.test'},{serviceFactory:()=>({call:async()=>{throw new TranscriptError('unavailable_language','Language unavailable',{available_languages:[{language:'en',name:'x'.repeat(140000)}]});}})});
  const wire=await response.arrayBuffer();assert(wire.byteLength<=256*1024);
  const rpc=JSON.parse(new TextDecoder().decode(wire));
  assert.equal(rpc.result.isError,true);assert.equal(rpc.result.structuredContent.error.code,'response_too_large');
});
