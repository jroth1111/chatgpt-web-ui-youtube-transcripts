// Shared synthetic SQLite/workerd security scenarios; no production keys/network.
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signedRequest} from './private-acquisition-worker.mjs';
import {AcquisitionQueue} from '../lib/acquisition-queue.mjs';
import {digest} from '../lib/snapshot-cache.mjs';
export async function dualWorkerRegressions({db,invoke,setConfig}) {
 const base='https://synthetic.example',primary=generateKeyPairSync('ed25519'),secondary=generateKeyPairSync('ed25519'),stranger=generateKeyPairSync('ed25519');
 const hex=key=>key.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'),primaryId=await digest(hex(primary)),secondaryId=await digest(hex(secondary));
 const config={ACQUISITION_PUBLIC_KEY:hex(primary),ACQUISITION_SECONDARY_PUBLIC_KEY:hex(secondary)},queue=new AcquisitionQueue(db),checks=[];
 const signed=(key,route,input={})=>signedRequest(key.privateKey,'/api/acquisition/'+route,input,{base});
 const call=async(key,route,input={})=>{const response=await invoke(signed(key,route,input));return {status:response.status,body:await response.json()};};
 const fixture=id=>({video_id:id,source_url:`https://www.youtube.com/watch?v=${id}`,selected_language:'en',track_id:'a.en',caption_type:'manual',extractor_version:'synthetic-dual-worker',extraction_method:'innertube/timedtext/srv3',retrieved_at:new Date().toISOString(),segments:[{text:'Synthetic trusted-worker captions.',start:0,duration:1,duration_source:'upstream'}],acquisition_context:'forged',acquisition_worker_id:'forged'});
 await setConfig(config);await queue.enqueue('service:mcp','dualvideo00');const mac=await call(primary,'claim');assert.equal(mac.status,200);assert(mac.body.job);assert.equal((await db.prepare('SELECT worker_id FROM acquisition_jobs WHERE id=?').bind(mac.body.job.job_id).first()).worker_id,primaryId);
 const pin={...config,ACQUISITION_CLAIM_WORKER_ID:secondaryId};await setConfig(pin);await queue.enqueue('service:mcp','dualvideo01');
 const idleRequest=signed(primary,'claim'),replay=idleRequest.clone(),idle=await invoke(idleRequest);assert.equal(idle.status,200);assert.deepEqual(await idle.json(),{job:null,idle_reason:'claim_worker_pinned'});assert.equal((await invoke(replay)).status,401);
 const server=await call(secondary,'claim');assert(server.body.job);assert.equal((await db.prepare('SELECT worker_id FROM acquisition_jobs WHERE id=?').bind(server.body.job.job_id).first()).worker_id,secondaryId);
 await queue.enqueue('service:mcp','dualvideo03');assert.equal((await call(secondary,'claim')).body.job,null);assert.equal((await db.prepare('SELECT COUNT(*) n FROM extractor_leases').first()).n,2);
 assert.equal((await call(primary,'submit',{job_id:server.body.job.job_id,token:server.body.job.token,transcript:fixture('dualvideo01')})).status,403);
 const macSaved=await call(primary,'submit',{job_id:mac.body.job.job_id,token:mac.body.job.token,transcript:fixture('dualvideo00')});assert.equal(macSaved.status,200);
 const input={job_id:server.body.job.job_id,token:server.body.job.token,transcript:fixture('dualvideo01')},saved=await call(secondary,'submit',input);assert.equal(saved.status,200);
 const third=await call(secondary,'claim');assert(third.body.job);assert.equal((await call(secondary,'submit',{job_id:third.body.job.job_id,token:third.body.job.token,failure_code:'access_restriction'})).body.status,'failed');assert.equal((await call(secondary,'claim')).body.job,null);
 const freshReplay=await call(secondary,'submit',input);assert.equal(freshReplay.body.snapshot_id,saved.body.snapshot_id);assert.equal(freshReplay.body.replayed,true);
 const row=await db.prepare('SELECT metadata_json FROM transcript_snapshots WHERE id=?').bind(saved.body.snapshot_id).first(),metadata=JSON.parse(row.metadata_json);assert.equal(metadata.acquisition_context,'private_signed_worker');assert.equal(metadata.acquisition_worker_id,secondaryId);assert.notEqual(metadata.acquisition_worker_id,input.transcript.acquisition_worker_id);
 assert.equal(JSON.parse((await db.prepare('SELECT metadata_json FROM transcript_snapshots WHERE id=?').bind(macSaved.body.snapshot_id).first()).metadata_json).acquisition_worker_id,primaryId);
 checks.push('global_two_leases_and_terminal_denial_preserved','both_signatures_derive_matching_key_ID','pinned_Mac_idle_nonce_consumed','Mac_inflight_submit_allowed','cross_worker_submit_forbidden','idempotent_submit_and_server_attestation_ignore_client_forgery');
 assert.equal((await call(stranger,'claim')).status,401);
 const malformed=[{...config,ACQUISITION_SECONDARY_PUBLIC_KEY:''},{...config,ACQUISITION_SECONDARY_PUBLIC_KEY:'INVALID'},{...config,ACQUISITION_SECONDARY_PUBLIC_KEY:config.ACQUISITION_PUBLIC_KEY},{...config,ACQUISITION_CLAIM_WORKER_ID:''},{...config,ACQUISITION_CLAIM_WORKER_ID:'0'.repeat(64)},{...config,ACQUISITION_CLAIM_WORKER_ID:'INVALID'}];
 for(const bad of malformed){await setConfig(bad);assert.equal((await call(primary,'claim')).status,503);assert.equal((await call(secondary,'submit',input)).status,503);}
 checks.push('invalid_secondary_and_nonmember_pin_fail_closed_on_both_routes','unknown_signer_rejected');
 // Reuse the same successful track for another owner-scoped job: no metadata rewrite.
 await setConfig(pin);await queue.enqueue('service:mcp','dualvideo02');const old=await queue.cache.write('service:mcp',{...fixture('dualvideo02'),acquisition_context:'private_mac_worker',acquisition_worker_id:undefined});const oldMetadata=old.metadata_json;
 const claim=await call(secondary,'claim');assert.equal(claim.body.job,null);assert.equal((await db.prepare('SELECT metadata_json FROM transcript_snapshots WHERE id=?').bind(old.id).first()).metadata_json,oldMetadata);
 assert.equal((await queue.cache.latest('service:mcp','dualvideo01')).id,saved.body.snapshot_id);checks.push('successful_snapshot_cache_never_refetch_or_rewrite');
 await setConfig({ACQUISITION_PUBLIC_KEY:hex(primary)});assert.equal((await call(primary,'claim')).status,200);assert.equal((await call(secondary,'claim')).status,401);checks.push('primary_only_backward_compatible');
 await setConfig(pin);return {checks,primaryId,secondaryId,serverSnapshotId:saved.body.snapshot_id};
}
