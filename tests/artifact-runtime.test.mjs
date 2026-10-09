import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkArtifact} from '../scripts/check-artifact-runtime.mjs';

async function fixture(version='99.1.0'){
 const project=await mkdtemp(path.join(tmpdir(),'artifact-regression-')),artifact=path.join(project,'dist');
 await mkdir(path.join(project,'lib'),{recursive:true});await mkdir(path.join(artifact,'server'),{recursive:true});
 await writeFile(path.join(project,'package.json'),JSON.stringify({version:'99.1.0'}));await writeFile(path.join(project,'lib/version.mjs'),"export const SOFTWARE_VERSION='99.1.0';\n");
 await writeFile(path.join(artifact,'server/wrangler.json'),JSON.stringify({main:'index.js',compatibility_date:'2026-06-18',compatibility_flags:['nodejs_compat']}));
 await writeFile(path.join(artifact,'server/index.js'),`const version=${JSON.stringify(version)};export default {async fetch(request){const rpc=await request.json();let result;if(rpc.method==='initialize')result={serverInfo:{version}};else if(rpc.method==='tools/list')result={tools:Array.from({length:10},()=>({name:'fixture'}))};else{const value={software_version:version,error:{code:'invalid_input',retryable:false,message:'Fixture rejection [software_version='+version+']'}};result={isError:true,structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};}return Response.json({jsonrpc:'2.0',id:rpc.id,result});}};`);
 return {project,artifact,dispose:()=>rm(project,{recursive:true,force:true})};
}
test('artifact gate executes packaged Worker and rejects stale code despite current source',async()=>{const f=await fixture('99.0.0');try{await assert.rejects(checkArtifact({...f,write:true}),/stale\/wrong version/);}finally{await f.dispose();}});
test('artifact gate requires a manifest after executing a matching Worker',async()=>{const f=await fixture();try{await assert.rejects(checkArtifact(f),/Missing\/invalid verified artifact manifest/);}finally{await f.dispose();}});
test('artifact gate records and independently rechecks exact packaged bytes',async()=>{const f=await fixture();try{const first=await checkArtifact({...f,write:true}),again=await checkArtifact(f);assert.equal(first.artifact_sha256,again.artifact_sha256);assert.equal(first.software_version,'99.1.0');}finally{await f.dispose();}});
test('artifact gate rejects changed packaged bytes without overwriting its prior manifest',async()=>{const f=await fixture();try{await checkArtifact({...f,write:true});const file=path.join(f.artifact,'.openai/artifact-manifest.json'),before=await readFile(file,'utf8');await writeFile(path.join(f.artifact,'server/index.js'),(await readFile(path.join(f.artifact,'server/index.js'),'utf8'))+'\n// changed packaged bytes\n');await assert.rejects(checkArtifact(f),/Artifact manifest/);assert.equal(await readFile(file,'utf8'),before);}finally{await f.dispose();}});
test('artifact gate rejects source changes after a build',async()=>{const f=await fixture();try{await checkArtifact({...f,write:true});await writeFile(path.join(f.project,'lib/version.mjs'),"export const SOFTWARE_VERSION='99.1.0';\n// changed source\n");await assert.rejects(checkArtifact(f),/Artifact manifest/);}finally{await f.dispose();}});
test('artifact gate rejects an entrypoint outside packaged server files',async()=>{const f=await fixture();try{await writeFile(path.join(f.artifact,'server/wrangler.json'),JSON.stringify({main:'../../lib/version.mjs'}));await assert.rejects(checkArtifact({...f,write:true}),/escapes/);}finally{await f.dispose();}});
test('artifact gate rejects a symlinked package dependency',async()=>{const f=await fixture();try{await symlink(path.join(f.project,'lib/version.mjs'),path.join(f.artifact,'server/escape.mjs'));await assert.rejects(checkArtifact({...f,write:true}),/symlink/);}finally{await f.dispose();}});
test('artifact gate rejects a symlinked manifest without overwriting its target',async()=>{const f=await fixture();try{await mkdir(path.join(f.artifact,'.openai'));const target=path.join(f.project,'retained.json');await writeFile(target,'retained');await symlink(target,path.join(f.artifact,'.openai/artifact-manifest.json'));await assert.rejects(checkArtifact({...f,write:true}),/symlink/);assert.equal(await readFile(target,'utf8'),'retained');}finally{await f.dispose();}});
test('artifact gate rejects a symlinked artifact root',async()=>{const f=await fixture();try{const link=path.join(f.project,'linked-dist');await symlink(f.artifact,link);await assert.rejects(checkArtifact({...f,artifact:link,write:true}),/root symlink/);}finally{await f.dispose();}});
