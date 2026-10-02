import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('worker health requires fresh heartbeat and signed API success, not merely a running process',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'transcript-health-fixture-'));
  try{
    const check=()=>spawnSync(process.execPath,['scripts/server-worker.mjs','--health-check'],{env:{...process.env,YOUTUBE_WORKER_ROOT:root}}).status;
    assert.equal(check(),1);
    for(const [record,expected] of [
      [{status:'running',at:Date.now(),lastApiSuccess:Date.now()},0],
      [{status:'running',at:Date.now()-100000,lastApiSuccess:Date.now()},1],
      [{status:'running',at:Date.now(),lastApiSuccess:Date.now()-100000},1],
      [{status:'authorization_latched_stop',at:Date.now(),lastApiSuccess:Date.now()},1],
    ]){await writeFile(path.join(root,'health.json'),JSON.stringify(record));assert.equal(check(),expected);}
  }finally{await rm(root,{recursive:true,force:true});}
});
