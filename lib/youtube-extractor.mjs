// Adapted from sinco-lab/mcp-youtube-transcript, MIT, Copyright (c) 2024 Freddie.
// Upstream 5f0a92bdb2a770b940715d0b5d8e69483d5aa2b6; see vendor/sinco-lab/LICENSE.
import { resolveDefaultTrack, selectionProof } from './caption-default.mjs';
import { TranscriptError } from './transcript-errors.mjs';
import { panelRequest, panelResponse, assertNoAccessDenial } from './transcript-panel.mjs';

export const EXTRACTOR_VERSION = 'sinco-5f0a92b-sites-3';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const INPUT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);
const API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const WEB_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const ANDROID_VERSION = '20.10.38';
const MAX_BODY = 8 * 1024 * 1024;
export function videoIdFromInput(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new TranscriptError('invalid_input', 'Supply a YouTube URL or 11-character video ID.');
  input = input.trim(); if (VIDEO_ID.test(input)) return input;
  let u; try { u = new URL(input); } catch { throw new TranscriptError('invalid_input', 'Invalid YouTube URL.'); }
  if (u.protocol !== 'https:' || !INPUT_HOSTS.has(u.hostname) || u.username || u.password || u.port) throw new TranscriptError('invalid_input', 'Only HTTPS URLs on supported YouTube hosts are accepted.');
  const p = u.pathname.split('/').filter(Boolean);
  const id = u.hostname.endsWith('youtu.be') && p.length === 1 ? p[0] :
    u.pathname === '/watch' ? u.searchParams.get('v') :
    p.length === 2 && ['shorts','embed','live','v'].includes(p[0]) ? p[1] : null;
  if (!id || !VIDEO_ID.test(id)) throw new TranscriptError('invalid_input', 'No valid video ID in the YouTube URL.');
  return id;
}
export function validateLanguage(lang) {
  if (lang !== undefined && (typeof lang !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(lang))) throw new TranscriptError('invalid_input', 'Use an available language code such as en or en-US.');
}
export function canonicalUrl(id) { return `https://www.youtube.com/watch?v=${id}`; }
export function assertUpstream(raw, id) {
  let u; try { u = new URL(raw); } catch { throw new TranscriptError('parsing_failure', 'Invalid upstream destination.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['www.youtube.com','youtube.com'].includes(u.hostname)) throw new TranscriptError('parsing_failure', 'Untrusted upstream destination was rejected.');
  const allowed = ['/youtubei/v1/player', '/youtubei/v1/get_transcript', '/watch', '/api/timedtext', '/oembed'];
  if (!allowed.includes(u.pathname)) throw new TranscriptError('parsing_failure', 'Untrusted upstream path was rejected.');
  if (u.pathname === '/api/timedtext' && u.searchParams.get('v') !== id) throw new TranscriptError('parsing_failure', 'Caption URL does not match the requested video.');
  return u;
}
function decodeEntities(text) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, code) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? m;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : parseInt(code.slice(1),10);
    return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
  });
}
function stripTags(text) { return decodeEntities(text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')); }
function validateXml(body) {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new TranscriptError('parsing_failure','XML declarations with entities are not supported.');
  const stack=[];let root=0,last=0;
  const token=/<(?:\?[\s\S]*?\?|!--[\s\S]*?--|\/?[A-Za-z][^<>]*?)>/g;
  for(const match of body.matchAll(token)) {
    if(body.slice(last,match.index).includes('<'))throw new TranscriptError('parsing_failure','Incomplete XML tag.');
    last=match.index+match[0].length;const t=match[0];
    if(t.startsWith('<?')||t.startsWith('<!--'))continue;
    const name=t.match(/^<\/?([\w:-]+)/)?.[1];
    if(t.startsWith('</')){if(stack.pop()!==name)throw new TranscriptError('parsing_failure','Mismatched XML tags.');}
    else {if(!stack.length)root++;if(!t.endsWith('/>'))stack.push(name);}
  }
  if(stack.length||root!==1||body.slice(last).trim()||body.slice(0,body.indexOf('<')).trim())throw new TranscriptError('parsing_failure','Incomplete XML caption payload.');
}
function attrs(text) {
  return Object.fromEntries([...text.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1],m[2] ?? m[3]]));
}
function vttTime(s) {
  if (!/^(?:\d+:)?\d{2}:\d{2}\.\d{3}$/.test(s)) throw new TranscriptError('parsing_failure','Invalid VTT timestamp.');
  return s.split(':').reduce((n,p) => n * 60 + Number(p),0);
}
export function parseCaptionBody(body) {
  const trimmed = body.trim(); let segments = [], format;
  assertNoAccessDenial(trimmed);
  if (!trimmed) throw new TranscriptError('parsing_failure', 'YouTube returned an empty caption response. This does not establish that captions are absent.', {reason:'empty_caption_response'});
  try {
    if (trimmed.startsWith('{')) {
      format = 'json3'; const data = JSON.parse(trimmed);
      assertNoAccessDenial(data);
      if (!Array.isArray(data.events)) throw new Error('Missing events');
      segments = data.events.filter(e => Array.isArray(e.segs)).map(e => ({
        // JSON utf8 fields are already decoded; preserve literal entities and whitespace.
        text: e.segs.map(s => typeof s.utf8 === 'string' ? s.utf8 : '').join(''),
        start: Number(e.tStartMs) / 1000, duration: e.dDurationMs == null ? 0 : Number(e.dDurationMs) / 1000,
        duration_source: e.dDurationMs == null ? 'unspecified' : 'upstream'
      }));
    } else if (trimmed.startsWith('WEBVTT')) {
      format = 'vtt'; const lines = body.replace(/\r\n/g,'\n').split('\n');
      for (let i=0; i<lines.length; i++) {
        const m = lines[i].match(/^\s*(\S+)\s+-->\s+(\S+)/); if (!m) continue;
        const start = vttTime(m[1]), end = vttTime(m[2]); const text = [];
        while (++i < lines.length && lines[i] !== '') text.push(lines[i]);
        segments.push({ text: stripTags(text.join('\n')), start, duration: end-start, duration_source:'upstream' });
      }
    } else if (/<(?:timedtext|transcript)\b/.test(trimmed)) {
      validateXml(trimmed);
      const srv = /<p\b/.test(trimmed); format = srv ? 'srv3' : 'xml';
      const regex = srv ? /<p\b([^>]*)>([\s\S]*?)<\/p>/g : /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
      for (const m of body.matchAll(regex)) {
        const a = attrs(m[1]), d = srv ? a.d : a.dur;
        segments.push({text:stripTags(m[2]), start:Number(srv ? a.t : a.start)/(srv?1000:1), duration:d == null ? 0 : Number(d)/(srv?1000:1), duration_source:d==null?'unspecified':'upstream'});
      }
    } else { throw new Error('Unsupported caption payload'); }
  } catch (error) {
    if (error instanceof TranscriptError) throw error;
    throw new TranscriptError('parsing_failure', 'YouTube returned an unsupported or malformed caption payload.');
  }
  segments = segments.filter(s => s.text.trim().length);
  if (!segments.length) throw new TranscriptError('parsing_failure', 'Caption payload contained no non-empty caption segments.');
  if (segments.some(s => !Number.isFinite(s.start) || s.start < 0 || !Number.isFinite(s.duration) || s.duration < 0)) throw new TranscriptError('parsing_failure', 'Caption payload contained invalid timing.');
  // Do not remove rolling/overlapping text or repeated speech. Stable sort only.
  segments.sort((a,b)=>a.start-b.start);
  return {segments, format};
}
export function parsePlayerFromHtml(html) {
  for (const token of ['var ytInitialPlayerResponse =', 'window["ytInitialPlayerResponse"] =', 'window.ytInitialPlayerResponse =', 'ytInitialPlayerResponse =']) {
    const at = html.indexOf(token); if (at < 0) continue;
    const start = html.indexOf('{',at+token.length); if (start < 0) continue;
    let depth=0, quoted=false, escaped=false;
    for (let i=start;i<html.length;i++) {
      const c=html[i];
      if (quoted) { if(escaped)escaped=false; else if(c==='\\')escaped=true; else if(c==='"')quoted=false; continue; }
      if(c==='"')quoted=true; else if(c==='{')depth++; else if(c==='}' && --depth===0) {
        try {return JSON.parse(html.slice(start,i+1));} catch {break;}
      }
    }
  }
  throw new TranscriptError('parsing_failure', 'No complete player response could be parsed from the watch page.');
}
export function captionType(track) {
  if (track.kind === 'asr') return 'auto_generated';
  if (track.kind === 'manual' || track.isAutoGenerated === false) return 'manual';
  return 'unknown';
}
function trackName(track) { return track.name?.simpleText ?? track.name?.runs?.map(r=>r.text??'').join('') ?? track.languageCode; }
function trackInfo(track,index) {
  return { language:track.languageCode, name:trackName(track), caption_type:captionType(track),
    track_id:track.vssId ?? `track-${index}-${track.languageCode}-${track.kind??'unknown'}`, translation:false };
}
function inspectPlayer(data,source,id) {
  const status=data?.playabilityStatus?.status, reason=data?.playabilityStatus?.reason;
  if (status !== 'OK') {
    const restricted = status === 'LOGIN_REQUIRED' || status === 'AGE_CHECK_REQUIRED' || /sign in|bot|age|consent|region|country|restricted/i.test(reason??'');
    if (!status) throw new TranscriptError('parsing_failure','Upstream response lacks playability status.',{source});
    throw new TranscriptError(restricted?'access_restriction':'unavailable_video', restricted?'YouTube requires access or verification that this service cannot supply.':'YouTube reports that this video is unavailable.',{source,upstream_playability_status:status,upstream_reason:typeof reason==='string'?reason.slice(0,500):null});
  }
  const renderer=data.captions?.playerCaptionsTracklistRenderer;
  if (renderer?.captionTracks !== undefined && !Array.isArray(renderer.captionTracks)) throw new TranscriptError('parsing_failure','Invalid caption track list.',{source});
  const tracks=renderer?.captionTracks ?? [];
  if (tracks.length>300 || tracks.some(t=>typeof t.languageCode!=='string'||typeof t.baseUrl!=='string')) throw new TranscriptError('parsing_failure','Invalid or oversized caption track list.',{source});
  return {tracks, renderer:renderer??{}, source, details:data.videoDetails??{}, id, captions_absent:tracks.length===0};
}
export function retryAfterSeconds(value,now=Date.now()) {
  if (!value) return null;
  const seconds=/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value)-now)/1000;
  return Number.isFinite(seconds)?Math.max(0,Math.ceil(seconds)):null;
}
export class YouTubeExtractor {
  constructor({fetchImpl=fetch, now=()=>Date.now(), sleep=ms=>new Promise(r=>setTimeout(r,ms)), budgetMs=35000}={}) {
    this.fetchImpl=fetchImpl; this.now=now; this.sleep=sleep; this.deadline=now()+budgetMs; this.attempts=[]; this.httpCount=0;
  }
  async request(raw,init,id,stage) {
    assertUpstream(raw,id);
    for (let attempt=0;attempt<2;attempt++) {
      const remaining=this.deadline-this.now();
      if(remaining<=0||this.httpCount>=12) throw new TranscriptError('timeout','The bounded upstream request budget was exhausted.',{attempts:this.attempts},true);
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),Math.min(6000,remaining));
      try {
        this.httpCount++;
        const response=await this.fetchImpl(raw,{...init,redirect:'manual',signal:controller.signal});
        const retryAfter=retryAfterSeconds(response.headers.get('retry-after'),this.now());
        this.attempts.push({stage,attempt:attempt+1,http_status:response.status,retry_after_seconds:retryAfter});
        if(response.status>=300&&response.status<400) throw new TranscriptError('access_restriction','YouTube redirected the request; redirects are not followed.',{stage,http_status:response.status});
        if(response.status===429||response.status>=500) {
          const wait=(retryAfter??1)*1000;
          if(attempt===0&&wait<=2000&&this.now()+wait<this.deadline) { await response.body?.cancel(); await this.sleep(wait); continue; }
          throw new TranscriptError(response.status===429?'rate_limiting':'network_failure',response.status===429?'YouTube rate limited this request.':'YouTube returned a temporary server error.',{stage,http_status:response.status,retry_after_seconds:retryAfter},true);
        }
        if([401,403,451].includes(response.status)) throw new TranscriptError('access_restriction','YouTube rejected access from this service.',{stage,http_status:response.status});
        if([404,410].includes(response.status)) throw new TranscriptError(stage.includes('timedtext')?'parsing_failure':'unavailable_video',stage.includes('timedtext')?'The advertised caption resource is unavailable; video availability is not disproved.':'YouTube resource is unavailable.',{stage,http_status:response.status});
        if(!response.ok) throw new TranscriptError('network_failure','YouTube returned an unexpected HTTP status.',{stage,http_status:response.status});
        const reader=response.body?.getReader(); let size=0;const parts=[];
        if(reader) { while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new TranscriptError('response_too_large','Caption response exceeds the safe extraction bound. No transcript was truncated.');}parts.push(value);} }
        const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
        const body=new TextDecoder().decode(bytes);this.attempts[this.attempts.length-1].body_bytes=size;return body;
      } catch(error) {
        if(error instanceof TranscriptError)throw error;
        const timed=controller.signal.aborted;
        this.attempts.push({stage,attempt:attempt+1,network_outcome:timed?'timeout':'network_failure'});
        if(attempt===0&&this.now()+250<this.deadline) {await this.sleep(250);continue;}
        throw new TranscriptError(timed?'timeout':'network_failure',timed?'YouTube request timed out.':'Unable to reach YouTube from this service.',{stage},true);
      } finally {clearTimeout(timer);}
    }
  }
  async player(id,source) {
    let data,html;
    if(source==='innertube') {
      const body=await this.request(API_URL,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':`com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14)`},body:JSON.stringify({context:{client:{clientName:'ANDROID',clientVersion:ANDROID_VERSION}},videoId:id})},id,source);
      assertNoAccessDenial(body);
      try {data=JSON.parse(body);} catch{throw new TranscriptError('parsing_failure','InnerTube returned invalid JSON.',{source});}
    } else {
      html=await this.request(canonicalUrl(id),{headers:{'User-Agent':WEB_AGENT,'Accept-Language':'en-US,en;q=0.9'}},id,source);
      assertNoAccessDenial(html);
      data=parsePlayerFromHtml(html);
    }
    assertNoAccessDenial(data);
    return {...inspectPlayer(data,source,id),...(html?{html}: {})};
  }
  async transcriptPanel(id, p, track) {
    const request=panelRequest(p.html);
    for(let page=0;page<2;page++) {
      const body=await this.request('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false',{
        method:'POST',headers:{'Content-Type':'application/json','User-Agent':WEB_AGENT,'Origin':'https://www.youtube.com'},body:JSON.stringify(request)
      },id,'web/transcript_panel');
      assertNoAccessDenial(body);
      let data;try{data=JSON.parse(body);}catch{throw new TranscriptError('parsing_failure','Transcript panel returned invalid JSON.');}
      const result=panelResponse(data,track);
      if(result.segments)return result;
      request.params=result.continuation;
    }
    throw new TranscriptError('parsing_failure','Transcript language selection did not converge.');
  }
  async getTracks(id,{allowAbsent=false}={}) {
    const failures=[],absences=[];
    for(const source of ['innertube','web']) {
      try {const p=await this.player(id,source);if(p.tracks.length)return p;absences.push(p);}
      catch(e){failures.push(e);if(['access_restriction','rate_limiting'].includes(e.code))throw this.withAttempts(e);}
    }
    if(absences.length===2){if(allowAbsent)return {...absences[1],confirmed_absence:true};throw this.withAttempts(new TranscriptError('no_captions','Both successful player responses contained no caption tracks.',{confirmed:true}));}
    throw this.withAttempts(failures.find(e=>e.code==='access_restriction')??failures[0]??new TranscriptError('parsing_failure','Caption availability could not be established.'));
  }
  withAttempts(error) {error.details={...error.details,attempts:this.attempts};return error;}
  publicInfo(p) {
    return {video_id:p.id,source_url:canonicalUrl(p.id),title:p.details.title??null,author:p.details.author??null,
      video_duration_seconds:p.details.lengthSeconds?Number(p.details.lengthSeconds):null,
      languages:p.tracks.map(trackInfo),retrieved_at:new Date(this.now()).toISOString(),extraction_method:p.source,
      extractor_version:EXTRACTOR_VERSION,caption_availability:p.confirmed_absence?'confirmed_absent':'available',content_trust:'untrusted_data'};
  }
  async transcript(id,lang,{reuseTrack}={}) {
    validateLanguage(lang);const failures=[],absences=[];let timedtextParsingFailure=false;
    for(const source of ['innertube','web']) {
      try {
        const p=await this.player(id,source);if(!p.tracks.length){absences.push(source);continue;}
        const candidates=p.tracks.map((track,index)=>({track,index})).filter(x=>lang===undefined||x.track.languageCode.toLowerCase()===lang.toLowerCase());
        if(!candidates.length)throw new TranscriptError('unavailable_language','Requested caption language is not available.',{requested_language:lang,available_languages:p.tracks.map(trackInfo)});
        const chosen=lang===undefined?resolveDefaultTrack(p.tracks,p.renderer):candidates.find(x=>captionType(x.track)==='manual')??candidates[0];
        if(!chosen)throw new TranscriptError('parsing_failure','The upstream default caption language is missing or ambiguous. Supply an explicit language.',{reason:'ambiguous_default_language'});
        const defaultSelection=lang===undefined?{default_selection:selectionProof(chosen,trackInfo(chosen.track,chosen.index).track_id)}:{};
        if(reuseTrack){const reused=await reuseTrack({...this.publicInfo(p),...trackInfo(chosen.track,chosen.index),selected_language:chosen.track.languageCode,...defaultSelection});if(reused)return {...reused,...defaultSelection};}
        const base=assertUpstream(chosen.track.baseUrl,id);
        const urls=[base.toString(),...['json3','srv3','vtt'].map(fmt=>{const u=new URL(base);u.searchParams.set('fmt',fmt);return u.toString();})];
        const trackFailures=[];
        let panelTried=false;
        const panelTranscript=async()=>{
          panelTried=true;
          const parsed=await this.transcriptPanel(id,p,chosen.track);
          return {...this.publicInfo(p),...trackInfo(chosen.track,chosen.index),...defaultSelection,segments:parsed.segments,
            selected_language:chosen.track.languageCode,extraction_method:'web/transcript_panel',translation:false,
            caption_coverage_end_seconds:parsed.segments.reduce((end,s)=>Math.max(end,s.start+s.duration),0),
            completeness:'available_caption_track_only; speech completeness is not established',diagnostics:{attempts:this.attempts}};
        };
        // The advertised panel is ordinary recovery, never a route around denial.
        // On the WEB source, try it before repeating malformed timedtext formats.
        if(source==='web'&&timedtextParsingFailure) {
          try {
            return await panelTranscript();
          } catch(e) {if(['access_restriction','rate_limiting','timeout','response_too_large'].includes(e.code))throw e;trackFailures.push(e);}
        }
        for(const raw of [...new Set(urls)]) {
          try {
            const fmt=new URL(raw).searchParams.get('fmt')??'default';
            const body=await this.request(raw,{headers:{'User-Agent':WEB_AGENT,'Referer':'https://www.youtube.com/','Origin':'https://www.youtube.com'}},id,`${source}/timedtext/${fmt}`);
            let parsed;
            try {parsed=parseCaptionBody(body);}catch(e){if(e.code==='parsing_failure')timedtextParsingFailure=true;throw e;}
            return {...this.publicInfo(p),...trackInfo(chosen.track,chosen.index),...defaultSelection,segments:parsed.segments,
              selected_language:chosen.track.languageCode,extraction_method:`${source}/timedtext/${parsed.format}`,translation:false,
              caption_coverage_end_seconds:parsed.segments.reduce((end,s)=>Math.max(end,s.start+s.duration),0),
              completeness:'available_caption_track_only; speech completeness is not established',diagnostics:{attempts:this.attempts}};
          } catch(e) {trackFailures.push(e);if(['access_restriction','rate_limiting','timeout','response_too_large'].includes(e.code))throw e;}
        }
        if(source==='web'&&timedtextParsingFailure&&!panelTried) {
          try {return await panelTranscript();}
          catch(e) {if(['access_restriction','rate_limiting','timeout','response_too_large'].includes(e.code))throw e;trackFailures.push(e);}
        }
        throw trackFailures.find(e=>e.code==='access_restriction')??trackFailures[0];
      } catch(e) {failures.push(e);if(['access_restriction','unavailable_language','rate_limiting','timeout','response_too_large'].includes(e.code))throw this.withAttempts(e);}
    }
    if(absences.length===2)throw this.withAttempts(new TranscriptError('no_captions','Both successful player responses contained no caption tracks.',{confirmed:true}));
    throw this.withAttempts(failures.find(e=>e.code==='access_restriction')??failures[0]??new TranscriptError('parsing_failure','No caption track could be retrieved.'));
  }
}
