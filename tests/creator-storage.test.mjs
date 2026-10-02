import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorTranscripts } from '../lib/creator-transcripts.mjs';
import { SnapshotCache } from '../lib/snapshot-cache.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { localDb } from './sqlite-adapter.mjs';

// Synthetic source responses and real local SQLite; no network or deployed D1 proof.
const owner='synthetic-owner',url='https://www.youtube.com/@SyntheticCreator';
const ids=Array.from({length:12},(_,index)=>`video_${String(index).padStart(5,'0')}`);
const fixture=id=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,
  title:'Synthetic retained upload',selected_language:'en',track_id:'.en',caption_type:'manual',
  extractor_version:'synthetic',extraction_method:'synthetic',retrieved_at:'2026-10-01T00:00:00Z',
  segments:[{text:'Synthetic original caption text.',start:0,duration:1}]});
function catalog(videos,counters) {
  return ()=>{counters.constructed++;return {
    start:async()=>{counters.discovery++;return {channel_id:'UCaaaaaaaaaaaaaaaaaaaaaa',
      channel_title:'Synthetic creator',context:{},videos:videos.map(id=>({id})),continuation:null};},
    next:async()=>assert.fail('Synthetic fixture has no continuation or network source')
  };};
}

test('creator storage: expired workflow cursors fail before source calls; caption snapshots remain durable',async()=>{
  const db=localDb();let now=1000,serviceCalls=0;
  try {
    const cache=new SnapshotCache(db,{now:()=>now}),saved=[];
    for(const id of ids)saved.push(await cache.write(owner,fixture(id),'en'));
    const service=new TranscriptService(db,{now:()=>now,
      extractorFactory:()=>assert.fail('Durable captions must never refetch synthetic source')});
    const call=service.call.bind(service);
    service.call=async(...args)=>{serviceCalls++;return call(...args);};
    const counters={constructed:0,discovery:0},options={now:()=>now,catalogFactory:catalog(ids,counters)};
    const first=await creatorTranscripts(service,db,{creator_url:url,limit:11},owner,options);
    assert.equal(first.collected_count,10);assert.equal(first.has_more_creator,true);
    assert.equal(serviceCalls,10);assert.deepEqual(counters,{constructed:1,discovery:1});
    now=db.sqlite.prepare('SELECT expires_at FROM creator_jobs').get().expires_at;
    await assert.rejects(creatorTranscripts(service,db,
      {creator_url:url,limit:11,creator_cursor:first.creator_cursor},owner,options),
      error=>error.code==='invalid_cursor');
    assert.equal(serviceCalls,10);assert.deepEqual(counters,{constructed:1,discovery:1});
    const caption=await call('get_transcript',{url:`https://youtu.be/${ids[0]}?si=synthetic`},owner);
    assert.equal(caption.snapshot_id,saved[0].id);assert.equal(caption.cache_status,'hit');
    assert.equal(caption.retention,'durable');assert.equal(caption.expires_at,null);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,ids.length);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM extractor_leases').get().n,0);
  } finally {db.sqlite.close();}
});

test('creator storage: atomic receipt commit failure preserves old/new snapshots and releases the workflow lease',async()=>{
  const db=localDb();let extractions=0;
  try {
    const cache=new SnapshotCache(db),retained=await cache.write(owner,fixture(ids[0]),'en');
    const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async id=>{
      extractions++;return fixture(id);
    }})});
    // Fail after the receipt INSERT, during its paired state UPDATE. D1-shaped
    // batch must roll both back without rolling back earlier caption snapshots.
    db.sqlite.exec(`CREATE TRIGGER fail_creator_commit BEFORE UPDATE ON creator_jobs
      WHEN NEW.revision > OLD.revision BEGIN
      SELECT RAISE(ABORT,'synthetic workflow storage failure'); END;`);
    const counters={constructed:0,discovery:0};
    await assert.rejects(creatorTranscripts(service,db,{creator_url:url,limit:2},owner,
      {catalogFactory:catalog(ids.slice(0,2),counters)}),error=>error.code==='storage_unavailable');
    assert.equal(extractions,1);assert.deepEqual(counters,{constructed:1,discovery:1});
    const row=db.sqlite.prepare('SELECT * FROM creator_jobs').get();
    assert.equal(row.revision,0);assert.equal(row.lease_token,null);assert.equal(row.lease_expires,0);
    assert.deepEqual(JSON.parse(row.state_json).succeeded,[]);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM creator_job_pages').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,2);
    assert.equal((await cache.latest(owner,ids[0],'en')).id,retained.id);
    const captured=await cache.latest(owner,ids[1],'en');assert(captured);
    const repeat=await service.call('get_transcript',{url:ids[1],lang:'en'},owner);
    assert.equal(repeat.snapshot_id,captured.id);assert.equal(repeat.cache_status,'hit');
    assert.equal(extractions,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM extractor_leases').get().n,0);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.sqlite.close();}
});
