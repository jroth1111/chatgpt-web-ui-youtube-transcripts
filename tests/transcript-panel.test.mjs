import test from 'node:test';
import assert from 'node:assert/strict';
import { panelRequest, panelResponse, inlineObject } from '../lib/transcript-panel.mjs';
import { YouTubeExtractor, parseCaptionBody } from '../lib/youtube-extractor.mjs';
const id='AJpK3YTTKZ4';
const track={languageCode:'en',kind:'manual',name:{simpleText:'English'},baseUrl:`https://www.youtube.com/api/timedtext?v=${id}`};
const player={playabilityStatus:{status:'OK'},videoDetails:{videoId:id,title:'Synthetic fixture'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}};
const initial={engagementPanels:[{engagementPanelSectionListRenderer:{panelIdentifier:'engagement-panel-searchable-transcript',content:{continuationItemRenderer:{continuationEndpoint:{commandMetadata:{webCommandMetadata:{apiUrl:'/youtubei/v1/get_transcript'}},getTranscriptEndpoint:{params:'advertised-only'}}}}}}]};
const config={INNERTUBE_CONTEXT:{client:{clientName:'WEB',clientVersion:'2.20261001.00.00'}}};
const html=()=>`ytcfg.set({"irrelevant":true});ytcfg.set(${JSON.stringify(config)});var ytInitialPlayerResponse = ${JSON.stringify(player)};var ytInitialData = ${JSON.stringify(initial)};`;
const menu=()=>[{title:'English',selected:true}];
const cue=(text='  A &amp; B\nnext  ')=>({transcriptSegmentRenderer:{startMs:'1200',endMs:'3200',snippet:{runs:[{text}]}}});
const response=(items=menu(),entries=[cue()])=>{
  const panel={footer:{transcriptFooterRenderer:{languageMenu:{sortFilterSubMenuRenderer:{subMenuItems:items}}}},body:{transcriptSegmentListRenderer:{initialSegments:entries}}};
  return {actions:[{updateEngagementPanelAction:{content:{transcriptRenderer:{content:{transcriptSearchPanelRenderer:panel}}}}}]};
};
const parseFailure=e=>e.code==='parsing_failure';

