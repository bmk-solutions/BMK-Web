// Removes what the parked serverless plan runner (branch claude/cloud-plan-pipeline, run against
// production on 2026-09-24) left behind, and nothing else:
//   1. its lock row `plan-runner` in imo3d_processing_worker_lock, only while its lease has expired;
//   2. its two failed test jobs on the unpublished «Kids» tour (imo3d_subscription_plan_jobs);
//   3. its scratch objects under plan-runner/ in the private bucket imo3d-private.
//
//   node --env-file=.env.cloud.local scripts/imo3d-cleanup-plan-runner-residue.mjs            (dry run: lists, changes nothing)
//   node --env-file=.env.cloud.local scripts/imo3d-cleanup-plan-runner-residue.mjs --apply    (deletes exactly the listed items)
//
// The lock delete repeats its guard in the request (expired lease), and the job SQL repeats its own
// (failed status + unpublished tour), so a row that changed after the listing is not touched. Objects
// are deleted by the exact keys listed, each re-checked against the plan-runner/ prefix: one written
// again at a listed key between the listing and --apply would still be removed.
// The service role holds no DELETE on imo3d_subscription_plan_jobs (migration 20260915110000):
// the two job rows are listed with the scoped SQL a postgres session needs, never forced.
// Prints no credential.

const JOB_IDS=['43f7b320-0310-4726-9a6c-30fe17a8c125','4f0c25cb-79b7-4f48-be60-3cf2e968129a'];
const LOCK='plan-runner',PREFIX='plan-runner/',BUCKET='imo3d-private',RUN_DAY='2026-09-24';
const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>arg!=='--apply')){console.error('Usage: node --env-file=.env.cloud.local scripts/imo3d-cleanup-plan-runner-residue.mjs [--apply]');process.exit(1);}

// The same checks as cloudConfig() in src/lib/imo3d/cloud/client.ts, plus the worker's project guard.
const raw=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!raw||!serviceRoleKey)throw Error('IMO3D_CLOUD_CONFIG_MISSING');
const base=new URL(raw);
if(base.protocol!=='https:'||!base.hostname.endsWith('.supabase.co')||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('IMO3D_CLOUD_URL_INVALID');
const host=base.hostname,config={url:base.origin,storageUrl:`https://${host.replace(/\.supabase\.co$/,'.storage.supabase.co')}`,serviceRoleKey};
if(host!==`${process.env.IMO3D_CLOUD_PROJECT_REF}.supabase.co`)throw Error('PROJECT_MISMATCH');
const auth={apikey:config.serviceRoleKey,Authorization:`Bearer ${config.serviceRoleKey}`};
async function call(url,init={}){
 const response=await fetch(url,{...init,headers:{...auth,'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)});
 const text=await response.text();
 if(!response.ok){let code=String(response.status);try{code=JSON.parse(text).code??code;}catch{}throw Error(`${init.method??'GET'} ${new URL(url).pathname} failed: ${code}`);}
 return text?JSON.parse(text):null;
}
const rest=(path,init)=>call(`${config.url}/rest/v1/${path}`,init);
const storage=(path,init)=>call(`${config.storageUrl}/storage/v1/${path}`,init);

// 1. The lock row: inert once its lease has passed.
const now=Date.now();
const [lock]=await rest(`imo3d_processing_worker_lock?name=eq.${LOCK}&select=name,owner,lease_until`);
const lockPlan=lock?{name:lock.name,leaseUntil:new Date(Number(lock.lease_until)).toISOString(),inert:Number(lock.lease_until)<now}:null;

// 2. The two test jobs, with the tour they belong to.
const jobs=await rest(`imo3d_subscription_plan_jobs?id=in.(${JOB_IDS.join(',')})&select=id,tour_id,project_id,status,stage,created_at,draft_ids`);
const tourIds=[...new Set(jobs.map(job=>job.tour_id))];
const tours=tourIds.length?await rest(`imo3d_tours?id=in.(${tourIds.map(encodeURIComponent).join(',')})&select=id,published,payload->>title`):[];
const jobPlan=JOB_IDS.map(id=>{
 const job=jobs.find(row=>row.id===id);if(!job)return {id,found:false};
 const tour=tours.find(row=>row.id===job.tour_id);
 const eligible=job.status==='failed'&&!!tour&&tour.published===false&&String(job.created_at).startsWith(RUN_DAY)&&!job.draft_ids?.length;
 return {id,found:true,status:job.status,createdAt:job.created_at,stage:String(job.stage??'').slice(0,120),tourId:job.tour_id,tourTitle:tour?.title??null,tourPublished:tour?.published??null,eligible};
});
const eligibleJobs=jobPlan.filter(job=>job.eligible);
const jobSQL=eligibleJobs.length?`delete from public.imo3d_subscription_plan_jobs where id in (${eligibleJobs.map(job=>`'${job.id}'`).join(',')}) and status='failed' and tour_id in (select id from public.imo3d_tours where published=false);`:null;

// 3. The scratch objects: every file under plan-runner/, listed folder by folder.
async function listAll(folder){
 const files=[];
 for(let offset=0;;offset+=1000){
  const page=await storage(`object/list/${BUCKET}`,{method:'POST',body:JSON.stringify({prefix:folder,limit:1000,offset,sortBy:{column:'name',order:'asc'}})});
  for(const entry of page){
   const key=`${folder}/${entry.name}`;
   if(entry.id===null)files.push(...await listAll(key));
   else files.push({key,bytes:Number(entry.metadata?.size??0)});
  }
  if(page.length<1000)return files;
 }
}
const objects=(await listAll(PREFIX.slice(0,-1))).filter(object=>object.key.startsWith(PREFIX));
const plan={mode:apply?'apply':'dry-run',project:host.split('.')[0],
 lock:lockPlan?{...lockPlan,action:lockPlan.inert?'delete':'keep (lease still active)'}:'absent',
 jobs:jobPlan.map(job=>({...job,action:job.eligible?'delete with the postgres role (SQL below); the service role cannot':'keep'})),
 jobSQL,
 objects:{prefix:`${BUCKET}/${PREFIX}`,count:objects.length,bytes:objects.reduce((sum,object)=>sum+object.bytes,0),keys:objects.map(object=>object.key)}};
console.log(JSON.stringify(plan,null,1));
if(!apply)process.exit(0);

// --apply: objects first (batches of 100, prefix re-checked), then the lock with its lease guard.
const removed={objects:0,lock:0};
for(let index=0;index<objects.length;index+=100){
 const batch=objects.slice(index,index+100).map(object=>object.key).filter(key=>key.startsWith(PREFIX));
 const result=await storage(`object/${BUCKET}`,{method:'DELETE',body:JSON.stringify({prefixes:batch})});
 removed.objects+=Array.isArray(result)?result.length:0;
}
if(lockPlan?.inert){
 const rows=await rest(`imo3d_processing_worker_lock?name=eq.${LOCK}&lease_until=lt.${Date.now()}`,{method:'DELETE',headers:{Prefer:'return=representation'}});
 removed.lock=rows.length;
}
console.log(JSON.stringify({removed,jobsLeft:eligibleJobs.map(job=>job.id),note:eligibleJobs.length?'run jobSQL in a postgres session to remove the two job rows':'no job rows to remove'}));
