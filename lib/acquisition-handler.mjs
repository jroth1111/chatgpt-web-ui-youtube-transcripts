import { MetadataQueue } from './metadata-queue.mjs';
import { AcquisitionQueue } from './acquisition-queue.mjs';
import { digest, DATABASE_NOW_MS_SQL } from './snapshot-cache.mjs';
import { TranscriptError, safeError } from './transcript-errors.mjs';
const utf8=new TextEncoder(),routes=new Set(['/api/acquisition/claim','/api/acquisition/submit']);
export const signingMessage=(path,time,nonce,bodyHash)=>JSON.stringify(['youtube-acquisition-v1','POST',path,time,nonce,bodyHash]);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
async function bodyText(request,max,timeoutMs){const reader=request.body?.getReader(),parts=[];let size=0,timer,expired=false;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;void reader?.cancel().catch(()=>{});reject(new TranscriptError('unauthorized','Worker body read expired.'));},timeoutMs);});try{if(reader)while(true){const c=await Promise.race([reader.read(),timeout]);if(expired)throw new TranscriptError('unauthorized','Worker body read expired.');if(c.done)break;size+=c.value.length;if(size>max){await reader.cancel();throw new TranscriptError('response_too_large','Worker request exceeds the bound.');}parts.push(c.value);}const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new TranscriptError('invalid_input','Invalid UTF-8.');}}finally{clearTimeout(timer);}}
// At most two trusted keys. A pin restricts claims, never existing submissions.
export async function workerConfiguration(env) {
  const primary=env.ACQUISITION_PUBLIC_KEY,secondary=env.ACQUISITION_SECONDARY_PUBLIC_KEY,pin=env.ACQUISITION_CLAIM_WORKER_ID;
  if(typeof primary!=='string'||!/^[a-f0-9]{64}$/.test(primary))throw new TranscriptError('configuration_error','Worker primary public key is invalid.');
  if(secondary!==undefined&&(typeof secondary!=='string'||!/^[a-f0-9]{64}$/.test(secondary)||secondary===primary))throw new TranscriptError('configuration_error','Worker secondary public key must be valid and distinct.');
  const keys=await Promise.all([primary,...(secondary===undefined?[]:[secondary])].map(async publicKey=>({publicKey,workerId:await digest(publicKey)})));
  if(pin!==undefined&&(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin)||!keys.some(key=>key.workerId===pin)))throw new TranscriptError('configuration_error','Claim worker ID must belong to a trusted public key.');
  return {keys,pin};
}
export async function handleAcquisition(request,env,{now=()=>Date.now(),queueFactory=db=>new AcquisitionQueue(db,{now})}={}){
  try{
    const url=new URL(request.url),path=url.pathname;
    if(request.method!=='POST'||!routes.has(path)||url.search)return json({error:{code:'invalid_request'}},400);
    const origin=request.headers.get('origin');if(origin&&origin!==url.origin)throw new TranscriptError('forbidden','Cross-origin requests are rejected.');
    const {keys,pin}=await workerConfiguration(env);
    const time=request.headers.get('x-acquisition-time'),nonce=request.headers.get('x-acquisition-nonce'),signature=request.headers.get('x-acquisition-signature');
    const bodyHash=request.headers.get('x-acquisition-digest');
    if(!/^\d{13}$/.test(time??'')||Math.abs(now()-Number(time))>120000||!/^[a-f0-9-]{36}$/.test(nonce??'')||!/^[A-Za-z0-9_-]{86}$/.test(signature??''))throw new TranscriptError('unauthorized','Invalid worker authentication.');
    const authValidUntil=Number(time)+120000;
    const fresh=()=>{if(Math.abs(now()-Number(time))>120000)throw new TranscriptError('unauthorized','Worker authorization expired.');};
    if(!/^[a-f0-9]{64}$/.test(bodyHash??''))throw new TranscriptError('unauthorized','Invalid worker authentication.');
    if(!(request.headers.get('content-type')??'').startsWith('application/json'))throw new TranscriptError('invalid_input','JSON is required.');
    const imported=[];
    try{for(const trusted of keys)imported.push({...trusted,key:await crypto.subtle.importKey('raw',Uint8Array.from(trusted.publicKey.match(/../g),hex=>parseInt(hex,16)),{name:'Ed25519'},false,['verify'])});}
    catch{throw new TranscriptError('configuration_error','Worker public key could not be imported.');}
    const sig=Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    let worker;
    for(const trusted of imported)if(await crypto.subtle.verify('Ed25519',trusted.key,sig,utf8.encode(signingMessage(path,time,nonce,bodyHash)))){worker=trusted.workerId;break;}
    if(!worker)throw new TranscriptError('unauthorized','Invalid worker authentication.');
    fresh();const body=await bodyText(request,path.endsWith('/claim')?1024:9*1024*1024,Math.max(1,Math.min(20000,authValidUntil-now())));
    if(await digest(body)!==bodyHash)throw new TranscriptError('unauthorized','Worker body integrity check failed.');
    fresh();
    let input;try{input=JSON.parse(body);}catch{throw new TranscriptError('invalid_input','Malformed JSON.');}
    // A nonce is consumed even if its authenticated operation later fails.
    let inserted;
    fresh();try{inserted=await env.DB.prepare(`INSERT INTO acquisition_nonces (worker_id,nonce,expires_at) SELECT ?,?,? WHERE ?>${DATABASE_NOW_MS_SQL} ON CONFLICT(worker_id,nonce) DO NOTHING`).bind(worker,nonce,now()+300000,authValidUntil).run();}catch{throw new TranscriptError('storage_unavailable','Worker authentication storage is unavailable.',{},true);}
    if(inserted.meta?.changes!==1)throw new TranscriptError('unauthorized','Worker request was already used.');
    fresh();try{await env.DB.prepare('DELETE FROM acquisition_nonces WHERE expires_at < ?').bind(now()).run();}catch{throw new TranscriptError('storage_unavailable','Worker authentication storage is unavailable.',{},true);}
    const queue=queueFactory(env.DB);
    fresh();if(path.endsWith('/claim')){if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>k!=='capabilities')||input.capabilities!==undefined&&(!Array.isArray(input.capabilities)||input.capabilities.length>2||new Set(input.capabilities).size!==input.capabilities.length||input.capabilities.some(k=>!['playlist_page','video_chapters'].includes(k))))throw new TranscriptError('invalid_input','Claims take an empty object or bounded metadata capabilities.');if(pin!==undefined&&worker!==pin)return json({job:null,idle_reason:'claim_worker_pinned'});const caption=await queue.claim(worker,{authValidUntil});return json({job:caption??(input.capabilities?.length?await new MetadataQueue(env.DB,{now}).claim(worker,input.capabilities,{authValidUntil}):null)});}
    return json(await (input?.job_type?new MetadataQueue(env.DB,{now}):queue).submit(worker,input,{authValidUntil}));
  }catch(e){const error=safeError(e);return json({error},e.code==='unauthorized'?401:e.code==='forbidden'?403:e.code==='claim_expired'?409:['storage_unavailable','configuration_error'].includes(e.code)?503:e.code==='response_too_large'?413:400);}
}
