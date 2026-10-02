import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotCache } from '../lib/snapshot-cache.mjs';
import { TranscriptService } from '../lib/transcript-service.mjs';
import { TranscriptError } from '../lib/transcript-errors.mjs';
import { EXTRACTOR_VERSION } from '../lib/youtube-extractor.mjs';
import { localDb } from './sqlite-adapter.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const id='AJpK3YTTKZ4';
const fixture=()=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'.en',caption_type:'manual',extractor_version:EXTRACTOR_VERSION,
  segments:Array.from({length:121},(_,i)=>({text:`Synthetic cue ${i}`,start:i,duration:1})),extraction_method:'synthetic'});
test('durable cache: aged snapshots from prior versions remain reusable, including default/language aliases',async()=>{
  let now=1000;const db=localDb(),cache=new SnapshotCache(db,{now:()=>now});
  const row=await cache.write('owner',{...fixture(),extractor_version:'older-extractor'},undefined),first=await cache.page('owner',id,undefined,null,row);
  db.sqlite.prepare("UPDATE transcript_snapshots SET extractor_version='older-extractor', expires_at=0 WHERE id=?").run(row.id);
  now+=10*365*24*60*60*1000;
  const service=new TranscriptService(db,{now:()=>now,extractorFactory:()=>assert.fail('durable captions must not refetch')});
  const again=await service.call('get_transcript',{url:id,lang:'en'},'owner');assert.equal(again.snapshot_id,row.id);assert.equal(again.cache_status,'hit');assert.equal(again.retention,'durable');assert.equal(again.expires_at,null);
  assert.equal(again.extractor_version,'older-extractor');
  assert.equal((await service.call('get_transcript',{url:id,next_cursor:first.next_cursor},'owner')).has_more,false);
  assert.equal(await cache.latest('other',id,'en'),null);assert.equal(await cache.latest('owner',id,'fr'),null);
});
test('durable cache: unspecified language reuses an explicitly stored original track',async()=>{
  const db=localDb(),cache=new SnapshotCache(db),row=await cache.write('owner',fixture(),'en');
  const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('stored original track must not refetch')});
  const result=await service.call('get_transcript',{url:id},'owner');
  assert.equal(result.snapshot_id,row.id);assert.equal(result.selected_language,'en');assert.equal(result.cache_status,'hit');
});
test('durable cache: denial and saturated global leases both release the miss claim',async()=>{
  for(const saturated of [false,true]) {
    const db=localDb(),cache=new SnapshotCache(db);let calls=0;
    const releases=saturated?[await cache.lease(),await cache.lease()]:[];
    const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>{calls++;throw new TranscriptError('access_restriction','synthetic denial');}})});
    if(saturated)await assert.rejects(service.call('get_transcript',{url:id},'owner'),e=>e.code==='service_busy');
    else await assert.rejects(service.call('get_transcript',{url:id},'owner'),e=>e.code==='access_restriction');
    assert.equal(calls,saturated?0:1);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
    for(const release of releases)await release();
  }
});
test('durable cache: concurrent owners have separate claims and stored captions',async()=>{
  const db=localDb();let calls=0,started,finish;
  const bothStarted=new Promise(resolve=>{started=resolve;}),waiting=new Promise(resolve=>{finish=resolve;});
  const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>{if(++calls===2)started();await waiting;return fixture();}})});
  const a=service.call('get_transcript',{url:id},'owner-a'),b=service.call('get_transcript',{url:id},'owner-b');
  await bothStarted;assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,2);finish();
  const results=await Promise.all([a,b]);assert.notEqual(results[0].snapshot_id,results[1].snapshot_id);
  assert.equal((await service.call('get_transcript',{url:id},'owner-a')).snapshot_id,results[0].snapshot_id);
  assert.equal(calls,2);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
});
test('durable cache: actual caption storage beyond the former 32 MiB budget is retained',async()=>{
  const db=localDb(),cache=new SnapshotCache(db);let first;
  const large={...fixture(),segments:Array.from({length:100},(_,i)=>({text:'x'.repeat(40000),start:i,duration:1}))};
  for(let i=0;i<9;i++){const row=await cache.write('owner',large,'en');first??=row;}
  const totals=db.sqlite.prepare('SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM transcript_snapshots').get();
  assert.equal(totals.n,9);assert(totals.bytes>32*1024*1024);
  assert.equal((await cache.page('owner',id,'en',null,first)).segments[0].text.length,40000);
});
test('production migration: only claims are added and legacy snapshot/chunk data is preserved',()=>{
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_typical_blink.sql',import.meta.url),'utf8'));
  sqlite.prepare('INSERT INTO transcript_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy','owner',id,'en','en','.en','legacy-version','legacy-key',1,0,1,1,'{}');
  sqlite.prepare('INSERT INTO transcript_chunks VALUES (?, ?, ?, ?)').run('legacy',0,0,'[]');
  const before={snapshot:sqlite.prepare('SELECT * FROM transcript_snapshots').get(),chunk:sqlite.prepare('SELECT * FROM transcript_chunks').get(),schema:sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()};
  const migration=readFileSync(new URL('../drizzle/0001_faithful_dracula.sql',import.meta.url),'utf8');
  assert.match(migration,/^CREATE TABLE `transcript_claims`/);assert(!/\b(?:DROP|ALTER|DELETE|UPDATE|REPLACE)\b/i.test(migration));sqlite.exec(migration);
  assert.deepEqual(sqlite.prepare('SELECT * FROM transcript_snapshots').get(),before.snapshot);assert.deepEqual(sqlite.prepare('SELECT * FROM transcript_chunks').get(),before.chunk);
  assert.deepEqual(sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'transcript_claims' ORDER BY name").all(),before.schema);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);sqlite.close();
});
test('durable cache: simultaneous service instances fetch a video once, then reuse the same snapshot',async()=>{
  const db=localDb();let calls=0,start,finish;
  const started=new Promise(resolve=>{start=resolve;}),waiting=new Promise(resolve=>{finish=resolve;});
  const factory=()=>({transcript:async()=>{calls++;start();await waiting;return fixture();}});
  const a=new TranscriptService(db,{extractorFactory:factory}),b=new TranscriptService(db,{extractorFactory:factory});
  const first=a.call('get_transcript',{url:id},'owner');await started;
  await assert.rejects(b.call('get_transcript',{url:id,lang:'en'},'owner'),e=>e.code==='extraction_in_progress');assert.equal(calls,1);
  finish();const result=await first;const repeat=await b.call('get_transcript',{url:id,lang:'en'},'owner');assert.equal(repeat.snapshot_id,result.snapshot_id);assert.equal(calls,1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
});
test('durable cache: expired claim recovery is token-fenced and old release cannot delete the replacement',async()=>{
  let now=0;const db=localDb(),cache=new SnapshotCache(db,{now:()=>now});const old=await cache.claim('owner',id);
  now=120001;const fresh=await cache.claim('owner',id);
  await assert.rejects(cache.write('owner',fixture(),'en',old),e=>e.code==='storage_unavailable');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,0);
  await old();assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,1);
  await cache.write('owner',fixture(),'en',fresh);await fresh();assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,1);
});
test('durable cache: failed storage commit preserves prior snapshots and releases extraction claims',async()=>{
  const db=localDb(),cache=new SnapshotCache(db);const retained=await cache.write('owner',fixture(),'en');
  db.sqlite.exec("CREATE TRIGGER fail_new_chunk BEFORE INSERT ON transcript_chunks BEGIN SELECT RAISE(ABORT,'synthetic quota failure'); END;");
  const another='aaaaaaaaaaa';const service=new TranscriptService(db,{extractorFactory:()=>({transcript:async()=>({...fixture(),video_id:another})})});
  await assert.rejects(service.call('get_transcript',{url:another},'owner'),e=>e.code==='storage_unavailable');
  assert.equal((await cache.latest('owner',id,'en')).id,retained.id);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_claims').get().n,0);
});
