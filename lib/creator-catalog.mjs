// Worker-native channel browse protocol; ideas inspected in YouTube.js Channel.
import { TranscriptError } from './transcript-errors.mjs';
import { inlineObject, assertNoAccessDenial } from './transcript-panel.mjs';
const CHANNEL=/^UC[A-Za-z0-9_-]{22}$/,VIDEO=/^[A-Za-z0-9_-]{11}$/;
const HOSTS=new Set(['youtube.com','www.youtube.com','m.youtube.com']);
const fail=message=>{throw new TranscriptError('parsing_failure',message);};
export function creatorUrl(input) {
  if(typeof input!=='string'||input.length>2048)throw new TranscriptError('invalid_input','Supply a YouTube creator URL.');
  let u;try{u=new URL(input.trim());}catch{throw new TranscriptError('invalid_input','Invalid creator URL.');}
  if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password||u.port)throw new TranscriptError('invalid_input','Creator URLs must be HTTPS on YouTube, without credentials or nonstandard ports.');
  const p=u.pathname.split('/').filter(Boolean);
  if(p.at(-1)==='videos')p.pop();
  try{for(let i=0;i<p.length;i++)p[i]=decodeURIComponent(p[i]);}catch{throw new TranscriptError('invalid_input','Invalid creator URL encoding.');}
  const valid=p.length===1&&/^@[\p{L}\p{N}_.-]{1,100}$/u.test(p[0])||p.length===2&&(p[0]==='channel'&&CHANNEL.test(p[1])||['c','user'].includes(p[0])&&/^[A-Za-z0-9_.-]{1,100}$/.test(p[1]));
  if(!valid)throw new TranscriptError('invalid_input','Use a YouTube @handle, /channel/UC..., /c/name or /user/name URL.');
  return `https://www.youtube.com/${p.map(part=>part.startsWith('@')?'@'+encodeURIComponent(part.slice(1)):encodeURIComponent(part)).join('/')}/videos`;
}
function nodes(root) {
  const found=[],stack=[{value:root,depth:0}];
  while(stack.length){const {value,depth}=stack.pop();if(!value||typeof value!=='object')continue;
    if(depth>64||found.length>=30000)fail('Creator response exceeded the safe parsing bound.');found.push(value);
    const values=Object.entries(value).filter(([key])=>!['adSlotRenderer','adPlacementRenderer'].includes(key)).map(([,child])=>child);for(let i=values.length-1;i>=0;i--)if(values[i]&&typeof values[i]==='object')stack.push({value:values[i],depth:depth+1});
  }return found;
}
const text=value=>typeof value==='string'?value:value?.simpleText??value?.content??value?.runs?.map(run=>run.text??'').join('');
function boundedToken(token) {if(typeof token!=='string'||!token||token.length>16384)fail('Invalid advertised creator continuation.');return token;}
export function creatorFeed(data,{channelId,sorted=false,initial=false}={}) {
  assertNoAccessDenial(data);if(data?.error)fail('YouTube returned a creator API error.');
  let root=data;
  if(initial){const tabs=data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.map(item=>item.tabRenderer).filter(tab=>tab?.selected);if(tabs?.length!==1)fail('No unique selected creator Videos tab was found.');
    const url=tabs[0].endpoint?.commandMetadata?.webCommandMetadata?.url;
    try{const endpoint=new URL(url,'https://www.youtube.com');if(typeof url!=='string'||!endpoint.pathname.endsWith('/videos'))throw new Error();creatorUrl(endpoint.href);}catch{fail('Creator discovery did not establish a supported Videos tab.');}root=tabs[0].content;
  }else{
    const actions=[...(data?.onResponseReceivedActions??[]),...(data?.onResponseReceivedEndpoints??[])];
    const grids=actions.map(action=>action.appendContinuationItemsAction?.continuationItems??action.reloadContinuationItemsCommand?.continuationItems).filter(Array.isArray);
    if(grids.length>1)fail('Ambiguous creator feed continuation arrays.');
    if(grids.length===1)root=grids[0];
  }
  const all=nodes(root),chips=all.flatMap(node=>[node.chipCloudChipRenderer,node.chipViewModel]).filter(Boolean);
  const latest=chips.filter(chip=>text(chip.text)==='Latest');
  if(!sorted){if(latest.length!==1)fail('Latest-first creator ordering could not be verified.');
    if(!(latest[0].isSelected||latest[0].selected)) {
      const endpoint=latest[0].navigationEndpoint??latest[0].tapCommand;
      const command=nodes(endpoint).find(node=>node.browseEndpoint),api=command?.commandMetadata?.webCommandMetadata?.apiUrl;
      if(!command||api!==undefined&&api!=='/youtubei/v1/browse'||command.browseEndpoint.browseId!==channelId)fail('No trusted advertised Latest creator action was found.');
      return {sort:{browseId:channelId,params:boundedToken(command.browseEndpoint.params)}};
    }
  }
  const videos=[],seen=new Set(),continuations=[];
  for(const node of all) {
    const video=node.videoRenderer??node.gridVideoRenderer,lockup=node.lockupViewModel;
    const id=video?.videoId??(lockup?.contentType==='LOCKUP_CONTENT_TYPE_VIDEO'?lockup.contentId:null);
    if(id!==null&&id!==undefined){if(!VIDEO.test(id))fail('Creator feed contained an invalid video ID.');
      // Upcoming premieres are not published transcripts; they cannot fill a result.
      if(!video?.upcomingEventData&&!seen.has(id)){seen.add(id);videos.push({id,title:String(text(video?.title??lockup?.metadata?.lockupMetadataViewModel?.title)??'').slice(0,512)});}
    }
    const continuation=node.continuationItemRenderer?.continuationEndpoint;
    if(continuation){const api=continuation.commandMetadata?.webCommandMetadata?.apiUrl;if(api!==undefined&&api!=='/youtubei/v1/browse')fail('Untrusted creator continuation API path.');continuations.push(boundedToken(continuation.continuationCommand?.token));}
  }
  if(continuations.length>1)fail('Ambiguous creator feed continuation.');
  if(!videos.length&&!continuations.length&&!all.some(node=>node.messageRenderer||node.richGridRenderer))fail('Unsupported or incomplete creator feed.');
  return {videos,continuation:continuations[0]??null};
}
export class CreatorCatalog {
  constructor({fetchImpl=fetch,now=()=>Date.now(),budgetMs=20000}={}){this.fetchImpl=fetchImpl;this.now=now;this.deadline=now()+budgetMs;this.requests=0;}
  async request(raw,body,redirects=0) {
    const u=new URL(raw),browse=u.pathname==='/youtubei/v1/browse';
    if(u.origin!=='https://www.youtube.com'||(!browse&&creatorUrl(raw)!==raw)||browse&&u.search!=='?prettyPrint=false')fail('Untrusted creator request destination.');
    if(++this.requests>6||this.now()>=this.deadline)throw new TranscriptError('timeout','Creator discovery request budget exhausted.',{},true);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(6000,this.deadline-this.now()));
    try {
      const response=await this.fetchImpl(raw,{method:body?'POST':'GET',headers:{'Accept-Language':'en-US,en;q=0.9',...(body?{'Content-Type':'application/json'}: {})},...(body?{body:JSON.stringify(body)}: {}),redirect:'manual',signal:controller.signal});
      if([401,403,451].includes(response.status))throw new TranscriptError('access_restriction','YouTube denied creator discovery.',{http_status:response.status});
      if(response.status>=300&&response.status<400){await response.body?.cancel();if(browse||redirects>=2)throw new TranscriptError('access_restriction','Creator redirect could not be safely followed.');
        let next;try{next=creatorUrl(new URL(response.headers.get('location'),raw).href);}catch{throw new TranscriptError('access_restriction','Creator redirect led outside a supported public channel URL.');}return this.request(next,null,redirects+1);
      }
      if(response.status===429)throw new TranscriptError('rate_limiting','YouTube rate limited creator discovery.',{http_status:429},true);
      if(!response.ok)throw new TranscriptError('network_failure','Creator discovery returned an unsuccessful response.',{http_status:response.status},response.status>=500);
      const reader=response.body?.getReader(),chunks=[];let size=0;if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024){await reader.cancel();throw new TranscriptError('response_too_large','Creator response exceeded the bound.');}chunks.push(value);}
      const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}const value=new TextDecoder().decode(bytes);assertNoAccessDenial(value);return value;
    }catch(error){if(error instanceof TranscriptError)throw error;throw new TranscriptError(controller.signal.aborted?'timeout':'network_failure','Creator discovery could not complete.',{},true);}finally{clearTimeout(timer);}
  }
  async start(url) {
    const html=await this.request(creatorUrl(url));
    const data=inlineObject(html,['var ytInitialData =','window["ytInitialData"] =','window.ytInitialData =','ytInitialData =']);
    const metadata=nodes(data).map(node=>node.channelMetadataRenderer).filter(Boolean);if(metadata.length!==1||!CHANNEL.test(metadata[0].externalId))fail('Creator identity could not be established.');
    const channelId=metadata[0].externalId,config=inlineObject(html,['ytcfg.set('],value=>Boolean(value.INNERTUBE_CONTEXT?.client));
    const requested=new URL(creatorUrl(url)).pathname.split('/')[2];if(new URL(creatorUrl(url)).pathname.startsWith('/channel/')&&requested!==channelId)fail('Returned creator identity does not match the requested channel.');
    const client=config.INNERTUBE_CONTEXT.client;if(client.clientName!=='WEB'||typeof client.clientVersion!=='string'||!/^[\d.]{1,64}$/.test(client.clientVersion))fail('No supported advertised creator WEB context.');
    const context={client:{clientName:'WEB',clientVersion:client.clientVersion,hl:'en',...(typeof client.visitorData==='string'&&client.visitorData.length<=8192?{visitorData:client.visitorData}: {})}};
    let feed=creatorFeed(data,{channelId,initial:true});if(feed.sort)feed=creatorFeed(await this.browse(context,feed.sort),{channelId,sorted:true});
    return {channel_id:channelId,channel_title:String(metadata[0].title??'').slice(0,512),context,...feed};
  }
  async browse(context,payload){const body=await this.request('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false',{context,...payload});let data;try{data=JSON.parse(body);}catch{fail('Creator browse returned invalid JSON.');}assertNoAccessDenial(data);return data;}
  async next(state){return creatorFeed(await this.browse(state.context,{continuation:boundedToken(state.continuation)}),{channelId:state.channel_id,sorted:true});}
}
