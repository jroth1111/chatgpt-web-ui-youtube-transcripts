import {PrivateWorker} from './private-acquisition-worker.mjs';
import {mkdir,readFile,stat,open,rename} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

const root=process.env.YOUTUBE_WORKER_ROOT??'/state/profile';
if(!path.isAbsolute(root))throw new Error('YOUTUBE_WORKER_ROOT must be absolute.');
const health=path.join(root,'health.json'),latch=path.join(root,'authorization-stop.json');
if(process.argv.includes('--health-check')){
  try{const h=JSON.parse(await readFile(health,'utf8'));process.exit(h.status==='running'&&Date.now()-h.at<90000&&Date.now()-h.lastApiSuccess<90000?0:1);}catch{process.exit(1);}
}
if(!process.env.YOUTUBE_MCP_ORIGIN)throw new Error('Configure YOUTUBE_MCP_ORIGIN before starting.');
if(process.getuid?.()===0)throw new Error('Run the acquisition worker as an unprivileged user.');
await mkdir(root,{recursive:true,mode:0o700});
if((await stat(root)).mode&0o077)throw new Error('Worker profile must be private (0700).');
const keyFile=path.join(root,'private-key.pem');
if((await stat(keyFile)).mode&0o077)throw new Error('Worker private key must be private (0600).');
const key=createPrivateKey(await readFile(keyFile,'utf8'));
const publicHex=createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('hex');
const workerId=createHash('sha256').update(publicHex).digest('hex');
if(process.env.EXPECTED_WORKER_ID&&process.env.EXPECTED_WORKER_ID!==workerId)throw new Error('Worker identity mismatch; do not remint automatically.');
async function atomic(file,value){const temp=file+'.'+randomUUID()+'.tmp',handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}await rename(temp,file);const folder=await open(root,'r');try{await folder.sync();}finally{await folder.close();}}
let stopped=false;try{await stat(latch);stopped=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(stopped){
  await atomic(health,{status:'authorization_latched_stop',worker_id:workerId,at:Date.now(),lastApiSuccess:0});
  const timer=setInterval(()=>{},300000),done=new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  console.log(JSON.stringify({status:'authorization_latched_stop',worker_id:workerId}));
  await done;clearInterval(timer);
}else{
  let lastApiSuccess=0,denied=false,writes=Promise.resolve();
  const worker=new PrivateWorker({root,privateKey:key,fetchImpl:async(request,init)=>{const response=await fetch(request,init);if(response.ok)lastApiSuccess=Date.now();return response;}});
  process.once('SIGTERM',()=>worker.stop());process.once('SIGINT',()=>worker.stop());
  const status=()=>({status:denied?'authorization_latched_stop':Date.now()-lastApiSuccess<90000?'running':'transport_degraded',worker_id:workerId,at:Date.now(),lastApiSuccess});
  await atomic(health,{...status(),status:'starting'});
  const timer=setInterval(()=>{writes=writes.then(()=>atomic(health,status())).catch(()=>worker.stop());},30000);
  console.log(JSON.stringify({status:'worker_started',worker_id:workerId}));
  await worker.run({onReceipt:r=>{if(r.status==='worker_authentication_or_access_denied'){denied=true;writes=writes.then(()=>atomic(latch,{status:r.status,http_status:r.http_status,worker_id:workerId,at:Date.now()}));}const safe={...r,worker_id:workerId,at:new Date().toISOString()};writes=writes.then(()=>atomic(path.join(root,'receipt-'+Date.now()+'-'+randomUUID()+'.json'),safe));console.log(JSON.stringify(safe));}});
  clearInterval(timer);await writes;await atomic(health,{...status(),status:denied?'authorization_latched_stop':'stopped'});
}
