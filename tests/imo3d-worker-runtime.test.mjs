import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerRuntimePresent} from '../scripts/lib/imo3d-worker-runtime.mjs';

test('hosted executable is accepted without a desktop runtime manifest',async()=>{
  assert.equal(await workerRuntimePresent('/not-a-local-repository',{IMO3D_PYTHON:process.execPath}),true);
});
test('missing hosted executable fails closed without falling back to desktop configuration',async()=>{
  assert.equal(await workerRuntimePresent(process.cwd(),{IMO3D_PYTHON:'/nonexistent/imo3d/python'}),false);
});
test('no environment and no runtime manifest reports setup required',async()=>{
  assert.equal(await workerRuntimePresent('/not-a-local-repository',{}),false);
});
