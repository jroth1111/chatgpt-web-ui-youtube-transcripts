import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {contained,inventory,sourceDigest,finalizeManifest} from './artifact-support.mjs';

export async function checkArtifact({project=process.cwd(),artifact=path.join(project,'dist'),write=false}={}){
 project=path.resolve(project);artifact=path.resolve(artifact);
 // Reject escaping links before reading or executing any packaged code.
 await inventory(artifact);
 const version=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version;
 const sourceVersion=(await readFile(path.join(project,'lib/version.mjs'),'utf8')).match(/SOFTWARE_VERSION\s*=\s*['"]([^'"]+)/)?.[1];
 assert.equal(sourceVersion,version,'Source/package versions differ');
 const server=path.join(artifact,'server'),config=JSON.parse(await readFile(path.join(server,'wrangler.json'),'utf8'));
 const main=contained(server,path.resolve(server,config.main));
 assert(/\.(?:m?js)$/.test(main),'Worker entrypoint must be a packaged ES module');
 const files=await inventory(server),names=Object.keys(files).filter(x=>/\.(?:m?js)$/.test(x)),entry=path.relative(server,main).split(path.sep).join('/');
 assert(names.includes(entry),'Declared Worker entrypoint is absent');
 // Explicit modules include dynamic RSC/SSR imports. Never rebuild/rebundle
 // source here: execute the exact bytes selected by the deployment config.
 const modules=await Promise.all([entry,...names.filter(x=>x!==entry)].map(async name=>({type:'ESModule',path:path.join(server,name),contents:await readFile(path.join(server,name),'utf8')})));
 let outbound=0;const key='artifact-fixture'.repeat(4);
 const mf=new Miniflare({cf:false,modules,modulesRoot:server,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,d1Databases:{DB:'artifact-fixture'},bindings:{MCP_AUTH_KEY:key},outboundService:()=>{outbound++;throw Error('Artifact checks must not acquire external data');}});
 try{
  const call=async(method,params)=>{const response=await mf.dispatchFetch('https://artifact.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(response.status,200);return (await response.json()).result;};
  const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'artifact-fixture',version:'1'}});
  assert.equal(init?.serverInfo?.version,version,'Packaged Worker runs a stale/wrong version');
  const listed=await call('tools/list',{});assert.equal(listed?.tools?.length,10,'Packaged tool inventory differs');
  const error=await call('tools/call',{name:'get_transcript',arguments:{url:'https://invalid.example/no-video'}});
  assert.equal(error?.isError,true);assert.equal(error?.structuredContent?.error?.code,'invalid_input');assert.equal(error.structuredContent.error.retryable,false);
  assert.equal(error.structuredContent.software_version,version);
  const text=JSON.parse(error.content[0].text);assert.equal(text.software_version,version);assert(text.error.message.endsWith('[software_version='+version+']'),'Packaged error route is stale');
  assert.equal(outbound,0,'Artifact check attempted external acquisition');
 }finally{await mf.dispose();}
 const inputs=['app','lib','db','build','scripts','drizzle','.openai/hosting.json','package.json','package-lock.json','vite.config.ts','next.config.ts','tsconfig.json'];
 return finalizeManifest(project,artifact,{software_version:version,entrypoint:'server/'+entry,source_sha256:await sourceDigest(project,inputs),runtime_checks:['compiled_initialize_version','compiled_ten_tool_inventory','compiled_error_version_and_semantics','zero_external_acquisition']},{write});
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 try{const result=await checkArtifact({write:process.argv.includes('--write-manifest')});console.log(JSON.stringify(result));}catch(error){console.error('Artifact runtime check failed:',error.message);process.exitCode=1;}
}