test('panel: advertised endpoint and WEB context only; unrelated config is skipped',()=>{
  assert.deepEqual(panelRequest(html()),{params:'advertised-only',context:config.INNERTUBE_CONTEXT});
  assert.throws(()=>panelRequest(html().replace('/youtubei/v1/get_transcript','/evil')),parseFailure);
  assert.throws(()=>panelRequest(html().replace('"WEB"','"ANDROID"')),parseFailure);
  assert.throws(()=>panelRequest(html().replace('advertised-only','')),parseFailure);
});
test('panel: inline JSON handles braces/escaped quotes inside strings',()=>{
  const value={text:'brace } quote " and slash \\'};
  assert.deepEqual(inlineObject(`var data = ${JSON.stringify(value)};`,['var data =']),value);
});
test('panel: preserves literal text, whitespace, repetitions and upstream timing',()=>{
  const parsed=panelResponse(response(menu(),[cue(),{transcriptSectionHeaderRenderer:{}},cue()]),track);
  assert.equal(parsed.segments.length,2);
  assert.deepEqual(parsed.segments[0],{text:'  A &amp; B\nnext  ',start:1.2,duration:2,duration_source:'upstream'});
});
test('panel: language mismatch uses only unique advertised continuation, never fabricated params',()=>{
  const items=[{title:'French',selected:true},{title:'English',selected:false,continuation:{reloadContinuationData:{continuation:'english-only'}}}];
  assert.deepEqual(panelResponse(response(items),track),{continuation:'english-only'});
  assert.throws(()=>panelResponse(response(items.map(item=>({...item,continuation:undefined}))),track),parseFailure);
  assert.throws(()=>panelResponse(response([...menu(),...menu()]),track),parseFailure);
});
test('panel: malformed timing, unknown entries and upstream continuation fail without partial success',()=>{
  for(const entry of [{continuationItemRenderer:{}},{unknownRenderer:{}},{transcriptSegmentRenderer:{startMs:null,endMs:'2',snippet:{simpleText:'text'}}},cue()]) {
    const entries=entry.transcriptSegmentRenderer?.startMs==='1200'?[cue(),{continuationItemRenderer:{}}]:[cue(),entry];
    assert.throws(()=>panelResponse(response(menu(),entries),track),parseFailure);
  }
});
test('panel: explicit API denials and caption challenge pages remain terminal restrictions',()=>{
  assert.throws(()=>panelResponse({error:{code:403,message:'Forbidden'}},track),e=>e.code==='access_restriction');
  assert.throws(()=>parseCaptionBody('<div class="g-recaptcha">challenge</div>'),e=>e.code==='access_restriction');
});
function transport(panelResponses) {
  const calls=[];
  return {calls,fetchImpl:async(raw,init)=>{
    const path=new URL(raw).pathname;calls.push({path,body:init.body});
    if(path==='/youtubei/v1/player')return new Response(JSON.stringify(player));
    if(path==='/api/timedtext')return new Response('');
    if(path==='/watch')return new Response(html());
    if(path==='/youtubei/v1/get_transcript')return panelResponses.shift()??assert.fail('unexpected additional panel request');
    assert.fail('untrusted request');
  }};
}
test('extractor: empty timedtext recovers through advertised panel with accurate provenance',async()=>{
  const t=transport([new Response(JSON.stringify(response()))]);
  const result=await new YouTubeExtractor(t).transcript(id,'en');
  assert.equal(result.extraction_method,'web/transcript_panel');assert.equal(result.selected_language,'en');
  assert.equal(result.translation,false);assert.equal(result.segments.length,1);
  assert.equal(t.calls.length,7);assert.equal(JSON.parse(t.calls.at(-1).body).params,'advertised-only');
  assert(!JSON.stringify(result).includes('advertised-only'));
});
test('extractor: selected advertised language is rechecked after bounded selection request',async()=>{
  const first=response([{title:'French',selected:true},{title:'English',continuation:{reloadContinuationData:{continuation:'english-only'}}}]);
  const t=transport([new Response(JSON.stringify(first)),new Response(JSON.stringify(response()))]);
  assert.equal((await new YouTubeExtractor(t).transcript(id,'en')).segments.length,1);
  assert.equal(JSON.parse(t.calls.at(-1).body).params,'english-only');
});
test('extractor: panel denial stops all subsequent requests including timedtext',async()=>{
  for(const denied of [new Response('',{status:403}),new Response(JSON.stringify({error:{code:403}})),new Response('<div class="g-recaptcha">challenge</div>'),new Response('<html><title>Consent required</title></html>'),new Response(JSON.stringify({error:{message:'Sign in to confirm you are not a bot'}}))]) {
    const t=transport([denied]);await assert.rejects(new YouTubeExtractor(t).transcript(id),e=>e.code==='access_restriction');assert.equal(t.calls.length,7);
  }
});
test('extractor: typed player and timedtext API denials cause no later request',async()=>{
  for(const stage of ['player','timedtext'])for(const denial of [{error:{code:403,message:'Forbidden'}},{error:{message:'Sign in to confirm you are not a bot'}}]) {
    let calls=0;
    const fetchImpl=async()=>{
      calls++;
      const terminal=stage==='player'?1:2;
      if(calls>terminal)assert.fail('network request after explicit denial');
      return new Response(JSON.stringify(stage==='timedtext'&&calls===1?player:denial));
    };
    await assert.rejects(new YouTubeExtractor({fetchImpl}).transcript(id,'en'),e=>e.code==='access_restriction');
    assert.equal(calls,stage==='player'?1:2);
  }
  assert.equal(parseCaptionBody(JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'Sign in; access denied; captcha are spoken words.'}]}]})).segments.length,1);
});
test('extractor: malformed player recovers with WEB timedtext before considering panel',async()=>{
  const calls=[];
  const fetchImpl=async raw=>{
    const path=new URL(raw).pathname;calls.push(path);
    if(path==='/youtubei/v1/player')return new Response('malformed player');
    if(path==='/watch')return new Response(html());
    if(path==='/api/timedtext')return new Response(JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'ordinary recovery'}]}]}));
    assert.fail('panel requested without timedtext parsing failure');
  };
  const result=await new YouTubeExtractor({fetchImpl}).transcript(id,'en');
  assert.equal(result.extraction_method,'web/timedtext/json3');
  assert.deepEqual(calls,['/youtubei/v1/player','/watch','/api/timedtext']);
});
test('extractor: WEB-only empty timedtext recovers through advertised panel once',async()=>{
  const t=transport([new Response(JSON.stringify(response()))]);
  const underlying=t.fetchImpl;
  t.fetchImpl=async(raw,init)=>new URL(raw).pathname==='/youtubei/v1/player'?(t.calls.push({path:'/youtubei/v1/player'}),new Response(JSON.stringify({...player,captions:undefined}))):underlying(raw,init);
  const result=await new YouTubeExtractor(t).transcript(id,'en');
  assert.equal(result.extraction_method,'web/transcript_panel');
  assert.equal(t.calls.filter(call=>call.path==='/youtubei/v1/get_transcript').length,1);
  assert.equal(t.calls.filter(call=>call.path==='/api/timedtext').length,4);
});
test('extractor: missing timedtext resources do not trigger malformed-body panel recovery',async()=>{
  const fetchImpl=async raw=>{
    const path=new URL(raw).pathname;
    if(path==='/youtubei/v1/player')return new Response(JSON.stringify(player));
    if(path==='/watch')return new Response(html());
    if(path==='/api/timedtext')return new Response('',{status:404});
    assert.fail('panel requested without an ordinary malformed/empty body');
  };
  await assert.rejects(new YouTubeExtractor({fetchImpl}).transcript(id,'en'),parseFailure);
});
test('panel: rejects empty, whitespace and nonnumeric timing instead of inventing zero',()=>{
  for(const value of ['', ' ',true,false,null,undefined,-1,Infinity,{}]) {
    const entry=cue();entry.transcriptSegmentRenderer.startMs=value;
    assert.throws(()=>panelResponse(response(menu(),[entry]),track),parseFailure);
    const end=cue();end.transcriptSegmentRenderer.endMs=value;
    assert.throws(()=>panelResponse(response(menu(),[end]),track),parseFailure);
  }
});
test('extractor: raw player HTML challenges stop before WEB fallback',async()=>{
  for(const method of ['transcript','getTracks']) {
    let calls=0;
    const extractor=new YouTubeExtractor({fetchImpl:async()=>{
      if(++calls>1)assert.fail('request after raw player challenge');
      return new Response('<div class="g-recaptcha">challenge</div>');
    }});
    await assert.rejects(extractor[method](id),e=>e.code==='access_restriction');
    assert.equal(calls,1);
  }
});
test('extractor: legitimate watch titles and data mentioning CAPTCHA are not denial pages',async()=>{
  const watch=`<html><title>How CAPTCHA works - YouTube</title>${html().replace('Synthetic fixture','CAPTCHA and access denied explained')}</html>`;
  let calls=0;
  const fetchImpl=async raw=>{
    calls++;const path=new URL(raw).pathname;
    if(path==='/youtubei/v1/player')return new Response('malformed player');
    if(path==='/watch')return new Response(watch);
    if(path==='/api/timedtext')return new Response(JSON.stringify({events:[{tStartMs:0,dDurationMs:1000,segs:[{utf8:'CAPTCHA and access denied'}]}]}));
    assert.fail('unexpected request');
  };
  const result=await new YouTubeExtractor({fetchImpl}).transcript(id,'en');
  assert.equal(calls,3);assert.equal(result.segments[0].text,'CAPTCHA and access denied');
});
