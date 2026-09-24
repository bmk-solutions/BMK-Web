import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mkdir,readFile,realpath,writeFile,rename,lstat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureProcessingTables,imageFingerprint} from '../../src/lib/imo3d/processing-jobs.ts';
import {checkWorkerRuntime} from './imo3d-worker-runtime.mjs';
import {savePlanSpatialEvidence} from '../../src/lib/imo3d/plan-spatial-evidence.ts';

const MAX_IMAGE_BYTES=100*1024*1024;
const idPattern=/^[A-Za-z0-9_-]{1,80}$/;
const filenamePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const assetId=url=>/^\/api\/imo3d\/assets\/([A-Za-z0-9_-]{1,80})$/.exec(url??'')?.[1];
const assertId=value=>{if(typeof value!=='string'||!idPattern.test(value))throw Error('INVALID_JOB_IDENTIFIER');return value;};
const inside=(root,target)=>{const relative=path.relative(root,target);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
export class WorkerLeaseLost extends Error {constructor(){super('WORKER_LEASE_LOST');this.name='WorkerLeaseLost';}}
export function safeWorkerMessage(value){return String(value??'').replace(/[A-Za-z]:[\\/][^\r\n"<>|]+/g,'[local path]').slice(0,1000);}
export const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateLocalResult(source,local){
  const candidate=local?.tour;
  if(!candidate||candidate.id!==source.id||candidate.projectId!==source.projectId||![source.revision,source.revision+1].includes(candidate.revision)||!['completed','review'].includes(local.status))throw Error('INVALID_LOCAL_RESULT');
  if(candidate.title!==source.title||candidate.createdAt!==source.createdAt||candidate.published!==source.published||!isDeepStrictEqual(candidate.unit,source.unit))throw Error('LOCAL_RESULT_CHANGED_PROJECT_METADATA');
  if(!Array.isArray(candidate.scenes)||candidate.scenes.length!==source.scenes.length||new Set(candidate.scenes.map(scene=>scene.id)).size!==source.scenes.length)throw Error('LOCAL_RESULT_CHANGED_SCENES');
  const originals=new Map(source.scenes.map(scene=>[scene.id,scene]));
  for(const scene of candidate.scenes){
    const original=originals.get(scene.id);if(!original)throw Error('LOCAL_RESULT_CHANGED_SCENES');
    for(const key of ['image','preview','thumbnail','sourceName','floor','detail'])if(!isDeepStrictEqual(scene[key],original[key]))throw Error('LOCAL_RESULT_CHANGED_SOURCE_MEDIA');
  }
}
export function verifyDownloadedObject(bytes,record){
  if(!bytes.byteLength||bytes.byteLength>MAX_IMAGE_BYTES)throw Error('INVALID_ASSET_SIZE');
  if(record.byte_size!=null&&Number(record.byte_size)!==bytes.byteLength)throw Error('ASSET_SIZE_MISMATCH');
  if(record.sha256!=null&&(!/^[a-f0-9]{64}$/i.test(record.sha256)||hashBytes(bytes)!==record.sha256.toLowerCase()))throw Error('ASSET_HASH_MISMATCH');
}

/** Validate ownership and prepare only the image inputs the local pipeline reads. */
export function buildLocalInputPlan(tour,assets,originals){
  assertId(tour?.id);assertId(tour?.projectId);
  if(!Number.isInteger(tour.revision)||!Array.isArray(tour.scenes)||tour.scenes.length<2||tour.scenes.length>300)throw Error('INVALID_PROCESSING_TOUR');
  const byId=new Map(),byScene=new Map(),downloads=new Map();
  function validate(record){
    if(record.tour_id!==tour.id||!filenamePattern.test(record.file??'')||record.file==='.'||record.file==='..')throw Error('INVALID_ASSET_OWNERSHIP_OR_PATH');
    if(typeof record.storage_key!=='string'||!record.storage_key||record.storage_key.startsWith('/')||record.storage_key.includes('\\')||record.storage_key.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('INVALID_STORAGE_KEY');
    if(record.byte_size!=null&&(!Number.isSafeInteger(Number(record.byte_size))||Number(record.byte_size)<=0||Number(record.byte_size)>MAX_IMAGE_BYTES))throw Error('INVALID_ASSET_SIZE');
  }
  for(const record of assets){validate(record);assertId(record.id);if(byId.has(record.id))throw Error('DUPLICATE_ASSET');byId.set(record.id,record);}
  for(const record of originals){validate(record);assertId(record.scene_id);if(byScene.has(record.scene_id))throw Error('DUPLICATE_ORIGINAL');byScene.set(record.scene_id,record);}
  const add=record=>{
    if(!record)throw Error('PROCESSING_INPUT_MISSING');
    const previous=downloads.get(record.file);
    if(previous&&previous.storage_key!==record.storage_key)throw Error('CONFLICTING_LOCAL_FILENAME');
    downloads.set(record.file,record);
  };
  const sceneIds=new Set();
  for(const scene of tour.scenes){
    assertId(scene.id);if(sceneIds.has(scene.id))throw Error('DUPLICATE_SCENE');sceneIds.add(scene.id);
    add(byScene.get(scene.id)??byId.get(assetId(scene.image)));
    add(byId.get(assetId(scene.preview)));
  }
  return {tour:structuredClone(tour),assets:[...assets],originals:[...originals],downloads:[...downloads.values()]};
}

/** Every attempt is a new child of this repository's ignored work directory. */
export async function createJobWorkspace(root,jobId){
  assertId(jobId);root=await realpath(root);
  let parent=root;
  for(const part of ['work','cloud-worker',jobId]){
    const next=path.join(parent,part);await mkdir(next,{recursive:true});
    const resolved=await realpath(next);if(!inside(root,resolved))throw Error('WORKSPACE_OUTSIDE_PROJECT');parent=resolved;
  }
  const attempt=path.join(parent,randomUUID());await mkdir(attempt);
  const resolved=await realpath(attempt);if(!inside(root,resolved))throw Error('WORKSPACE_OUTSIDE_PROJECT');
  await mkdir(path.join(resolved,'assets'));
  return resolved;
}
export function seedLocalMirror(directory,input,job){
  if(path.basename(directory)==='.imo3d-data')throw Error('SOURCE_DATABASE_REFUSED');
  const database=new DatabaseSync(path.join(directory,'imo3d.sqlite'));
  try{
    if(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count)throw Error('NONEMPTY_MIRROR_REFUSED');
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,published INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),file TEXT NOT NULL,mime TEXT NOT NULL);
      CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),file TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);`);
    ensureProcessingTables(database);const tour=input.tour;
    database.exec('BEGIN IMMEDIATE');
    try{
      database.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(tour.projectId,tour.title,'',tour.createdAt);
      database.prepare('INSERT INTO tours VALUES(?,?,?,?,?)').run(tour.id,tour.projectId,tour.revision,tour.published?1:0,JSON.stringify(tour));
      for(const row of input.assets)database.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(row.id,tour.id,row.file,row.mime);
      for(const row of input.originals)database.prepare('INSERT INTO scene_originals VALUES(?,?,?,?,?,?)').run(row.scene_id,tour.id,row.file,row.mime,row.width,row.height);
      const now=new Date().toISOString();
      database.prepare("INSERT INTO processing_jobs(id,tour_id,status,stage,created_at,updated_at,input_hash) VALUES(?,?,'queued','Local cloud-worker attempt',?,?,?)").run(job.id,tour.id,now,now,imageFingerprint(tour.scenes));
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
  }finally{database.close();}
}
function cancelLocalMirror(directory,jobId){
  const database=new DatabaseSync(path.join(directory,'imo3d.sqlite'));
  try{database.prepare("UPDATE processing_jobs SET cancel_requested=1,status='cancelled' WHERE id=? AND status IN ('queued','running')").run(jobId);}finally{database.close();}
}

// The Python children read uploaded images: they get no cloud setting and no credential. Besides the
// named keys, any credential-shaped name is dropped, so a secret added to the env file later is too.
const childDeniedKeys=new Set(['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_DATABASE_PASSWORD','IMO3D_CLOUD_PROJECT_REF','IMO3D_CLOUD','OPENAI_API_KEY','GEMINI_API_KEY','HIGGSFIELD_API_KEY','IMO3D_PLAN_RUNNER_SECRET','IMO3D_ADMIN_SECRET','IMO3D_SESSION_SECRET','CRON_SECRET']);
const credentialName=/(?:^|_)(?:SECRETS?|TOKENS?|PASSWORDS?|PASSWD|CREDENTIALS?|KEYS?)(?:_|$)|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SERVICE_ROLE/i;
export function reconstructionChildEnvironment(source,directory){
  const kept=Object.entries(source).filter(([key,value])=>value!==undefined&&!childDeniedKeys.has(key.toUpperCase())&&!credentialName.test(key));
  return {...Object.fromEntries(kept),IMO3D_DATA_DIR:directory,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYTHONDONTWRITEBYTECODE:'1'};
}

export async function runLocalReconstruction({root,directory,job,signal,onProgress,maxJobMs=3*60*60_000}){
  signal.throwIfAborted();
  const database=new DatabaseSync(path.join(directory,'imo3d.sqlite'),{readOnly:true});
  const log=[];let logBytes=0,killTimer,timeout;
  const childEnv=reconstructionChildEnvironment(process.env,directory);
  const child=spawn(process.execPath,[path.join(root,'scripts','imo3d-worker.mjs')],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:childEnv,
  });
  const capture=chunk=>{if(logBytes<1024*1024){const bytes=Buffer.from(chunk).subarray(0,1024*1024-logBytes);logBytes+=bytes.length;log.push(bytes);}};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;try{cancelLocalMirror(directory,job.id);}catch{/* The isolated process still receives the bounded termination fallback. */}killTimer=setTimeout(()=>child.kill('SIGTERM'),15000);};
  signal.addEventListener('abort',stop,{once:true});
  timeout=setTimeout(stop,maxJobMs);
  const progress=setInterval(()=>{try{const row=database.prepare('SELECT progress,stage FROM processing_jobs WHERE id=?').get(job.id);if(row)onProgress(Number(row.progress),String(row.stage));}catch{/* Do not replace the authoritative remote lease with a local read failure. */}},1000);
  try{
    const code=await new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve);});
    signal.throwIfAborted();if(stopped)throw Error('LOCAL_PROCESSING_TIMEOUT');
    const row=database.prepare('SELECT * FROM processing_jobs WHERE id=?').get(job.id);
    if(code!==0||!row||!['completed','review'].includes(row.status))throw Error('LOCAL_PROCESSING_FAILED');
    const tour=JSON.parse(database.prepare('SELECT payload FROM tours WHERE id=?').get(job.tour_id).payload);
    const spatialFile=path.join(directory,'processing',job.id,'result.json');
    const spatialEvidence=await lstat(spatialFile).then(info=>info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024*1024?readFile(spatialFile,'utf8').then(JSON.parse):undefined).catch(()=>undefined);
    return {tour,spatialEvidence,status:row.status,stage:row.stage,result:row.result?JSON.parse(row.result):null,warnings:JSON.parse(row.warnings??'[]'),assets:database.prepare('SELECT * FROM assets WHERE tour_id=?').all(job.tour_id)};
  }finally{
    clearInterval(progress);clearTimeout(timeout);clearTimeout(killTimer);signal.removeEventListener('abort',stop);database.close();
    await writeFile(path.join(directory,'worker.log'),Buffer.concat(log),{flag:'wx'}).catch(()=>{});
  }
}

export function createWorkerTransport(config,{fetchImpl=fetch}={}){
  const parsed=new URL(config.url);
  if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.supabase.co')||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash||!config.serviceRoleKey)throw Error('INVALID_CLOUD_WORKER_CONFIGURATION');
  if(config.projectRef&&parsed.hostname!==`${config.projectRef}.supabase.co`)throw Error('CLOUD_WORKER_PROJECT_MISMATCH');
  const url=parsed.origin,storageUrl=parsed.origin.replace('.supabase.co','.storage.supabase.co'),bucket='imo3d-private';
  const identifier=name=>{if(!/^[a-z][a-z0-9_]*$/.test(name))throw Error('INVALID_CLOUD_IDENTIFIER');return name.startsWith('imo3d_')?name:`imo3d_${name}`;};
  const objectPath=key=>{if(typeof key!=='string'||!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('INVALID_STORAGE_KEY');return key.split('/').map(encodeURIComponent).join('/');};
  async function request(endpoint,{signal,timeoutMs=60000,...init}={}){
    const headers=new Headers(init.headers);headers.set('apikey',config.serviceRoleKey);headers.set('Authorization',`Bearer ${config.serviceRoleKey}`);
    const timeoutSignal=AbortSignal.timeout(timeoutMs);
    const response=await fetchImpl((endpoint.startsWith('/storage/v1/')?storageUrl:url)+endpoint,{...init,headers,cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal});
    if(!response.ok){const body=await response.json().catch(()=>null);const error=Error('CLOUD_WORKER_REQUEST_FAILED');error.status=response.status;error.code=typeof body?.code==='string'?body.code:String(response.status);throw error;}return response;
  }
  return {
    async query(table,query,options={}){return (await request(`/rest/v1/${identifier(table)}?${query}`,options)).json();},
    async rpc(name,args,options={}){const response=await request(`/rest/v1/rpc/${identifier(name)}`,{...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});const text=await response.text();return text?JSON.parse(text):null;},
    async download(key,{signal,maxBytes=MAX_IMAGE_BYTES}={}){
      const response=await request(`/storage/v1/object/authenticated/${bucket}/${objectPath(key)}`,{signal,timeoutMs:120000});
      if(Number(response.headers.get('content-length'))>maxBytes)throw Error('ASSET_TOO_LARGE');
      const reader=response.body?.getReader();if(!reader)throw Error('ASSET_BODY_MISSING');
      const chunks=[];let total=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes)throw Error('ASSET_TOO_LARGE');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      return Buffer.concat(chunks,total);
    },
    async upload(key,bytes,mime,{signal}={}){await request(`/storage/v1/object/${bucket}/${objectPath(key)}`,{signal,timeoutMs:120000,method:'POST',headers:{'Content-Type':mime,'x-upsert':'false'},body:bytes});},
  };
}

function startLease(transport,job,owner,controller,getProgress,{leaseMs=30000,heartbeatMs=5000}={}){
  let stopped=false,inFlight=null,lost=false;
  const beat=async()=>{
    if(stopped)return;if(inFlight)return inFlight;
    inFlight=(async()=>{
      try{const progress=getProgress();const held=await transport.rpc('heartbeat_job',{p_id:job.id,p_owner:owner,p_progress:Math.max(0,Math.min(99,progress.value)),p_stage:progress.stage,p_lease_ms:leaseMs},{signal:controller.signal,timeoutMs:8000});if(!held)throw new WorkerLeaseLost();}
      catch{if(!stopped){lost=true;controller.abort(new WorkerLeaseLost());}}
      finally{inFlight=null;}
    })();
    return inFlight;
  };
  const timer=setInterval(()=>void beat(),heartbeatMs);
  return {beat,lost:()=>lost,async stop(){stopped=true;clearInterval(timer);if(inFlight)await inFlight;}};
}

export async function processCloudJob({root,transport,job,owner,signal,executeLocal=runLocalReconstruction,leaseOptions,checkRuntime=checkWorkerRuntime}){
  assertId(job?.id);assertId(job?.tour_id);
  if(job.lease_owner!==owner||job.cancel_requested||job.status!=='running')throw new WorkerLeaseLost();
  const controller=new AbortController();const abort=()=>controller.abort(signal.reason??new Error('WORKER_STOPPED'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let progress={value:0,stage:'تجهيز الصور على عامل المعالجة المحلي'},directory;
  const lease=startLease(transport,job,owner,controller,()=>progress,leaseOptions);
  try{
    controller.signal.throwIfAborted();
    progress={value:0,stage:'فحص محرك المعالجة قبل تجهيز الصور'};
    await lease.beat();
    const health=await checkRuntime(root,{signal:controller.signal});
    controller.signal.throwIfAborted();
    if(!health.ok)throw Error('LOCAL_RUNTIME_UNAVAILABLE');
    const [tourRows,assets,originals]=await Promise.all([
      transport.query('tours',`id=eq.${encodeURIComponent(job.tour_id)}&select=payload,revision,project_id&limit=1`,{signal:controller.signal}),
      transport.query('assets',`tour_id=eq.${encodeURIComponent(job.tour_id)}&select=*`,{signal:controller.signal}),
      transport.query('scene_originals',`tour_id=eq.${encodeURIComponent(job.tour_id)}&select=*`,{signal:controller.signal}),
    ]);
    const row=tourRows[0],tour=row?.payload;
    if(!tour||tour.id!==job.tour_id||tour.projectId!==row.project_id||tour.revision!==row.revision||imageFingerprint(tour.scenes)!==job.input_hash)throw Error('STALE_PROCESSING_INPUT');
    const input=buildLocalInputPlan(tour,assets,originals);directory=await createJobWorkspace(root,job.id);
    let completed=0,nextDownload=0,downloadError;
    const cache=path.join(root,'work','cloud-input-cache',assertId(tour.id));await mkdir(cache,{recursive:true});
    await Promise.all(Array.from({length:Math.min(3,input.downloads.length)},async()=>{
      while(!downloadError){
        const index=nextDownload++;if(index>=input.downloads.length)return;const record=input.downloads[index];
        try{
          controller.signal.throwIfAborted();
          const cached=/^[a-f0-9]{64}$/i.test(record.sha256??'')?path.join(cache,record.sha256.toLowerCase()):null;
          let bytes=cached?await readFile(cached).catch(()=>null):null;
          if(bytes)try{verifyDownloadedObject(bytes,record);}catch{bytes=null;}
          if(!bytes){
            bytes=await transport.download(record.storage_key,{signal:controller.signal});verifyDownloadedObject(bytes,record);
            if(cached){const temporary=cached+'.'+randomUUID()+'.tmp';await writeFile(temporary,bytes);await rename(temporary,cached);}
          }
          controller.signal.throwIfAborted();await writeFile(path.join(directory,'assets',record.file),bytes,{flag:'wx'});completed++;
          progress={value:Math.min(2,2*completed/input.downloads.length),stage:`تجهيز صور المعالجة المحلية · ${completed}/${input.downloads.length}`};
        }catch(error){downloadError=error;}
      }
    }));
    if(downloadError)throw downloadError;
    seedLocalMirror(directory,input,job);
    const local=await executeLocal({root,directory,job,signal:controller.signal,onProgress:(value,stage)=>{progress={value,stage:safeWorkerMessage(stage)};}});
    controller.signal.throwIfAborted();
    validateLocalResult(tour,local);
    const sourceIds=new Set(assets.map(asset=>asset.id)),newAssets=[];
    for(const asset of local.assets??[]){
      if(sourceIds.has(asset.id))continue;
      assertId(asset.id);if(asset.tour_id!==tour.id||!filenamePattern.test(asset.file??''))throw Error('INVALID_RESULT_ASSET');
      const file=await realpath(path.join(directory,'assets',asset.file));if(!inside(directory,file))throw Error('RESULT_ASSET_OUTSIDE_WORKSPACE');
      const bytes=await readFile(file);if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw Error('INVALID_RESULT_ASSET_SIZE');
      const key=`processing/${tour.id}/${job.id}/${path.basename(directory)}/${asset.file}`;
      await transport.upload(key,bytes,asset.mime,{signal:controller.signal});
      newAssets.push({...asset,storage_key:key,sha256:hashBytes(bytes),byte_size:bytes.byteLength});
    }
    await lease.beat();controller.signal.throwIfAborted();await lease.stop();
    const warnings=(local.warnings??[]).map(safeWorkerMessage);
    const candidate=structuredClone(local.tour);if(candidate.quality?.warnings)candidate.quality.warnings=candidate.quality.warnings.map(safeWorkerMessage);
    const saved=await transport.rpc('commit_job',{p_id:job.id,p_owner:owner,p_expected_revision:tour.revision,p_input_hash:job.input_hash,p_tour:candidate,p_result:local.result??null,p_warnings:warnings,p_assets:newAssets,p_status:local.status,p_stage:safeWorkerMessage(local.stage??'اكتملت المعالجة المحلية')},{signal:controller.signal});
    // Optional plan hints cannot turn a successful authoritative commit into a failed job.
    if(local.spatialEvidence)await savePlanSpatialEvidence(root,candidate,local.spatialEvidence).catch(()=>console.warn('PLAN_SPATIAL_EVIDENCE_UNAVAILABLE'));
    return {status:'committed',jobId:job.id,revision:saved?.revision,directory};
  }catch(error){
    if(lease.lost()||error instanceof WorkerLeaseLost)return {status:'lease_lost',jobId:job.id,directory};
    const code=error?.message==='LOCAL_RUNTIME_UNAVAILABLE'?'LOCAL_RUNTIME_UNAVAILABLE':error?.message==='STALE_PROCESSING_INPUT'||error?.code==='40001'?'STALE_PROCESSING_INPUT':controller.signal.aborted?'LOCAL_WORKER_STOPPED':'LOCAL_PROCESSING_FAILED';
    const retry=code==='LOCAL_WORKER_STOPPED'||!controller.signal.aborted&&(error?.status===429||error?.status>=500||error?.name==='TimeoutError'||error?.name==='TypeError');
    await transport.rpc('fail_job',{p_id:job.id,p_owner:owner,p_error:code==='LOCAL_RUNTIME_UNAVAILABLE'?'محرك المعالجة على الجهاز يحتاج إصلاحًا. لم تبدأ إعادة تنزيل الصور؛ الصور المرفوعة محفوظة.':code,p_retry:retry},{timeoutMs:8000}).catch(()=>{});
    return {status:code==='STALE_PROCESSING_INPUT'?'stale':code==='LOCAL_WORKER_STOPPED'?'stopped':'failed',jobId:job.id,directory};
  }finally{await lease.stop();signal?.removeEventListener('abort',abort);}
}

export async function pollCloudJobs({root,transport,signal,once=false,pollMs=10000,onStatus=()=>{},owner=randomUUID(),executeLocal,checkRuntime}){
  if(!Number.isInteger(pollMs)||pollMs<1000||pollMs>60000)throw Error('INVALID_POLL_INTERVAL');
  let completed=0,failures=0;
  while(!signal.aborted){
    let job;
    try{job=await transport.rpc('claim_job',{p_owner:owner,p_lease_ms:30000},{signal,timeoutMs:15000});failures=0;}
    catch(error){
      if(signal.aborted)break;if(once)throw error;
      onStatus({status:'offline'});failures++;
      try{await delay(Math.min(60000,pollMs*2**Math.min(failures-1,3)),undefined,{signal});}catch{if(!signal.aborted)throw error;}
      continue;
    }
    if(job){const result=await processCloudJob({root,transport,job,owner,signal,executeLocal,checkRuntime});onStatus({status:result.status,jobId:job.id});completed++;}
    else onStatus({status:'idle'});
    if(once)return {processed:completed};
    try{await delay(job?250:pollMs,undefined,{signal});}catch(error){if(!signal.aborted)throw error;}
  }
  return {processed:completed};
}
