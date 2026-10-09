import test from 'node:test';
import assert from 'node:assert/strict';
import {localDb} from './sqlite-adapter.mjs';
import {SnapshotCache} from '../lib/snapshot-cache.mjs';
import {TranscriptService} from '../lib/transcript-service.mjs';
import {creatorTranscripts} from '../lib/creator-transcripts.mjs';
import {playlistTool} from '../lib/playlist-tools.mjs';

const owner='fixture-owner',video='leasevideo0';
const fixture=large=>({video_id:video,source_url:`https://www.youtube.com/watch?v=${video}`,selected_language:'en',track_id:'a.en',caption_type:'manual',extractor_version:'synthetic-lease',extraction_method:'synthetic',segments:Array.from({length:large?2000:2},(_,i)=>({text:`Cue ${i} ${'x'.repeat(large?400:10)}`,start:i,duration:1}))});
for(const kind of ['creator','playlist'])for(const timing of ['before_batch','between_parts','silently_skipped_part'])test(`${kind}: database-time lease expiry or skipped write ${timing} cannot commit a partial or stale replay`,async()=>{
 const db=localDb();let clock=0;db.setClock(()=>clock);
 try{
  const large=timing!=='before_batch';await new SnapshotCache(db,{now:()=>clock}).write(owner,fixture(large));
  const service=new TranscriptService(db,{now:()=>clock,extractorFactory:()=>assert.fail('Cached captions must not refetch')});
  const parent=kind==='creator'?'creator_jobs':'playlist_sessions',pages=kind==='creator'?'creator_job_pages':'playlist_pages',parts=kind==='creator'?'creator_response_chunks':'playlist_response_chunks';
  if(timing==='before_batch'){const batch=db.batch;db.batch=async statements=>{if(statements.some(s=>s.sql.includes(`INSERT INTO ${pages}`)))clock+=120001;return batch(statements);};}
  else if(timing==='between_parts'){db.sqlite.function('expire_replay_lease',()=>{clock+=120001;return 0;});db.sqlite.exec(`CREATE TRIGGER expire_between_parts AFTER INSERT ON ${parts} WHEN NEW.part=0 BEGIN SELECT expire_replay_lease(); END;`);}
  else db.sqlite.exec(`CREATE TRIGGER silently_skip_part BEFORE INSERT ON ${parts} WHEN NEW.part=1 BEGIN SELECT RAISE(IGNORE); END;`);
  const run=kind==='creator'?()=>creatorTranscripts(service,db,{creator_url:'https://www.youtube.com/@LeaseFixture',limit:1},owner,{now:()=>clock,catalogFactory:()=>({start:async()=>({channel_id:'UCabcdefghijklmnopqrstuv',channel_title:'Synthetic',context:{},videos:[{id:video}],continuation:null})})}):()=>playlistTool('get_playlist_transcripts',service,db,{playlist:'PLabcdefghijklmnop',limit:1},owner,{now:()=>clock,metadata:{request:async()=>({title:'Synthetic',entries:[{video_id:video,reported_position:1,availability:'reported_public'}],continuation:null,metadata_id:'fixture',acquisition_worker_id:'fixture'})}});
  await assert.rejects(run(),e=>['extraction_in_progress','storage_unavailable'].includes(e.code));
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${pages}`).get().n,0);assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${parts}`).get().n,0);
  const row=db.sqlite.prepare(`SELECT * FROM ${parent}`).get();assert.equal(row.revision,0);assert.equal(row.lease_token,null);assert.equal(row.lease_expires,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_snapshots').get().n,1);assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.sqlite.close();}
});
