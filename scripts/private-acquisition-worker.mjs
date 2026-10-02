import { MetadataExtractor, metadataInput, validateMetadata } from '../lib/youtube-metadata.mjs';
import { DEFAULT_POLICY, reusableDefault, hasDefaultProof } from '../lib/caption-default.mjs';
// Local-only entry point. Do not put private keys or transcripts in source control.
import { mkdir, readFile, writeFile, readdir, link, unlink, stat, open, rename } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { YouTubeExtractor, validateLanguage, retryAfterSeconds } from '../lib/youtube-extractor.mjs';
import { TranscriptError } from '../lib/transcript-errors.mjs';
import { signingMessage } from '../lib/acquisition-handler.mjs';
import { FAILURE_CODES, validateCaptionResult } from '../lib/acquisition-queue.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const origin=process.env.YOUTUBE_MCP_ORIGIN??'https://youtube-transcripts.example.com';
const originUrl=new URL(origin);
if(originUrl.protocol!=='https:'||originUrl.username||originUrl.password||originUrl.pathname!=='/'||originUrl.search||originUrl.hash)throw new Error('YOUTUBE_MCP_ORIGIN must be an HTTPS origin without credentials, path, query or fragment.');
// Keep private state outside source control and synced source folders.
const defaultRoot=process.env.YOUTUBE_WORKER_ROOT??path.join(homedir(),'.local','share','youtube-transcripts','private-acquisition');
if(!path.isAbsolute(defaultRoot))throw new Error('YOUTUBE_WORKER_ROOT must be an absolute path.');
const TERMINAL=new Set(['access_restriction','no_captions','unavailable_video','unavailable_language','response_too_large']);
export class WorkerAccessError extends Error {constructor(status){super('Worker authorization or access was denied.');this.status=status;this.terminal=true;}}
function retryDeadline(error,now){
  const absolute=error.details?.retry_not_before_ms;if(absolute!==undefined)return Number.isSafeInteger(absolute)&&absolute>=0?absolute:Number.MAX_SAFE_INTEGER;
  const seconds=error.details?.retry_after_seconds;if(seconds==null)return undefined;
  const deadline=now+seconds*1000;
  // Unsupported instructions leave the individual job deferred, never shorten them.
  return Number.isSafeInteger(seconds)&&seconds>=0&&Number.isSafeInteger(deadline)?deadline:Number.MAX_SAFE_INTEGER;
}
async function durablePublish(directory,destination,record,replace=false){
  await mkdir(directory,{recursive:true,mode:0o700});const temporary=path.join(directory,`${randomUUID()}.tmp`),file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
  let published=true;
  try{if(replace)await rename(temporary,destination);else await link(temporary,destination);}catch(e){if(!replace&&e.code==='EEXIST')published=false;else throw e;}finally{await unlink(temporary).catch(()=>{});}
  const folder=await open(directory,'r');try{await folder.sync();}finally{await folder.close();}return published;
}
export async function createWorkerIdentity(root=defaultRoot){
  await mkdir(root,{recursive:true,mode:0o700});
  const keyPath=path.join(root,'private-key.pem'),publicPath=path.join(root,'public-key.json');
  let existing;try{existing=await readFile(keyPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){if((await stat(keyPath)).mode&0o077)throw new Error('Worker key must not be group/world accessible.');const publicHex=createPublicKey(createPrivateKey(existing)).export({type:'spki',format:'der'}).subarray(-32).toString('hex'),identity={public_key:publicHex,worker_id:sha(publicHex)};
    let prior;try{prior=JSON.parse(await readFile(publicPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(prior&&prior.public_key!==publicHex)throw new Error('Worker identity mismatch.');
    if(!prior)await writeFile(publicPath,JSON.stringify(identity),{mode:0o600,flag:'wx'});return identity;
  }
  try{await stat(publicPath);throw new Error('Public identity exists without its private key; explicit recovery is required.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const pem=privateKey.export({type:'pkcs8',format:'pem'}),publicHex=publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  // Never overwrite a worker identity during crash recovery.
  await writeFile(keyPath,pem,{mode:0o600,flag:'wx'});
  await writeFile(publicPath,JSON.stringify({public_key:publicHex,worker_id:sha(publicHex)}),{mode:0o600,flag:'wx'});
  return {public_key:publicHex,worker_id:sha(publicHex)};
}
export function signedRequest(privateKey,route,input,{now=Date.now(),nonce=randomUUID(),base=origin}={}){
  const body=JSON.stringify(input),digest=sha(body),time=String(now);
  const signature=sign(null,Buffer.from(signingMessage(route,time,nonce,digest)),privateKey).toString('base64url');
  return new Request(base+route,{method:'POST',headers:{'content-type':'application/json','x-acquisition-time':time,'x-acquisition-nonce':nonce,'x-acquisition-digest':digest,'x-acquisition-signature':signature},body});
}
export const METADATA_CAPABILITIES=Object.freeze(['playlist_page','video_chapters']);
export class PrivateWorker {
  constructor({root=defaultRoot,privateKey,fetchImpl=fetch,extractorFactory=null,metadataExtractorFactory=null,sleep=null,now=()=>Date.now(),base=origin}={}){
    this.root=root;this.privateKey=privateKey;this.fetch=fetchImpl;this.now=now;this.base=base;this.stopped=false;this.abort=new AbortController();this.apiNotBefore=0;
    this.sleep=sleep??(ms=>delay(ms,undefined,{signal:this.abort.signal}));
    this.metadataExtractorFactory=metadataExtractorFactory??(()=>new MetadataExtractor({now:this.now,fetchImpl:(url,init)=>{if(this.stopped)throw new WorkerAccessError(0);return fetch(url,{...init,signal:AbortSignal.any([init.signal,this.abort.signal])});}}));
    this.extractorFactory=extractorFactory??(()=>new YouTubeExtractor({fetchImpl:(url,init)=>{if(this.stopped)throw new WorkerAccessError(0);return fetch(url,{...init,signal:AbortSignal.any([init.signal,this.abort.signal])});}}));
  }
  stop(){this.stopped=true;this.abort.abort();}
  async api(route,input){
    if(this.stopped)throw new WorkerAccessError(0);
    while(this.now()<this.apiNotBefore){await this.sleep(Math.min(300000,this.apiNotBefore-this.now()));if(this.stopped)throw new WorkerAccessError(0);}
    if(this.stopped)throw new WorkerAccessError(0);
    const request=signedRequest(this.privateKey,route,input,{now:this.now(),base:this.base});
    const response=await this.fetch(request,{signal:AbortSignal.any([AbortSignal.timeout(12000),this.abort.signal]),redirect:'manual'});
    // No redirects, auth challenges, arbitrary remote code, or secret-bearing errors in logs.
    if([401,403,451].includes(response.status)||response.status>=300&&response.status<400){await response.body?.cancel();this.stop();throw new WorkerAccessError(response.status);}
    if(response.status===429){const seconds=retryAfterSeconds(response.headers.get('retry-after'),this.now());this.apiNotBefore=Math.max(this.apiNotBefore,retryDeadline({details:{retry_after_seconds:seconds??30}},this.now()));}
    if(!response.ok){await response.body?.cancel();throw new Error(`worker_http_${response.status}`);}
    const reader=response.body?.getReader(),parts=[];let size=0;if(reader)while(true){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>65536){await reader.cancel();throw new Error('worker_response_bound');}parts.push(c.value);}
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  async localResult(job){
    if(!/^[a-f0-9]{64}$/.test(job.owner_namespace??'')||!/^[a-f0-9]{64}$/.test(job.job_id??'')||!/^[A-Za-z0-9_-]{11}$/.test(job.video_id??''))throw new Error('invalid_worker_job');validateLanguage(job.lang);
    const directory=path.join(this.root,'snapshots',job.owner_namespace);await mkdir(directory,{recursive:true,mode:0o700});
    // Language aliases reuse an original snapshot; never refetch a stored success.
    const savedTracks=[];
    for(const name of (await readdir(directory)).sort())if(name.startsWith(`${job.video_id}.`)&&name.endsWith('.json')){
      let record;try{record=JSON.parse(await readFile(path.join(directory,name),'utf8'));}catch{throw new Error('local_snapshot_corrupt');}
      if(!Array.isArray(record.transcript?.segments)||record.segment_sha256!==sha(JSON.stringify(record.transcript.segments)))throw new Error('local_snapshot_corrupt');
      savedTracks.push(record.transcript);

    }
    const knownLanguages=new Set(savedTracks.flatMap(t=>[t.selected_language,...(Array.isArray(t.languages)?t.languages.map(l=>l.language):[])]).filter(l=>typeof l==='string').map(l=>l.toLowerCase()));
    for(const saved of savedTracks){if(job.lang===undefined?hasDefaultProof(saved)||!job.resolve_default&&knownLanguages.size<=1&&reusableDefault(saved):saved.selected_language?.toLowerCase()===job.lang.toLowerCase())return {transcript:validateCaptionResult(saved,job.video_id,job.lang),local_cache:'hit'};}
    const failures=path.join(this.root,'outcomes',job.owner_namespace),scoped=path.join(failures,`${job.video_id}.${job.lang?.toLowerCase()??'default'}.json`),denial=path.join(failures,`${job.video_id}.access-denial.json`);
    for(const saved of [denial,scoped]){
      let prior;try{prior=JSON.parse(await readFile(saved,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw new Error('local_outcome_corrupt');}
      if(!FAILURE_CODES.has(prior.failure_code)||typeof prior.terminal!=='boolean'||prior.retry_not_before_ms!==undefined&&(!Number.isSafeInteger(prior.retry_not_before_ms)||prior.retry_not_before_ms<0))throw new Error('local_outcome_corrupt');
      if(prior.terminal||prior.retry_not_before_ms>this.now())throw new TranscriptError(prior.failure_code,'Saved acquisition outcome.',{...(prior.retry_not_before_ms!==undefined?{retry_not_before_ms:prior.retry_not_before_ms}:{})});
    }
    if(this.stopped)throw new WorkerAccessError(0);
    let result;try{result=await this.extractorFactory().transcript(job.video_id,job.lang,{reuseTrack:async selected=>{
      const saved=savedTracks.find(t=>t.track_id===selected.track_id&&t.selected_language?.toLowerCase()===selected.selected_language.toLowerCase());
      if(saved)return {...saved,...(selected.default_selection?{default_selection:selected.default_selection}:{}),languages:selected.languages};
      // Resolve existing Sites tracks through this claimed job, without reading
      // cached captions or downloading the same successful track again.
      if(job.token&&this.privateKey){const selection={selected_language:selected.selected_language,track_id:selected.track_id,...(selected.default_selection?{default_selection:selected.default_selection}:{})};const receipt=await this.api('/api/acquisition/submit',{job_id:job.job_id,token:job.token,selection});if(receipt.status==='complete')return {reuse_receipt:receipt};if(receipt.status!=='needs_captions')throw new Error('invalid_selection_receipt');}
      return null;
    }});}catch(error){
      if(this.stopped)throw new WorkerAccessError(0);
      if(FAILURE_CODES.has(error.code)){
        const deadline=retryDeadline(error,this.now()),terminal=TERMINAL.has(error.code);
        if(terminal||deadline!==undefined){const record={failure_code:error.code,terminal,...(deadline!==undefined?{retry_not_before_ms:deadline}:{})};await durablePublish(failures,error.code==='access_restriction'?denial:scoped,record,true);}
      }
      throw error;
    }
    if(this.stopped)throw new WorkerAccessError(0);
    if(result.reuse_receipt)return {receipt:result.reuse_receipt,local_cache:'site_hit'};
    const transcript=validateCaptionResult(result,job.video_id,job.lang);
    if(job.lang===undefined&&!reusableDefault(transcript))throw new TranscriptError('parsing_failure','Default caption language could not be verified.');
    const record={transcript,segment_sha256:sha(JSON.stringify(transcript.segments))};
    const destination=path.join(directory,`${job.video_id}.${transcript.selected_language.toLowerCase()}${job.lang===undefined?'.'+DEFAULT_POLICY:''}.json`);
    if(!(await durablePublish(directory,destination,record))){const existing=JSON.parse(await readFile(destination,'utf8'));if(!Array.isArray(existing.transcript?.segments)||existing.segment_sha256!==sha(JSON.stringify(existing.transcript.segments)))throw new Error('local_snapshot_corrupt');return {transcript:validateCaptionResult(existing.transcript,job.video_id,job.lang),local_cache:'hit'};}
    return {transcript,local_cache:'miss'};
  }
  async localMetadata(job){
    if(!/^[a-f0-9]{64}$/.test(job.job_id??'')||!/^[a-f0-9]{64}$/.test(job.owner_namespace??''))throw new Error('invalid_worker_job');
    const input=metadataInput(job.job_type,job.input),directory=path.join(this.root,'metadata',job.owner_namespace);await mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,`${job.job_id}.json`);let record;
    try{record=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('local_metadata_corrupt');}
    if(record){if(record.failure_code){if(!FAILURE_CODES.has(record.failure_code)||typeof record.terminal!=='boolean'||record.retry_not_before_ms!==undefined&&(!Number.isSafeInteger(record.retry_not_before_ms)||record.retry_not_before_ms<0))throw new Error('local_metadata_corrupt');if(record.terminal||record.retry_not_before_ms>this.now())throw new TranscriptError(record.failure_code,'Saved metadata outcome.',{...(record.retry_not_before_ms!==undefined?{retry_not_before_ms:record.retry_not_before_ms}:{})});record=null;}if(record&&record.sha256!==sha(JSON.stringify(record.metadata)))throw new Error('local_metadata_corrupt');if(record)return {metadata:validateMetadata(job.job_type,record.metadata,input),local_cache:'hit'};}
    const outcomes=path.join(this.root,'outcomes',job.owner_namespace),denial=path.join(outcomes,`${input.video_id??'playlist-'+input.playlist_id}.access-denial.json`);
    try{const saved=JSON.parse(await readFile(denial,'utf8'));if(saved.failure_code!=='access_restriction'||saved.terminal!==true)throw new Error('local_outcome_corrupt');throw new TranscriptError('access_restriction','Saved explicit resource denial.');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(this.stopped)throw new WorkerAccessError(0);
    let metadata;try{metadata=await this.metadataExtractorFactory().acquire(job.job_type,input);}catch(e){if(this.stopped)throw new WorkerAccessError(0);const retry=retryDeadline(e,this.now());if(TERMINAL.has(e.code)||retry!==undefined)await durablePublish(directory,file,{failure_code:e.code,terminal:TERMINAL.has(e.code),...(retry!==undefined?{retry_not_before_ms:retry}:{})},true);if(e.code==='access_restriction')await durablePublish(outcomes,denial,{failure_code:e.code,terminal:true},true);throw e;}
    metadata=validateMetadata(job.job_type,metadata,input);await durablePublish(directory,file,{metadata,sha256:sha(JSON.stringify(metadata))},true);return {metadata,local_cache:'miss'};
  }
  async once(){
    const {job}=await this.api('/api/acquisition/claim',{capabilities:METADATA_CAPABILITIES});if(!job)return {status:'idle'};
    if(typeof job.token!=='string'||!Number.isFinite(job.lease_expires)||job.lease_expires<=this.now())throw new Error('invalid_worker_claim');
    let result;
    try{result=job.job_type?await this.localMetadata(job):await this.localResult(job);}catch(error){
      if(!FAILURE_CODES.has(error.code))throw error;const deadline=retryDeadline(error,this.now());result={failure_code:error.code,...(deadline!==undefined?{retry_not_before_ms:deadline}:{})};
    }
    if(result.receipt)return {video_id:job.video_id,status:result.receipt.status,local_cache:result.local_cache,snapshot_id:result.receipt.snapshot_id,failure_code:null};
    // Persistence precedes submission. Lost/expired submissions reuse the local snapshot.
    const payload={job_id:job.job_id,token:job.token,...(job.job_type?{job_type:job.job_type}:{}),...(result.metadata?{metadata:result.metadata}:result.transcript?{transcript:result.transcript}:{failure_code:result.failure_code,...(result.retry_not_before_ms!==undefined?{retry_not_before_ms:result.retry_not_before_ms}:{})})};
    let receipt;
    for(let attempt=0;attempt<2;attempt++){try{receipt=await this.api('/api/acquisition/submit',payload);break;}catch(error){if(error.terminal||attempt===1||this.now()+2000>=job.lease_expires||/worker_http_(?:400|401|403|409|413|429)/.test(error.message))throw error;await this.sleep(1000);}}
    return {video_id:job.video_id??job.input?.video_id??null,...(job.job_type?{job_type:job.job_type,playlist_id:job.input?.playlist_id??null}:{}),status:receipt.status,local_cache:result.local_cache??null,snapshot_id:receipt.snapshot_id??null,failure_code:result.failure_code??null};
  }
  async run({onReceipt=()=>{}}={}){
    let reported=false;const loop=async()=>{while(!this.stopped){try{const receipt=await this.once();if(receipt.status==='idle')await this.sleep(10000);else onReceipt(receipt);}catch(error){if(error.terminal){this.stop();if(!reported){reported=true;onReceipt({status:'worker_authentication_or_access_denied',http_status:error.status});}break;}if(this.stopped)break;onReceipt({status:'worker_transport_or_storage_failure'});try{await this.sleep(Math.min(300000,Math.max(30000,this.apiNotBefore-this.now())));}catch{if(this.stopped)break;}}}};
    await Promise.all([loop(),loop()]);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--init'))console.log(JSON.stringify(await createWorkerIdentity()));
  else{
    if(!process.env.YOUTUBE_MCP_ORIGIN)throw new Error('Set YOUTUBE_MCP_ORIGIN before starting the worker.');
    const keyPath=path.join(defaultRoot,'private-key.pem');if((await stat(keyPath)).mode&0o077)throw new Error('Worker key must not be group/world accessible.');
    const privateKey=createPrivateKey(await readFile(keyPath,'utf8')),worker=new PrivateWorker({privateKey});
    process.on('SIGTERM',()=>worker.stop());process.on('SIGINT',()=>worker.stop());
    const report=async receipt=>{await mkdir(defaultRoot,{recursive:true,mode:0o700});await writeFile(path.join(defaultRoot,`receipt-${Date.now()}-${randomUUID()}.json`),JSON.stringify({recorded_at:new Date().toISOString(),...receipt}),{mode:0o600,flag:'wx'});};
    await worker.run({onReceipt:receipt=>{void report(receipt).catch(()=>{});}});
  }
}
