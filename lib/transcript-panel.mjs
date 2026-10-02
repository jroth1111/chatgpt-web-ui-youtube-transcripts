// Independent implementation of YouTube's advertised transcript-panel flow.
// Protocol ideas: LuanRT/YouTube.js, MIT; see ATTRIBUTION.md.
import { TranscriptError } from './transcript-errors.mjs';

function fail(message) { throw new TranscriptError('parsing_failure', message); }
export function assertNoAccessDenial(data) {
  const message='YouTube returned an explicit access challenge or denial.';
  if(typeof data==='string') {
    const html=/^\s*(?:<!doctype\s+html|<(?:html|head|body|title|div|form)\b)/i.test(data);
    const challenge=/class\s*=\s*["'][^"']*\bg-recaptcha\b|(?:action|src|href)\s*=\s*["'][^"']*\/sorry\/index|<title>\s*(?:access denied|captcha(?: challenge| verification)?|consent(?: required)?|before you continue(?: to youtube)?)(?:\s*[-|]\s*youtube)?\s*<\/title>/i;
    if((html&&challenge.test(data))||/^\s*sign in to confirm[^\n]*not a bot/i.test(data))throw new TranscriptError('access_restriction',message);
    return;
  }
  if([401,403,451].includes(Number(data?.error?.code))||['LOGIN_REQUIRED','AGE_CHECK_REQUIRED'].includes(data?.playabilityStatus?.status)||/sign in|not a bot|access denied|captcha|consent/i.test(data?.error?.message??data?.playabilityStatus?.reason??''))throw new TranscriptError('access_restriction',message);
}
function seconds(value) {
  if(!(typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))||!Number.isFinite(Number(value))||Number(value)<0)fail('Invalid transcript-panel timing.');
  return Number(value)/1000;
}
function objects(root) {
  const result=[],stack=[{value:root,depth:0}];
  while(stack.length) {
    const {value,depth}=stack.pop();
    if(!value||typeof value!=='object')continue;
    if(depth>64||result.length>=20000)fail('Transcript panel exceeded the safe parsing bound.');
    result.push(value);
    for(const child of Object.values(value))if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});
  }
  return result;
}
export function inlineObject(html, tokens, accept=()=>true) {
  for(const token of tokens) {
    let offset=0;
    while((offset=html.indexOf(token,offset))>=0) {
      const start=html.indexOf('{',offset+token.length);offset+=token.length;
      if(start<0)break;
      let depth=0,quoted=false,escaped=false;
      for(let i=start;i<html.length;i++) {
        const c=html[i];
        if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
        if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){
          try{const value=JSON.parse(html.slice(start,i+1));if(accept(value))return value;break;}catch{break;}
        }
      }
    }
  }
  fail('No complete advertised transcript configuration could be parsed.');
}
function params(value) {
  if(typeof value!=='string'||!value.length||value.length>16384)fail('Invalid advertised transcript parameters.');
  return value;
}
function label(value) { return value?.simpleText??value?.runs?.map(run=>run.text??'').join(''); }
export function panelRequest(html) {
  const initial=inlineObject(html,['var ytInitialData =','window["ytInitialData"] =','window.ytInitialData =','ytInitialData =']);
  const panels=objects(initial).map(node=>node.engagementPanelSectionListRenderer).filter(panel=>panel?.panelIdentifier==='engagement-panel-searchable-transcript');
  const endpoints=panels.flatMap(panel=>objects(panel).filter(node=>node.getTranscriptEndpoint));
  if(endpoints.length!==1)fail('No unique advertised transcript endpoint was found.');
  const endpoint=endpoints[0],api=endpoint.commandMetadata?.webCommandMetadata?.apiUrl;
  if(api!==undefined&&api!=='/youtubei/v1/get_transcript')fail('Untrusted transcript API path was rejected.');
  const config=inlineObject(html,['ytcfg.set('],value=>Boolean(value.INNERTUBE_CONTEXT?.client));
  const client=config.INNERTUBE_CONTEXT?.client;
  if(client?.clientName!=='WEB'||typeof client.clientVersion!=='string'||!/^[\d.]{1,64}$/.test(client.clientVersion))fail('No supported advertised WEB client configuration was found.');
  return {params:params(endpoint.getTranscriptEndpoint.params),context:{client:{clientName:'WEB',clientVersion:client.clientVersion,
    ...(typeof client.visitorData==='string'&&client.visitorData.length<=8192?{visitorData:client.visitorData}: {})}}};
}
export function panelResponse(data, track) {
  assertNoAccessDenial(data);
  if(data?.error)fail('YouTube returned a transcript-panel API error.');
  const panels=objects(data).map(node=>node.transcriptSearchPanelRenderer).filter(Boolean);
  if(panels.length!==1)fail('No unique transcript search panel was returned.');
  const panel=panels[0],menus=objects(panel.footer).map(node=>node.sortFilterSubMenuRenderer).filter(Boolean);
  if(menus.length!==1||!Array.isArray(menus[0].subMenuItems))fail('Transcript language provenance could not be established.');
  const name=label(track.name)??track.languageCode;
  const matches=menus[0].subMenuItems.filter(item=>label(item.title)===name||item.title===name);
  if(matches.length!==1)fail('No unique transcript language matches the selected caption track.');
  const selected=menus[0].subMenuItems.filter(item=>item.selected);
  if(selected.length!==1)fail('No unique selected transcript language was returned.');
  if(selected[0]!==matches[0])return {continuation:params(matches[0].continuation?.reloadContinuationData?.continuation??matches[0].continuation)};
  const entries=panel.body?.transcriptSegmentListRenderer?.initialSegments;
  if(!Array.isArray(entries)||!entries.length)fail('Transcript panel contained no caption entries.');
  const segments=[];
  for(const entry of entries) {
    if(entry.transcriptSectionHeaderRenderer)continue;
    const cue=entry.transcriptSegmentRenderer;
    if(!cue)fail('Unsupported transcript entry or continuation; no partial transcript was accepted.');
    const text=label(cue.snippet),start=seconds(cue.startMs),end=seconds(cue.endMs);
    if(typeof text!=='string'||cue.startMs==null||cue.endMs==null||!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<start)fail('Invalid transcript-panel text or timing.');
    if(text.trim())segments.push({text,start,duration:end-start,duration_source:'upstream'});
  }
  if(!segments.length)fail('Transcript panel contained no non-empty captions.');
  segments.sort((a,b)=>a.start-b.start);
  return {segments,format:'transcript_panel'};
}
