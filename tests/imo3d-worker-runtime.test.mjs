import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workerRuntimePresent,checkWorkerRuntime} from '../scripts/lib/imo3d-worker-runtime.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture(t,source){
 const root=await mkdtemp(path.join(os.tmpdir(),'imo3d-runtime-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'scripts'));await writeFile(path.join(root,'scripts/imo3d-runtime-check.py'),source);
 return root;
}

test('preflight validates process success and strips cloud credentials from child',async t=>{
 const root=await fixture(t,`console.log(JSON.stringify({ok:!process.env.SUPABASE_SERVICE_ROLE_KEY&&!process.env.IMO3D_ADMIN_SECRET,checks:['native']}))`);
 const result=await checkWorkerRuntime(root,{env:{...process.env,IMO3D_PYTHON:process.execPath,SUPABASE_SERVICE_ROLE_KEY:'fake-secret',IMO3D_ADMIN_SECRET:'fake-secret'}});
 assert.equal(result.ok,true);assert.deepEqual(result.checks,['native']);
 await writeFile(path.join(root,'scripts/imo3d-runtime-check.py'),`console.log(JSON.stringify({ok:true}));process.exitCode=1;`);
 assert.equal((await checkWorkerRuntime(root,{env:{...process.env,IMO3D_PYTHON:process.execPath}})).ok,false);
});

test('preflight fails closed on timeout, malformed output and cancellation',async t=>{
 const root=await fixture(t,`setTimeout(()=>{},10000)`),options={env:{...process.env,IMO3D_PYTHON:process.execPath},timeoutMs:100};
 assert.equal((await checkWorkerRuntime(root,options)).failure,'timeout');
 const controller=new AbortController();controller.abort();await assert.rejects(checkWorkerRuntime(root,{...options,signal:controller.signal}),{name:'AbortError'});
 await writeFile(path.join(root,'scripts/imo3d-runtime-check.py'),`console.log('not a health response')`);
 assert.equal((await checkWorkerRuntime(root,{...options,timeoutMs:5000})).failure,'invalid-output');
});

test('hosted executable is accepted without a desktop runtime manifest',async()=>{
  assert.equal(await workerRuntimePresent('/not-a-local-repository',{IMO3D_PYTHON:process.execPath}),true);
});
test('missing hosted executable fails closed without falling back to desktop configuration',async()=>{
  assert.equal(await workerRuntimePresent(process.cwd(),{IMO3D_PYTHON:'/nonexistent/imo3d/python'}),false);
});
test('no environment and no runtime manifest reports setup required',async()=>{
  assert.equal(await workerRuntimePresent('/not-a-local-repository',{}),false);
});
