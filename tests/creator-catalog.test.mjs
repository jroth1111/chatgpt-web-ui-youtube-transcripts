import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorCatalog, creatorFeed, creatorUrl } from '../lib/creator-catalog.mjs';
const channel='UCwSozl89jl2zUDzQ4jGJD3g',id='Sy1Fjf-H-Qg';
const entry=()=>({richItemRenderer:{content:{videoRenderer:{videoId:id,title:{runs:[{text:'Synthetic upload'}]}}}}});
const initial=selected=>({metadata:{channelMetadataRenderer:{externalId:channel,title:'Synthetic creator'}},contents:{twoColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,endpoint:{commandMetadata:{webCommandMetadata:{url:'/@SkillLeapAI/videos'}}},content:{richGridRenderer:{header:{chipCloudRenderer:{chips:[{chipCloudChipRenderer:{text:{simpleText:'Latest'},isSelected:selected,navigationEndpoint:{commandMetadata:{webCommandMetadata:{apiUrl:'/youtubei/v1/browse'}},browseEndpoint:{browseId:channel,params:'latest-only'}}}}]}},contents:[entry(),{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'next-page'}}}}]}}}}]}}});
const html=selected=>`ytcfg.set(${JSON.stringify({INNERTUBE_CONTEXT:{client:{clientName:'WEB',clientVersion:'2.20261001.00.00'}}})});var ytInitialData = ${JSON.stringify(initial(selected))};`;
test('creator URL: accepts shared handles/channel/legacy paths, strips tracking, rejects video and hostile URLs',()=>{
  assert.equal(creatorUrl('https://www.youtube.com/@SkillLeapAI?si=tracking'),'https://www.youtube.com/@SkillLeapAI/videos');
  assert.equal(creatorUrl(`https://youtube.com/channel/${channel}`),`https://www.youtube.com/channel/${channel}/videos`);
  for(const input of ['http://youtube.com/@SkillLeapAI','https://youtube.com.evil.example/@SkillLeapAI','https://user:pass@youtube.com/@SkillLeapAI','https://youtube.com/@Skill%2FLeapAI','https://youtube.com/@Skill%252FLeapAI','https://youtube.com/@Skill%5CLeapAI','https://youtu.be/'+id,'https://youtube.com/watch?v='+id])assert.throws(()=>creatorUrl(input));
});
test('catalog: latest-first proof, channel identity, feed order and private continuation',async()=>{
  const feed=await new CreatorCatalog({fetchImpl:async()=>new Response(html(true))}).start('https://www.youtube.com/@SkillLeapAI');
  assert.equal(feed.channel_id,channel);assert.deepEqual(feed.videos.map(video=>video.id),[id]);assert.equal(feed.continuation,'next-page');
  assert.throws(()=>creatorFeed({...initial(true),contents:{twoColumnBrowseResultsRenderer:{tabs:[]}}},{initial:true,channelId:channel}));
});
test('catalog: Videos ordering requires a supported selected Videos-tab endpoint',()=>{
  for(const endpoint of [undefined,'/@SkillLeapAI','https://evil.example/@SkillLeapAI/videos','/watch/videos']){
    const data=initial(true),tab=data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer;tab.title='Home';
    if(endpoint===undefined)delete tab.endpoint;else tab.endpoint.commandMetadata.webCommandMetadata.url=endpoint;
    assert.throws(()=>creatorFeed(data,{initial:true,channelId:channel}),error=>error.code==='parsing_failure');
  }
  const data=initial(true);data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url='https://www.youtube.com/@SkillLeapAI/videos?view=0';
  assert.deepEqual(creatorFeed(data,{initial:true,channelId:channel}).videos.map(video=>video.id),[id]);
});
test('catalog: unsorted page invokes only the advertised same-channel Latest action',async()=>{
  const calls=[];const catalog=new CreatorCatalog({fetchImpl:async(url,options)=>{calls.push({url,body:options.body});return new Response(calls.length===1?html(false):JSON.stringify({onResponseReceivedActions:[{reloadContinuationItemsCommand:{continuationItems:[entry()]}}]}));}});
  assert.equal((await catalog.start('https://youtube.com/@SkillLeapAI')).videos.length,1);assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].body).params,'latest-only');
});
test('catalog: HTTP/API/body access denials stop without alternate requests',async()=>{
  for(const response of [new Response('blocked',{status:403}),new Response('<html><div class="g-recaptcha">denied</div></html>')]){
    let calls=0;await assert.rejects(new CreatorCatalog({fetchImpl:async()=>{calls++;return response;}}).start('https://youtube.com/@SkillLeapAI'),error=>error.code==='access_restriction');assert.equal(calls,1);
  }
});
test('catalog: safe creator alias redirect is bounded; consent/external redirect is refused',async()=>{
  let calls=0;const catalog=new CreatorCatalog({fetchImpl:async()=>++calls===1?new Response(null,{status:301,headers:{location:'https://www.youtube.com/@SkillLeapAI'}}):new Response(html(true))});assert.equal((await catalog.start('https://youtube.com/c/SkillLeapAI')).videos.length,1);assert.equal(calls,2);
  await assert.rejects(new CreatorCatalog({fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://consent.youtube.com/'}})}).start('https://youtube.com/@SkillLeapAI'),error=>error.code==='access_restriction');
});
test('catalog: continuation retains source order and excludes upcoming premieres',()=>{
  const feed=creatorFeed({onResponseReceivedActions:[{appendContinuationItemsAction:{continuationItems:[{videoRenderer:{videoId:'aaaaaaaaaaa',upcomingEventData:{}}},entry(),entry()]}}]},{channelId:channel,sorted:true});assert.deepEqual(feed.videos.map(video=>video.id),[id]);
});
test('catalog: multiple continuation arrays cannot be merged as verified uploads',()=>{
  const data={onResponseReceivedActions:[
    {appendContinuationItemsAction:{targetId:'main-grid',continuationItems:[entry()]}},
    {appendContinuationItemsAction:{targetId:'recommendations',continuationItems:[{videoRenderer:{videoId:'xhNMRfkblnk'}}]}}
  ]};
  assert.throws(()=>creatorFeed(data,{channelId:channel,sorted:true}),error=>error.code==='parsing_failure');
});
