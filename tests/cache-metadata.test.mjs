import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCache } from '../lib/snapshot-cache.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { localDb } from './sqlite-adapter.mjs';
const id='Sy1Fjf-H-Qg';
test('cached metadata: video info and language lookup reuse the durable snapshot without upstream calls',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),row=await cache.write('owner',{video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,title:'Synthetic cached title',author:'Synthetic creator',selected_language:'en',track_id:'.en',caption_type:'manual',languages:[{language:'en',caption_type:'manual'}],retrieved_at:'2026-10-01T00:00:00Z',segments:[{text:'Synthetic caption',start:0,duration:1}]},'en');
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('cached metadata must not make an upstream request')});
  for(const tool of ['get_video_info','get_available_languages']){const info=await service.call(tool,{url:`https://youtu.be/${id}?si=tracking`},'owner');assert.equal(info.metadata_source,'durable_transcript_snapshot');assert.equal(info.cache_status,'hit');assert.equal(info.source_snapshot_id,row.id);assert.equal(info.retrieved_at,'2026-10-01T00:00:00Z');assert.equal(info.segments,undefined);}
});
