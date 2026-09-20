import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createWorkerTransport,pollCloudJobs} from './lib/imo3d-cloud-worker.mjs';
import {workerRuntimePresent} from './lib/imo3d-worker-runtime.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.some(value=>!['--once','--check'].includes(value))||args.includes('--once')&&args.includes('--check')){
  console.error('Usage: node --env-file=.env.imo3d-worker scripts/imo3d-cloud-worker.mjs [--check|--once]');
  process.exitCode=1;
}else{
  const config={url:process.env.SUPABASE_URL,serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY,projectRef:process.env.IMO3D_CLOUD_PROJECT_REF};
  const missing=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','IMO3D_CLOUD_PROJECT_REF'].filter(name=>!process.env[name]?.trim());
  const localRuntime=await workerRuntimePresent(root);
  if(missing.length||!localRuntime){
    console.error(JSON.stringify({status:'setup-required',missing,localRuntimeConfigured:localRuntime,networkContacted:false}));process.exitCode=1;
  }else{
    try{
      const transport=createWorkerTransport(config);
      if(args.includes('--check'))console.log(JSON.stringify({status:'configuration-present',localRuntimeConfigured:true,networkContacted:false,modelsOrCloudNotVerified:true}));
      else{
        const controller=new AbortController();
        const stop=()=>controller.abort(new Error('Local worker stopped.'));
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
        let lastStatus='';
        try{await pollCloudJobs({root,transport,signal:controller.signal,once:args.includes('--once'),onStatus:status=>{const value=JSON.stringify(status);if(value!==lastStatus){lastStatus=value;console.log(value);}}});}
        finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
      }
    }catch{console.error('Cloud worker could not complete the operation. Check the new-project credentials, connection and local runtime.');process.exitCode=1;}
  }
}
