import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

// Hosted machines use their own executable, not a developer's Windows paths.
export async function workerRuntimePresent(root,env=process.env){
  try{
    let python=env.IMO3D_PYTHON;
    if(!python){const runtime=JSON.parse(await readFile(path.join(root,'work','reconstruction-runtime.json'),'utf8'));python=runtime.python;}
    if(!python)return false;
    await access(python);
    return true;
  }catch{return false;}
}

/** Before downloading a job, exercise the actual imports/native operations. */
export async function checkWorkerRuntime(root,{env=process.env,signal,timeoutMs=45000}={}){
  signal?.throwIfAborted();
  let python=env.IMO3D_PYTHON;
  if(!python)try{python=JSON.parse(await readFile(path.join(root,'work/reconstruction-runtime.json'),'utf8')).python;}catch{return {ok:false,failure:'configuration'};}
  if(!python)return {ok:false,failure:'configuration'};
  const childEnv={...env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of Object.keys(childEnv))if(/SECRET|TOKEN|PASSWORD|API_KEY|COOKIE|SERVICE_ROLE|DATABASE_URL/i.test(key))delete childEnv[key];
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[path.join(root,'scripts/imo3d-runtime-check.py')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','ignore'],env:childEnv});
    let output='',finished=false;
    const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result);};
    const abort=()=>{child.kill();if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new DOMException('Cancelled','AbortError'));};
    const timer=setTimeout(()=>{child.kill();finish({ok:false,failure:'timeout'});},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16000){child.kill();finish({ok:false,failure:'invalid-output'});}});
    child.once('error',()=>finish({ok:false,failure:'launch'}));
    child.once('close',code=>{
      try{const result=JSON.parse(output.trim().split('\n').at(-1));finish({ok:code===0&&result.ok===true,checks:Array.isArray(result.checks)?result.checks:[],...(result.ok===true?{}:{failure:'dependencies'})});}
      catch{finish({ok:false,failure:'invalid-output'});}
    });
  });
}
