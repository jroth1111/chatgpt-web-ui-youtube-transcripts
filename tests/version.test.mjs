import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SOFTWARE_VERSION} from '../lib/version.mjs';
import {handleMcp} from '../lib/mcp-handler.mjs';
import {transcriptBatch,responseBytes} from '../lib/transcript-batch.mjs';
import {TranscriptError} from '../lib/transcript-errors.mjs';
test('package and MCP software versions cannot drift',()=>{
 assert.equal(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,SOFTWARE_VERSION);
 assert.match(readFileSync(new URL('../lib/mcp-handler.mjs',import.meta.url),'utf8'),/serverInfo:\{name:'youtube-transcripts',version:SOFTWARE_VERSION\}/);
});
test('all tool reply shapes expose software version; safe sizing includes it and the RPC ID',async()=>{
 const id='🦜'.repeat(1000),page={snapshot_id:'fixture',selected_language:'en',caption_type:'manual',page_index:0,page_count:1,first_segment_index:0,segment_count:1,returned_segment_count:1,segments:[{text:'Synthetic caption',start:0,duration:1}],has_more:false,next_cursor:null,cache_status:'hit'};
 const service={call:async()=>page},env={OWNER_EMAIL:'owner@example.test'};
 const call=async(name,serviceFactory=()=>service)=>{
  const request=new Request('https://private.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:name==='get_transcripts'?{videos:['versionvid0']}:{url:'versionvid0'}}})});
  const wire=await (await handleMcp(request,env,{serviceFactory})).text(),rpc=JSON.parse(wire);assert.equal(rpc.result.structuredContent.software_version,SOFTWARE_VERSION);assert(Buffer.byteLength(wire)<=256*1024);return wire;
 };
 await call('get_transcript');
 const wire=await call('get_transcripts'),batch=await transcriptBatch(service,{videos:['versionvid0']},'owner');assert.equal(Buffer.byteLength(wire),responseBytes(batch,id));
 await call('get_transcript',()=>({call:async()=>{throw new TranscriptError('no_captions','Synthetic failure');}}));
 await call('get_transcript',()=>({call:async()=>({text:'x'.repeat(140000)})}));
});
