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
import {creatorUrl} from '../lib/creator-catalog.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),root=await mkdtemp(path.join(tmpdir(),'fulltext-workerd-'));
const ids=Array.from({length:10},(_,i)=>`fulltext_${String(i).padStart(2,'0')}`),owner='service:mcp';
const wideIds=Array.from({length:10},(_,i)=>`widecrea_${String(i).padStart(2,'0')}`);
const fixture=(id,count,wide=false)=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'auto_generated',extractor_version:'synthetic-runtime',extraction_method:'synthetic',segments:Array.from({length:count},(_,i)=>({text:wide?`Cue ${i} ${'字幕🦜 "\\*'.repeat(18)}.`:`Complete cue ${i}.`,start:i*2,duration:1}))});
const source=`import {handleMcp} from ${JSON.stringify(path.join(project,'lib/mcp-handler.mjs'))};
import {creatorTranscripts} from ${JSON.stringify(path.join(project,'lib/creator-transcripts.mjs'))};
import {TranscriptService} from ${JSON.stringify(path.join(project,'lib/transcript-service.mjs'))};
const service=db=>new TranscriptService(db,{extractorFactory:()=>{throw new Error('UNEXPECTED_UPSTREAM_FETCH');}});
export default {async fetch(request,env){
 if(new URL(request.url).pathname==='/mcp')return handleMcp(request,env,{serviceFactory:service});
 try {
 const input=await request.json(),result=await creatorTranscripts(service(env.DB),env.DB,input,${JSON.stringify(owner)},{catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:(input.creator_url.includes('/@Wide')?${JSON.stringify(wideIds)}:${JSON.stringify([...ids,'creatorid00','creatorid01'])}).map(id=>({id})),continuation:null})})});
 const {markdown,...state}=result;return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:markdown}],structuredContent:state,isError:false}});
 } catch(error) {return Response.json({jsonrpc:'2.0',id:1,result:{isError:true,structuredContent:{error:{code:error.code??'unexpected'}}}});}
}};`;
const receipt={kind:'isolated_workerd_D1',network:'synthetic_only_no_YouTube',application_response_cap_bytes:null,checks:[],measured_bytes:{}};
let mf;
try{
 await build({stdin:{contents:source,resolveDir:project},outfile:path.join(root,'worker.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022'});
 mf=new Miniflare({cf:false,modules:true,modulesRoot:root,scriptPath:path.join(root,'worker.mjs'),compatibilityDate:'2026-05-15',d1Databases:{DB:'full-text-synthetic'},bindings:{MCP_AUTH_KEY:'fixture'.repeat(8)}});
 const db=await mf.getD1Database('DB'),cache=new SnapshotCache(db);await db.exec((await readFile(path.join(project,'tests/schema-fixture.sql'),'utf8')).split('\n').filter(line=>!line.trim().startsWith('--')).join('\n'));
 for(let i=0;i<ids.length;i++)await cache.write(owner,fixture(ids[i],i===1?717:898));
 for(const id of ['creatorid00','creatorid01'])await cache.write(owner,fixture(id,717));
 for(const id of wideIds)await cache.write(owner,fixture(id,1400,true));
 const call=async(args,name='get_transcripts',id=1)=>{const response=await mf.dispatchFetch('https://synthetic.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:('Bearer '+'fixture'.repeat(8))},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});const text=await response.text();const rpc=JSON.parse(text);assert.equal(rpc.result.isError,false);return {rpc,bytes:Buffer.byteLength(text)};};
 const mixed=ids.map((id,i)=>i%3===0?id:i%3===1?`https://youtu.be/${id}?si=synthetic`:`https://youtube.com/watch?v=${id}&t=1`);
 const full=await call({videos:mixed});assert.equal(full.rpc.result.structuredContent.success_count,10);assert(full.rpc.result.structuredContent.results.every(x=>x.delivery==='full'&&!x.has_more&&x.next_cursor===null));assert.deepEqual(full.rpc.result.structuredContent.results.map(x=>x.returned_segment_count),ids.map((_,i)=>i===1?717:898));receipt.measured_bytes.ten_full_fit=full.bytes;
 const repeat=await call({videos:ids});assert.deepEqual(repeat.rpc.result.structuredContent.results.map(x=>x.segment_hash),full.rpc.result.structuredContent.results.map(x=>x.segment_hash));assert(repeat.rpc.result.structuredContent.results.every(x=>x.cache_status==='hit'));receipt.checks.push('898_717_complete_ten_mixed_inputs_stable_snapshot_hash_cache_no_refetch');
 const wideId='widevideo00',wide=fixture(wideId,1400,true);wide.segments[119]={text:'one two three four',start:238,duration:4};wide.segments[120]={text:'two three four five',start:239,duration:3};await cache.write(owner,wide);
 const page=await call({videos:[wideId]}),result=page.rpc.result,r=result.structuredContent.results[0];assert.equal(r.delivery,'full');assert.equal(r.overflow_reason,null);assert.equal(r.returned_segment_count,1400);assert.equal(r.has_more,false);assert(page.bytes>256*1024);receipt.measured_bytes.uncapped_full=page.bytes;
 const text=result.content[0].text.split(/Language: [^\n]*\n\n/)[1].split(/\n\n\*\*(?:More captions remain|Transcript snapshot complete)/)[0];
 assert.equal(text.replace(/\s+/g,' ').trim(),cleanTranscript(wide.segments,{rolling:true}).replace(/\s+/g,' ').trim());receipt.checks.push('uncapped_complete_cleaned_content_ASR_boundary_one_call');
 const explicit=await call({videos:[wideId],delivery:'paged'});assert.equal(explicit.rpc.result.structuredContent.results[0].returned_segment_count,120);assert(explicit.rpc.result.structuredContent.has_more);const tail=await call({videos:[wideId],next_cursors:explicit.rpc.result.structuredContent.next_cursors});assert.equal(tail.rpc.result.structuredContent.results[0].returned_segment_count,1280);assert.equal(tail.rpc.result.structuredContent.results[0].delivery,'paged');assert.equal(tail.rpc.result.structuredContent.has_more,false);receipt.checks.push('explicit_paging_and_uncapped_continuation_tail_no_false_full_label');
 const mixedFailure=await call({videos:[wideId,ids[0],'missingid00']},'get_transcripts','🦜'.repeat(1000));assert.equal(mixedFailure.rpc.result.structuredContent.status,'partial');assert.equal(mixedFailure.rpc.result.structuredContent.results[0].delivery,'full');assert.equal(mixedFailure.rpc.result.structuredContent.results[1].delivery,'full');receipt.measured_bytes.mixed_unicode_escaped=mixedFailure.bytes;receipt.checks.push('mixed_failure_isolation_uncapped_unicode_JSON_envelope');
 const creator=async args=>{const text=await (await mf.dispatchFetch('https://synthetic.example/creator',{method:'POST',body:JSON.stringify(args)})).text();return {rpc:JSON.parse(text),bytes:Buffer.byteLength(text)};};
 const input={creator_url:'https://www.youtube.com/@Synthetic',limit:7},created=await creator(input),replayed=await creator(input);assert(created.rpc.result.structuredContent.results.every(x=>x.delivery==='full'&&!x.has_more));assert.equal(replayed.rpc.result.structuredContent.replayed,true);assert.equal(created.rpc.result.content[0].text,replayed.rpc.result.content[0].text);receipt.measured_bytes.creator_full=created.bytes;
 const custom={...input,limit:12},firstCreator=await creator(custom);assert(firstCreator.rpc.result.structuredContent.creator_cursor);const cursor=firstCreator.rpc.result.structuredContent.creator_cursor,lastCreator=await creator({...custom,creator_cursor:cursor}),replayedCursor=await creator({...custom,creator_cursor:cursor});assert.equal(replayedCursor.rpc.result.structuredContent.replayed,true);assert.equal(lastCreator.rpc.result.content[0].text,replayedCursor.rpc.result.content[0].text);receipt.checks.push('creator_full_default_custom_limit_cursor_replay');
 const largeInput={creator_url:'https://www.youtube.com/@Wide',limit:10},large=await creator(largeInput),largeReplay=await creator(largeInput);assert(large.bytes>2000000);assert.equal(large.rpc.result.structuredContent.success_count,10);assert(large.rpc.result.structuredContent.results.every(r=>r.delivery==='full'&&!r.has_more&&r.returned_segment_count===1400));assert.equal(largeReplay.rpc.result.structuredContent.replayed,true);assert.equal(largeReplay.rpc.result.content[0].text,large.rpc.result.content[0].text);const physical=await db.prepare('SELECT MAX(length(CAST(body AS BLOB))) AS bytes FROM creator_response_chunks').first();assert(physical.bytes>0&&physical.bytes<2000000);receipt.measured_bytes.creator_uncapped_ten=large.bytes;receipt.measured_bytes.largest_internal_replay_part=physical.bytes;receipt.checks.push('large_ten_creator_bodies_single_response_D1_chunked_exact_replay');
 for(const scenario of ['Expired','Skipped']){
  const input={creator_url:`https://www.youtube.com/@Wide${scenario}`,limit:10};
  const action=scenario==='Expired'?'UPDATE creator_jobs SET lease_expires=0 WHERE id=NEW.job_id;':'SELECT RAISE(IGNORE);';
  await db.exec(`CREATE TRIGGER replay_guard_fixture ${scenario==='Expired'?'AFTER':'BEFORE'} INSERT ON creator_response_chunks WHEN NEW.part=${scenario==='Expired'?0:1} BEGIN ${action} END;`);
  const failed=await creator(input);assert.equal(failed.rpc.result.isError,true);assert.equal(failed.rpc.result.structuredContent.error.code,'storage_unavailable');
  const job=await db.prepare('SELECT id,revision,lease_token FROM creator_jobs WHERE creator_url=?').bind(creatorUrl(input.creator_url)).first();assert(job);assert.equal(job.revision,0);assert.equal(job.lease_token,null);
  for(const table of ['creator_job_pages','creator_response_chunks'])assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id=?`).bind(job.id).first()).n,0);
  await db.exec('DROP TRIGGER replay_guard_fixture;');
  const recovered=await creator(input);assert.equal(recovered.rpc.result.isError,false);assert.equal(recovered.rpc.result.structuredContent.success_count,10);assert(recovered.rpc.result.structuredContent.results.every(r=>r.delivery==='full'&&!r.has_more));
  receipt.checks.push(`D1_atomic_${scenario.toLowerCase()}_conditional_replay_rollback_and_safe_recovery`);
 }
 receipt.status='passed';receipt.recorded_at=new Date().toISOString();await writeFile(path.join(project,'work/full-text-runtime-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
