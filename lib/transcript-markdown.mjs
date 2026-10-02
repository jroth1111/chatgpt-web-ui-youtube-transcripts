// Presentation only: raw text/timing remain unchanged in durable snapshots.
export function escapeMarkdown(text) {return String(text).replace(/\\/g,'\\\\').replace(/[`*_\[\]<>#|]/g,'\\$&');}
const presentationText=text=>String(text).replace(/[\u200B\uFEFF]/g,'').replace(/\s+/g,' ').trim();
export function cleanTranscript(segments,{rolling=false,previous:context=null}={}) {
  const paragraphs=[];let paragraph='',previous=context?{...context,text:presentationText(context.text)}:null;
  for(const segment of segments) {
    const gap=previous?segment.start-(previous.start+previous.duration):0;
    let text=presentationText(segment.text);
    if(!text)continue;
    // Remove rolling-window overlap only when upstream time ranges overlap.
    // Non-overlapping repeated speech is real speech and must be retained.
    if(rolling&&previous&&Number.isFinite(previous.duration)&&segment.start<previous.start+previous.duration) {
      const before=previous.text.split(' '),words=text.split(' ');let overlap=0;
      // A whole repeated cue may be real speech even while display ranges overlap.
      // Keep it; timing/text equality alone does not prove rolling duplication.
      const wholeCueRepeats=before.length>=words.length&&before.slice(-words.length).join(' ')===text;
      if(!wholeCueRepeats)for(let n=Math.min(before.length,words.length,128);n>=3;n--)if(before.slice(-n).join(' ')===words.slice(0,n).join(' ')){overlap=n;break;}
      if(overlap&&overlap<words.length)text=words.slice(overlap).join(' ');
    }
    previous={...segment,text:presentationText(segment.text)};
    if(!text)continue;
    if(paragraph&&(paragraph.length+text.length>1000||gap>3)) {paragraphs.push(paragraph);paragraph='';}
    paragraph+=(paragraph?' ':'')+text;
    if(paragraph.length>=500&&/[.!?]["'’”)]?$/.test(text)){paragraphs.push(paragraph);paragraph='';}
  }
  if(paragraph)paragraphs.push(paragraph);
  return paragraphs.map(escapeMarkdown).join('\n\n');
}
