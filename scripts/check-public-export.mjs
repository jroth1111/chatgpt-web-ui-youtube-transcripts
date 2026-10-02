import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),findings=[];
const blockedDirs=new Set(['evidence','state','private-acquisition','outputs','work','.sites-runtime','.wrangler']);
const skipped=new Set(['.git','node_modules','.next','dist','coverage']);
const patterns=[/appg(?:prj|dep|ver)_[a-f0-9]{16,}/i,/plugin_asdk_app_sites_[a-f0-9]+/i,/\/Users\/[^/\s]+\//,/\/workspace\/scratch\//,/https:\/\/chatgpt\.com\/c\/[a-f0-9-]+/i,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(skipped.has(e.name))continue;const p=path.join(dir,e.name),relative=path.relative(root,p);if(spawnSync('git',['check-ignore','--quiet','--',relative],{cwd:root}).status===0)continue;if((await lstat(p)).isSymbolicLink()){findings.push(relative+' (symlink)');continue;}if(e.isDirectory()){if(blockedDirs.has(e.name))findings.push(relative+' (runtime/evidence directory)');else await walk(p);continue;}if(/\.env(?:\.|$)/.test(e.name)&&e.name!=='.env.example'||/\.(pem|key|p12|pfx|db|sqlite|sqlite3|log)$/.test(e.name)){findings.push(relative+' (private file type)');continue;}const text=await readFile(p,'utf8');if(patterns.some(re=>re.test(text)))findings.push(relative+' (deployment identifier, private path or key)');}}
await walk(root);
if(findings.length){console.error(JSON.stringify({public_export_check:'failed',files:findings}));process.exit(1);}
console.log(JSON.stringify({public_export_check:'passed',note:'Run a secret scanner separately; identifiers and known private file classes are checked here.'}));
