import { SnapshotCache } from './snapshot-cache.mjs';
import { YouTubeExtractor, videoIdFromInput, validateLanguage } from './youtube-extractor.mjs';
import { TranscriptError } from './transcript-errors.mjs';
export function authorize(headers,ownerEmail) {
  const owner=headers.get('oai-authenticated-user-id'),email=headers.get('oai-authenticated-user-email');
  if(!owner||!email)throw new TranscriptError('unauthorized','Sign in with ChatGPT to use this private service.');
  if(!ownerEmail)throw new TranscriptError('configuration_error','The owner authorization policy has not been configured.');
  if(email.toLowerCase()!==ownerEmail.toLowerCase())throw new TranscriptError('forbidden','This service is restricted to its owner.');
  return owner;
}
export function formatTime(seconds) {
  const ms=Math.round(seconds*1000),s=Math.floor(ms/1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}
export class TranscriptService {
  constructor(db,{extractorFactory=options=>new YouTubeExtractor(options),acquirer=null,now}={}) {this.cache=new SnapshotCache(db,{...(now?{now}: {})});this.extractorFactory=extractorFactory;this.acquirer=acquirer;}
  async prequeue(owner,ids,lang){
    const failures=new Map();if(typeof this.acquirer?.enqueue!=='function')return failures;
    // Queue every selected miss first. Waiting for one video cannot prevent a
    // later video from ever receiving its authenticated acquisition job.
    await Promise.all(ids.map(async id=>{try{if(!await this.cache.latest(owner,id,lang))await this.acquirer.enqueue(owner,id,lang);}catch(e){failures.set(id,e);}}));return failures;
  }
  async call(name,args,owner,extractionOptions) {
    if(!args||typeof args!=='object'||Array.isArray(args))throw new TranscriptError('invalid_input','Tool arguments must be an object.');
    const transcript=['get_transcript','get_timed_transcript'].includes(name);
    const allowed=transcript?['url','lang','next_cursor']:['url'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))throw new TranscriptError('invalid_input','Unexpected tool argument.');
    const id=videoIdFromInput(args.url);validateLanguage(args.lang);
    if(args.next_cursor!==undefined&&(typeof args.next_cursor!=='string'||!args.next_cursor))throw new TranscriptError('invalid_cursor','Cursor must be a non-empty string.');
    try {
      if(transcript) {
        let result;
        if(args.next_cursor!==undefined)result=await this.cache.page(owner,id,args.lang,args.next_cursor,null,'hit',extractionOptions?.cleanOutput===true);
        else {
          let snapshot=await this.cache.latest(owner,id,args.lang),cacheStatus='hit';
          if(!snapshot) {
            if(this.acquirer){snapshot=await this.acquirer.request(owner,id,args.lang,extractionOptions);cacheStatus='miss';}
            else{
            const releaseClaim=await this.cache.claim(owner,id);
            try {
              snapshot=await this.cache.latest(owner,id,args.lang);
              if(!snapshot){
                const release=await this.cache.lease();
                try {const fetched=await this.extractorFactory(extractionOptions).transcript(id,args.lang);snapshot=await this.cache.write(owner,fetched,args.lang,releaseClaim);cacheStatus='miss';}
                finally{await release().catch(()=>{});}
              }
            }finally{await releaseClaim().catch(()=>{});}
            }
          }
          result=await this.cache.page(owner,id,args.lang,null,snapshot,cacheStatus,extractionOptions?.cleanOutput===true);
        }
        if(name==='get_timed_transcript')result={...result,timed_lines:result.segments.map(s=>({timestamp:formatTime(s.start),text:s.text,citation_url:`${result.source_url}&t=${Math.floor(s.start)}s`}))};
        return result;
      }
      if(!['get_video_info','get_available_languages'].includes(name))throw new TranscriptError('invalid_input','Unknown tool.');
      const stored=await this.cache.latest(owner,id,undefined);
      if(stored){const metadata=JSON.parse(stored.metadata_json);if(Array.isArray(metadata.languages)){
        const info=Object.fromEntries(['video_id','source_url','title','author','video_duration_seconds','languages','retrieved_at','extraction_method','extractor_version','caption_availability','content_trust'].filter(key=>Object.hasOwn(metadata,key)).map(key=>[key,metadata[key]]));
        info.cache_status='hit';info.metadata_source='durable_transcript_snapshot';info.source_snapshot_id=stored.id;
        if(name==='get_available_languages'){const {title,author,video_duration_seconds,...languages}=info;return languages;}
        return info;
      }}
      const release=await this.cache.lease();
      try {
        const extractor=this.extractorFactory(),p=await extractor.getTracks(id,{allowAbsent:true}),info=extractor.publicInfo(p);
        if(name==='get_available_languages'){const {title,author,video_duration_seconds,...languages}=info;return languages;}
        return info;
      }finally{await release().catch(()=>{});}
    } catch(error) {
      if(error instanceof TranscriptError)throw error;
      throw new TranscriptError('internal_error','The transcript operation failed unexpectedly. No result was cached.');
    }
  }
}
