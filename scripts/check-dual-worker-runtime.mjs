// Owned isolated workerd+D1, synthetic keys generated in memory only.
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {dualWorkerRegressions} from './dual-worker-regressions.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),root=await mkdtemp(path.join(tmpdir(),'dual-worker-workerd-'));
const source=`import {handleAcquisition} from ${JSON.stringify(path.join(project,'lib/acquisition-handler.mjs'))};
import {handleMcp} from ${JSON.stringify(path.join(project,'lib/mcp-handler.mjs'))};
let config={};export default {async fetch(request,env){const path=new URL(request.url).pathname;
if(path==='/synthetic-config'){config=await request.json();return Response.json({ok:true});}
return path==='/mcp'?handleMcp(request,{...env,...config,ACQUISITION_MODE:'private_mac'}):handleAcquisition(request,{...env,...config});}};`;
let mf;
try{
 await build({stdin:{contents:source,resolveDir:project},outfile:path.join(root,'worker.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022'});
 mf=new Miniflare({cf:false,modules:true,modulesRoot:root,scriptPath:path.join(root,'worker.mjs'),compatibilityDate:'2026-05-15',d1Databases:{DB:'dual-worker-synthetic'},bindings:{MCP_AUTH_KEY:'fixture'.repeat(8)}});
 const db=await mf.getD1Database('DB');await db.exec((await readFile(path.join(project,'tests/schema-fixture.sql'),'utf8')).split('\n').filter(line=>!line.trim().startsWith('--')).join('\n'));
 const invoke=async request=>mf.dispatchFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body:await request.arrayBuffer()});
 const result=await dualWorkerRegressions({db,invoke,setConfig:async config=>{assert.equal((await mf.dispatchFetch('https://synthetic.example/synthetic-config',{method:'POST',body:JSON.stringify(config)})).status,200);}});
 const response=await mf.dispatchFetch('https://synthetic.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:('Bearer '+'fixture'.repeat(8))},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_transcripts',arguments:{videos:['dualvideo01']}}})});
 const text=await response.text();assert(Buffer.byteLength(text)<=245760);const rpc=JSON.parse(text);assert.equal(rpc.result.isError,false);const metadata=rpc.result.structuredContent.results[0];assert.equal(metadata.acquisition_context,'private_signed_worker');assert.equal(metadata.acquisition_worker_id,result.secondaryId);assert.equal(metadata.snapshot_id,result.serverSnapshotId);assert.equal(metadata.cache_status,'hit');assert.equal(metadata.delivery,'full');assert.equal(metadata.has_more,false);assert(!JSON.stringify(rpc.result.structuredContent).includes('Synthetic trusted-worker captions'));
 const receipt={kind:'isolated_workerd_D1',status:'passed',network:'synthetic_only_no_production_or_YouTube',checks:[...result.checks,'optimized_MCP_full_text_attested_worker_provenance'],response_bytes:Buffer.byteLength(text),schema_changes:[],recorded_at:new Date().toISOString()};
 await writeFile(path.join(project,'work/dual-worker-runtime-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
