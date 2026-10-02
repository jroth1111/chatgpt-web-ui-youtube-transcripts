// Synthetic isolated workerd/D1 checks. No production credentials or upstream fetch.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {SnapshotCache} from '../lib/snapshot-cache.mjs';
import {cleanTranscript} from '../lib/transcript-markdown.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),root=await mkdtemp(path.join(tmpdir(),'fulltext-workerd-'));
const ids=Array.from({length:10},(_,i)=>`fulltext_${String(i).padStart(2,'0')}`),owner='service:mcp';
const fixture=(id,count,wide=false)=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:'synthetic-runtime',extraction_method:'synthetic',segments:Array.from({length:count},(_,i)=>({text:wide?`Cue ${i} ${'字幕🦜 "\\*'.repeat(18)}.`:`Complete cue ${i}.`,start:i*2,duration:1}))});
const source=`import {handleMcp} from ${JSON.stringify(path.join(project,'lib/mcp-handler.mjs'))};
import {creatorTranscripts} from ${JSON.stringify(path.join(project,'lib/creator-transcripts.mjs'))};
import {TranscriptService} from ${JSON.stringify(path.join(project,'lib/transcript-service.mjs'))};
const service=db=>new TranscriptService(db,{extractorFactory:()=>{throw new Error('UNEXPECTED_UPSTREAM_FETCH');}});
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/mcp')return handleMcp(request,env,{serviceFactory:service});
 const input=await request.json(),result=await creatorTranscripts(service(env.DB),env.DB,input,${JSON.stringify(owner)},{catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:${JSON.stringify([...ids,'creatorid00','creatorid01'])}.map(id=>({id})),continuation:null})})});
 const {markdown,...state}=result;return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:markdown}],structuredContent:state,isError:false}});
}};`;
const receipt={kind:'isolated_workerd_D1',network:'synthetic_only_no_YouTube',safe_response_budget_bytes:240*1024,transport_ceiling_bytes:256*1024,checks:[],measured_bytes:{}};
let mf;
try{
 await build({stdin:{contents:source,resolveDir:project},outfile:path.join(root,'worker.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022'});
 mf=new Miniflare({cf:false,modules:true,modulesRoot:root,scriptPath:path.join(root,'worker.mjs'),compatibilityDate:'2026-05-15',d1Databases:{DB:'full-text-synthetic'},bindings:{MCP_AUTH_KEY:'fixture'.repeat(8)}});
 const db=await mf.getD1Database('DB'),cache=new SnapshotCache(db);await db.exec((await readFile(path.join(project,'tests/schema-fixture.sql'),'utf8')).split('\n').filter(line=>!line.trim().startsWith('--')).join('\n'));
 for(let i=0;i<ids.length;i++)await cache.write(owner,fixture(ids[i],i===1?717:898));
 for(const id of ['creatorid00','creatorid01'])await cache.write(owner,fixture(id,717));
 const call=async(args,name='get_transcripts',id=1)=>{const response=await mf.dispatchFetch('https://synthetic.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:('Bearer '+'fixture'.repeat(8))},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});const text=await response.text();assert(Buffer.byteLength(text)<=256*1024);const rpc=JSON.parse(text);assert.equal(rpc.result.isError,false);return {rpc,bytes:Buffer.byteLength(text)};};
 const mixed=ids.map((id,i)=>i%3===0?id:i%3===1?`https://youtu.be/${id}?si=synthetic`:`https://youtube.com/watch?v=${id}&t=1`);
 const full=await call({videos:mixed});assert.equal(full.rpc.result.structuredContent.success_count,10);assert(full.rpc.result.structuredContent.results.every(x=>x.delivery==='full'&&!x.has_more&&x.next_cursor===null));assert.deepEqual(full.rpc.result.structuredContent.results.map(x=>x.returned_segment_count),ids.map((_,i)=>i===1?717:898));receipt.measured_bytes.ten_full_fit=full.bytes;
 const repeat=await call({videos:ids});assert.deepEqual(repeat.rpc.result.structuredContent.results.map(x=>x.segment_hash),full.rpc.result.structuredContent.results.map(x=>x.segment_hash));assert(repeat.rpc.result.structuredContent.results.every(x=>x.cache_status==='hit'));receipt.checks.push('898_717_complete_ten_mixed_inputs_stable_snapshot_hash_cache_no_refetch');
 const wideId='widevideo00',wide=fixture(wideId,1400,true);wide.segments[119]={text:'one two three four',start:238,duration:4};wide.segments[120]={text:'two three four five',start:239,duration:3};await cache.write(owner,wide);
 let page=await call({videos:[wideId]}),texts=[],pages=0;assert.equal(page.rpc.result.structuredContent.results[0].overflow_reason,'whole_response_output_budget');receipt.measured_bytes.overflow_first=page.bytes;
 while(true){pages++;const result=page.rpc.result,meta=result.structuredContent;assert(page.bytes<=240*1024);texts.push(result.content[0].text.split(/Language: [^\n]*\n\n/)[1].split(/\n\n\*\*(?:More captions remain|Transcript snapshot complete)/)[0]);if(!meta.has_more)break;page=await call({videos:[wideId],next_cursors:meta.next_cursors});}
 assert.equal(texts.join(' ').replace(/\s+/g,' ').trim(),cleanTranscript(wide.segments,{rolling:true}).replace(/\s+/g,' ').trim());receipt.overflow_pages=pages;receipt.checks.push('overflow_continuation_reconstructs_cleaned_content_ASR_boundary');
 const mixedFailure=await call({videos:[wideId,ids[0],'missingid00']},'get_transcripts','🦜'.repeat(1000));assert.equal(mixedFailure.rpc.result.structuredContent.status,'partial');assert.equal(mixedFailure.rpc.result.structuredContent.results[0].delivery,'paged');assert.equal(mixedFailure.rpc.result.structuredContent.results[1].delivery,'full');receipt.measured_bytes.mixed_unicode_escaped= mixedFailure.bytes;receipt.checks.push('mixed_failure_oversize_isolation_and_whole_unicode_JSON_envelope');
 const creator=async args=>{const text=await (await mf.dispatchFetch('https://synthetic.example/creator',{method:'POST',body:JSON.stringify(args)})).text();assert(Buffer.byteLength(text)<=240*1024);return {rpc:JSON.parse(text),bytes:Buffer.byteLength(text)};};
 const input={creator_url:'https://www.youtube.com/@Synthetic',limit:7},created=await creator(input),replayed=await creator(input);assert(created.rpc.result.structuredContent.results.every(x=>x.delivery==='full'&&!x.has_more));assert.equal(replayed.rpc.result.structuredContent.replayed,true);assert.equal(created.rpc.result.content[0].text,replayed.rpc.result.content[0].text);receipt.measured_bytes.creator_full=created.bytes;
 const custom={...input,limit:12},firstCreator=await creator(custom);assert(firstCreator.rpc.result.structuredContent.creator_cursor);const cursor=firstCreator.rpc.result.structuredContent.creator_cursor,lastCreator=await creator({...custom,creator_cursor:cursor}),replayedCursor=await creator({...custom,creator_cursor:cursor});assert.equal(replayedCursor.rpc.result.structuredContent.replayed,true);assert.equal(lastCreator.rpc.result.content[0].text,replayedCursor.rpc.result.content[0].text);receipt.checks.push('creator_full_default_custom_limit_cursor_replay');
 receipt.status='passed';receipt.recorded_at=new Date().toISOString();await writeFile(path.join(project,'work/full-text-runtime-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
