import { DEFAULT_JOB_LANGUAGE, reusableDefault, hasDefaultProof } from './caption-default.mjs';
import { SnapshotCache, digest, DATABASE_NOW_MS_SQL } from './snapshot-cache.mjs';
import { TranscriptError } from './transcript-errors.mjs';
import { videoIdFromInput, validateLanguage, canonicalUrl } from './youtube-extractor.mjs';
const utf8=new TextEncoder();
export const FAILURE_CODES=new Set(['access_restriction','no_captions','unavailable_video','unavailable_language','parsing_failure','network_failure','timeout','rate_limiting','response_too_large']);
const TRANSIENT=new Set(['network_failure','timeout','rate_limiting','parsing_failure']);
const CYCLE_COOLDOWN_MS=15*60*1000;
const pending=(seconds=10)=>new TranscriptError('acquisition_pending','A private acquisition job is pending. Retry this video later to reuse its saved snapshot.',{retry_after_seconds:Math.max(10,seconds)},true);
export function validateCaptionResult(raw,id,lang) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.video_id!==id||raw.source_url!==canonicalUrl(id)||!Array.isArray(raw.segments)||!raw.segments.length||raw.segments.length>100000)throw new TranscriptError('invalid_input','Invalid caption submission.');
  validateLanguage(raw.selected_language);
  if(!raw.selected_language||(lang&&raw.selected_language.toLowerCase()!==lang.toLowerCase()))throw new TranscriptError('invalid_input','Caption language does not match the job.');
  const segments=raw.segments.map(s=>{
    if(!s||typeof s.text!=='string'||!s.text.trim()||utf8.encode(s.text).length>48000||!Number.isFinite(s.start)||s.start<0||!Number.isFinite(s.duration)||s.duration<0||!['upstream','unspecified'].includes(s.duration_source))throw new TranscriptError('invalid_input','Invalid caption segment.');
    return {text:s.text,start:s.start,duration:s.duration,duration_source:s.duration_source};
  });
  if(segments.some((s,i)=>i>0&&s.start<segments[i-1].start)||utf8.encode(JSON.stringify(segments)).length>8*1024*1024)throw new TranscriptError('invalid_input','Caption ordering or size is invalid.');
  const result={video_id:id,source_url:canonicalUrl(id),segments,selected_language:raw.selected_language,content_trust:'untrusted_data',translation:false,
    caption_type:['auto_generated','manual','unknown'].includes(raw.caption_type)?raw.caption_type:'unknown',
    completeness:'available_caption_track_only; speech completeness is not established',caption_availability:'available',
    caption_coverage_end_seconds:segments.reduce((end,s)=>Math.max(end,s.start+s.duration),0)};
  for(const key of ['title','author','track_id','name','language','retrieved_at','extractor_version','extraction_method']) {
    const value=raw[key];if(value!==null&&value!==undefined&&(typeof value!=='string'||value.length>1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))throw new TranscriptError('invalid_input','Invalid caption metadata.');
    if(value!==undefined)result[key]=value;
  }
  if(!result.track_id||!result.extractor_version||!['innertube/timedtext/xml','innertube/timedtext/srv3','innertube/timedtext/json3','innertube/timedtext/vtt','web/timedtext/xml','web/timedtext/srv3','web/timedtext/json3','web/timedtext/vtt','web/transcript_panel'].includes(result.extraction_method)||!Number.isFinite(Date.parse(result.retrieved_at)))throw new TranscriptError('invalid_input','Caption provenance is incomplete.');
  if(raw.video_duration_seconds!==null&&raw.video_duration_seconds!==undefined){if(!Number.isFinite(raw.video_duration_seconds)||raw.video_duration_seconds<0)throw new TranscriptError('invalid_input','Invalid duration.');result.video_duration_seconds=raw.video_duration_seconds;}
  if(raw.languages!==undefined){if(!Array.isArray(raw.languages)||raw.languages.length>300)throw new TranscriptError('invalid_input','Invalid language metadata.');result.languages=raw.languages.map(track=>{
    if(!track||typeof track.language!=='string'||typeof track.track_id!=='string'||track.track_id.length>1024||typeof track.name!=='string'||track.name.length>1024)throw new TranscriptError('invalid_input','Invalid language metadata.');validateLanguage(track.language);
    return {language:track.language,track_id:track.track_id,name:track.name,caption_type:['manual','auto_generated','unknown'].includes(track.caption_type)?track.caption_type:'unknown',translation:false};
  });}
  if(raw.default_selection!==undefined){if(!raw.default_selection||typeof raw.default_selection!=='object'||Array.isArray(raw.default_selection))throw new TranscriptError('invalid_input','Invalid default selection.');result.default_selection=Object.fromEntries(['policy','language','track_id','basis'].map(k=>[k,raw.default_selection[k]]));if(!reusableDefault(result))throw new TranscriptError('invalid_input','Invalid default selection.');}
  return result;
}
export class AcquisitionQueue {
  constructor(db,{now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){this.db=db;this.now=now;this.sleep=sleep;this.cache=new SnapshotCache(db,{now});}
  async guarded(fn){try{return await fn();}catch(e){if(e instanceof TranscriptError)throw e;throw new TranscriptError('storage_unavailable','Acquisition storage is unavailable.',{},true);}}
  async enqueue(owner,id,lang){videoIdFromInput(id);validateLanguage(lang);const key=await digest(JSON.stringify([owner,id,lang?.toLowerCase()??DEFAULT_JOB_LANGUAGE])),claimKey=await digest(JSON.stringify([owner,id])),now=this.now();
    const metadataDenied=await this.guarded(()=>this.db.prepare("SELECT id FROM metadata_jobs WHERE owner_key=? AND resource_id=? AND kind='video_chapters' AND failure_code='access_restriction' LIMIT 1").bind(owner,id).first());if(metadataDenied)throw new TranscriptError('access_restriction','Prior explicit video metadata denial prevents caption acquisition.');
    if(lang===undefined){
      // A policy repair is not permission to retry a prior explicit denial.
      const denied=await this.guarded(()=>this.db.prepare("SELECT failure_code,next_attempt_ms FROM acquisition_jobs WHERE owner_key=? AND video_id=? AND lang_key='__default__' AND status='failed' AND failure_code IN ('access_restriction','no_captions','unavailable_video','response_too_large') LIMIT 1").bind(owner,id).first());
      if(denied){await this.guarded(()=>this.db.prepare("INSERT INTO acquisition_jobs (id,owner_key,video_id,lang_key,status,created_ms,next_attempt_ms,attempts,lease_expires,claim_key,failure_code) VALUES (?,?,?,?,'failed',?,?,0,0,?,?) ON CONFLICT(id) DO NOTHING").bind(key,owner,id,DEFAULT_JOB_LANGUAGE,now,denied.next_attempt_ms,claimKey,denied.failure_code).run());return key;}
    }
    // Only an authenticated request invokes enqueue. Background claims never
    // reset an exhausted transient cycle, and terminal denials never reset.
    await this.guarded(()=>this.db.prepare("INSERT INTO acquisition_jobs (id,owner_key,video_id,lang_key,status,created_ms,next_attempt_ms,attempts,lease_expires,claim_key) VALUES (?,?,?,?,'queued',?,?,0,0,?) ON CONFLICT(id) DO UPDATE SET status='queued',attempts=0,next_attempt_ms=excluded.next_attempt_ms,worker_id=NULL,token=NULL,failure_code=NULL,claim_key=excluded.claim_key WHERE acquisition_jobs.status='failed' AND acquisition_jobs.failure_code IN ('network_failure','timeout','rate_limiting','parsing_failure') AND acquisition_jobs.next_attempt_ms <= excluded.next_attempt_ms").bind(key,owner,id,lang?.toLowerCase()??DEFAULT_JOB_LANGUAGE,now,now,claimKey).run());return key;
  }
  async request(owner,id,lang,{budgetMs=35000}={}) {
    const key=await this.enqueue(owner,id,lang),deadline=this.now()+Math.min(35000,Math.max(0,budgetMs));
    while(true){const snapshot=await this.cache.latest(owner,id,lang);if(snapshot)return snapshot;
      const row=await this.guarded(()=>this.db.prepare('SELECT status,failure_code,next_attempt_ms FROM acquisition_jobs WHERE id = ?').bind(key).first());
      if(row?.status==='failed')throw new TranscriptError(FAILURE_CODES.has(row.failure_code)?row.failure_code:'network_failure','Private acquisition could not retrieve this video. No caption snapshot was stored.',TRANSIENT.has(row.failure_code)?{retry_after_seconds:Math.max(0,Math.ceil((row.next_attempt_ms-this.now())/1000)),transient_cycle_exhausted:true}:{},false);
      if(row?.next_attempt_ms>deadline)throw pending(Math.ceil((row.next_attempt_ms-this.now())/1000));
      if(this.now()>=deadline)throw pending();await this.sleep(Math.min(1000,deadline-this.now()));
    }
  }
  async claim(worker,{authValidUntil=Number.MAX_SAFE_INTEGER}={}){
    const now=this.now();
    // Expired workers are fenced before their job can be reclaimed.
    await this.guarded(()=>this.db.prepare(`UPDATE acquisition_jobs SET status = CASE WHEN attempts < 3 THEN 'queued' ELSE 'failed' END, failure_code = 'timeout', next_attempt_ms = CASE WHEN attempts < 3 THEN ? ELSE ? END, lease_expires = 0 WHERE status = 'leased' AND lease_expires <= ${DATABASE_NOW_MS_SQL} AND ? > ${DATABASE_NOW_MS_SQL}`).bind(now,now+CYCLE_COOLDOWN_MS,authValidUntil).run());
    const row=await this.guarded(()=>this.db.prepare(`SELECT * FROM acquisition_jobs AS jobs WHERE status = 'queued' AND next_attempt_ms <= ? AND NOT EXISTS (SELECT 1 FROM transcript_claims WHERE request_key=jobs.claim_key AND expires_at > ${DATABASE_NOW_MS_SQL}) ORDER BY created_ms,id LIMIT 1`).bind(now).first());
    if(!row)return null;
    const lang=['__default__',DEFAULT_JOB_LANGUAGE].includes(row.lang_key)?undefined:row.lang_key;
    const saved=await this.cache.latest(row.owner_key,row.video_id,lang);
    if(saved){await this.guarded(()=>this.db.prepare("UPDATE acquisition_jobs SET status='complete',snapshot_id=? WHERE id=? AND status='queued'").bind(saved.id,row.id).run());return null;}
    let claim,lease;
    try{
      claim=await this.cache.claim(row.owner_key,row.video_id,{authValidUntil});lease=await this.cache.lease({authValidUntil});
      const result=await this.guarded(()=>this.db.prepare(`UPDATE acquisition_jobs SET status='leased',worker_id=?,token=?,claim_key=?,global_slot=?,global_token=?,lease_expires=?,attempts=attempts+1 WHERE id=? AND status='queued' AND next_attempt_ms <= ? AND ? > ${DATABASE_NOW_MS_SQL}`).bind(worker,claim.token,claim.key,lease.slot,lease.token,now+55000,row.id,now,authValidUntil).run());
      if(result.meta?.changes!==1){await claim();await lease();return null;}
      await this.guarded(()=>this.db.batch([
        this.db.prepare('UPDATE transcript_claims SET expires_at=? WHERE request_key=? AND token=?').bind(now+55000,claim.key,claim.token),
        this.db.prepare('UPDATE extractor_leases SET expires_at=? WHERE slot=? AND token=?').bind(now+55000,lease.slot,lease.token)
      ]));
      return {job_id:row.id,token:claim.token,video_id:row.video_id,...(lang?{lang}:{}),owner_namespace:await digest(row.owner_key),...(lang===undefined&&await this.cache.ambiguous(row.owner_key,row.video_id)?{resolve_default:true}:{}),lease_expires:now+55000};
    }catch(e){if(claim)await claim().catch(()=>{});if(lease)await lease().catch(()=>{});if(['service_busy','extraction_in_progress'].includes(e.code))return null;throw e;}
  }
  async submit(worker,input,{authValidUntil=Number.MAX_SAFE_INTEGER}={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['job_id','token','transcript','selection','failure_code','retry_not_before_ms'].includes(k))||!/^[a-f0-9]{64}$/.test(input.job_id??'')||!/^[a-f0-9-]{36}$/.test(input.token??'')||[input.transcript,input.selection,input.failure_code].filter(Boolean).length!==1)throw new TranscriptError('invalid_input','Invalid job submission.');
    if(input.retry_not_before_ms!==undefined&&(!Number.isSafeInteger(input.retry_not_before_ms)||input.retry_not_before_ms<0||!input.failure_code))throw new TranscriptError('invalid_input','Invalid retry deadline.');
    const row=await this.guarded(()=>this.db.prepare('SELECT * FROM acquisition_jobs WHERE id=?').bind(input.job_id).first());
    if(!row||row.worker_id&&row.worker_id!==worker)throw new TranscriptError('forbidden','The submission does not belong to this worker claim.');
    if(row.worker_id!==worker||row.token!==input.token)throw new TranscriptError('claim_expired','The worker claim has been replaced.');
    // A successful receipt is replayable without rewriting/refetching captions.
    if(row.status==='complete')return {status:'complete',snapshot_id:row.snapshot_id,replayed:true};
    if(['queued','failed'].includes(row.status)&&input.failure_code===row.failure_code)return {status:row.status,replayed:true};
    if(row.status!=='leased'||row.lease_expires<=this.now())throw new TranscriptError('claim_expired','The worker claim has expired.');
    const lang=['__default__',DEFAULT_JOB_LANGUAGE].includes(row.lang_key)?undefined:row.lang_key;
    if(input.selection){
      const selection=input.selection;if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(k=>!['selected_language','track_id','default_selection'].includes(k))||typeof selection.track_id!=='string'||!selection.track_id||selection.track_id.length>1024)throw new TranscriptError('invalid_input','Invalid cached-track selection.');
      validateLanguage(selection.selected_language);if(!selection.selected_language||lang!==undefined&&selection.selected_language.toLowerCase()!==lang.toLowerCase()||lang===undefined&&!hasDefaultProof(selection))throw new TranscriptError('invalid_input','Cached-track selection does not match this job.');
      const cached=await this.cache.sameTrack(row.owner_key,row.video_id,selection.selected_language,selection.track_id);
      if(!cached)return {status:'needs_captions'};
      // This command can only reference a track in its already claimed owner's
      // video. It returns a receipt, never cached caption text to the worker.
      return this.cache.commitAcquisition(row.owner_key,{...selection,video_id:row.video_id},lang,row,authValidUntil);
    }
    if(input.transcript){const transcript=validateCaptionResult(input.transcript,row.video_id,lang);if(lang===undefined&&(!reusableDefault(transcript)||!hasDefaultProof(transcript)&&await this.cache.ambiguous(row.owner_key,row.video_id)))throw new TranscriptError('invalid_input','Default caption selection requires upstream resolution. Update the Mac worker; existing snapshots remain available by language.');return this.cache.commitAcquisition(row.owner_key,transcript,lang,row,authValidUntil);}
    if(!FAILURE_CODES.has(input.failure_code))throw new TranscriptError('invalid_input','Unsupported acquisition failure.');
    const code=input.failure_code,status=TRANSIENT.has(code)&&row.attempts<3?'queued':'failed',next=Math.max(this.now()+(status==='failed'&&TRANSIENT.has(code)?CYCLE_COOLDOWN_MS:30000),input.retry_not_before_ms??0);
    const done="id=? AND worker_id=? AND token=? AND status=? AND failure_code=? AND lease_expires=0";
    const changes=await this.guarded(()=>this.db.batch([
      this.db.prepare(`UPDATE acquisition_jobs SET status=?,failure_code=?,snapshot_id=NULL,next_attempt_ms=?,lease_expires=0 WHERE id=? AND status='leased' AND worker_id=? AND token=? AND lease_expires>${DATABASE_NOW_MS_SQL} AND ?>${DATABASE_NOW_MS_SQL}`).bind(status,code,next,row.id,worker,row.token,authValidUntil),
      this.db.prepare(`DELETE FROM transcript_claims WHERE request_key=? AND token=? AND EXISTS (SELECT 1 FROM acquisition_jobs WHERE ${done})`).bind(row.claim_key,row.token,row.id,worker,row.token,status,code),
      this.db.prepare(`DELETE FROM extractor_leases WHERE slot=? AND token=? AND EXISTS (SELECT 1 FROM acquisition_jobs WHERE ${done})`).bind(row.global_slot,row.global_token,row.id,worker,row.token,status,code)
    ]));
    if(changes[0]?.meta?.changes!==1){const receipt=await this.guarded(()=>this.db.prepare('SELECT status,failure_code,token,worker_id FROM acquisition_jobs WHERE id=?').bind(row.id).first());if(receipt?.token===row.token&&receipt.worker_id===worker&&receipt.failure_code===code&&['queued','failed'].includes(receipt.status))return {status:receipt.status,replayed:true};throw new TranscriptError('claim_expired','The submission lost its lease.');}
    return {status,replayed:false};
  }
}
