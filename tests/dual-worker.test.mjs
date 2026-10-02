import test from 'node:test';
import assert from 'node:assert/strict';
import {localDb} from './sqlite-adapter.mjs';
import {handleAcquisition,workerConfiguration} from '../lib/acquisition-handler.mjs';
import {dualWorkerRegressions} from '../scripts/dual-worker-regressions.mjs';
import {TranscriptService} from '../lib/transcript-service.mjs';
import {transcriptBatch} from '../lib/transcript-batch.mjs';
test('actual SQLite: dual signatures, claim pin, in-flight Mac, fencing, config and attested provenance',async()=>{
 const db=localDb();let env;
 const result=await dualWorkerRegressions({db,setConfig:async config=>{env={DB:db,...config};},invoke:request=>handleAcquisition(request,env)});
 const service=new TranscriptService(db,{extractorFactory:()=>assert.fail('cached provenance must not fetch')}),batch=await transcriptBatch(service,{videos:['dualvideo01']},'service:mcp');
 assert.equal(batch.results[0].acquisition_context,'private_signed_worker');assert.equal(batch.results[0].acquisition_worker_id,result.secondaryId);assert.equal(batch.results[0].delivery,'full');assert.equal(batch.results[0].cache_status,'hit');
});
test('worker pin hash exactly matches approved Mac identity without reading private state',async()=>{
 const config=await workerConfiguration({ACQUISITION_PUBLIC_KEY:'e29bcc2b63f374b9232aaa43a5993969e8862c75ae9986ea11fd581daed5f5fd',ACQUISITION_CLAIM_WORKER_ID:'119fb29162712fde69ce2e68f20d85af0e0133c8fba84f00a76f96c66a2fdc46'});assert.equal(config.keys[0].workerId,config.pin);
});
