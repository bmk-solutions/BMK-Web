import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,realpath,stat,open,rename} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inside,decodeSqlValue,readMetadata} from './imo3d-export-cloud.mjs';

// Private, insert-only migration to one explicitly named NEW project. Dry-run is
// the default. No source writes, table updates, upserts, or object deletions.
export const IMPORT_TABLES=['projects','developers','project_developers','tours','assets','scene_originals','leads','request_limits','project_brand_assets','project_branding','integration_keys','processing_jobs','processing_worker_lock','ai_plan_jobs','approved_plan_refs'];
const slash=value=>value.replaceAll('\\','/');
const hash=value=>createHash('sha256').update(value).digest('hex');
const mime=file=>({'.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json','.glb':'model/gltf-binary','.ply':'application/octet-stream'}[path.extname(file).toLowerCase()]??'application/octet-stream');
export function stableAssetId(tourId,url){const hex=hash(`${tourId}\0${url}`).slice(0,32).split('');hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const s=hex.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export function aiFingerprint(scenes){return hash(JSON.stringify(scenes.map(({id,image,floor})=>({id,image,floor})).sort((a,b)=>a.id.localeCompare(b.id))));}
function decodeRow(row){return Object.fromEntries(Object.entries(row).map(([key,value])=>{const decoded=decodeSqlValue(value);if(typeof decoded==='bigint'){const n=Number(decoded);if(!Number.isSafeInteger(n))return [key,String(decoded)];return [key,n];}return [key,decoded];}));}
function mapTree(value,transform){if(typeof value==='string')return transform(value);if(Array.isArray(value))return value.map(item=>mapTree(item,transform));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapTree(item,transform)]));return value;}
function json(value,fallback=null){return value==null?fallback:typeof value==='string'?JSON.parse(value):value;}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
export function buildImportPlan({metadata,files,manifest,root}){
  const exportId=path.basename(manifest.outputDirectory);
  if(!/^[A-Za-z0-9-]+$/.test(exportId))throw new Error('Invalid export ID.');
  const inventory=new Map(files.inventory.map(item=>[item.file,item]));
  const objects=files.inventory.map(item=>({...item,key:`imports/${exportId}/files/${item.sha256}/${path.basename(item.file)}`,mime:mime(item.file)}));
  const byFile=new Map(objects.map(item=>[item.file,item]));
  const tables=Object.fromEntries(IMPORT_TABLES.map(name=>[name,(metadata.tables[name]?.rows??[]).map(decodeRow)]));
  const fileObject=file=>{const relative=slash(path.relative(root,path.resolve(root,file)));const found=byFile.get(relative);if(!found)throw new Error('An imported record references a file outside the verified inventory.');return found;};
  const assetFields=file=>{const item=fileObject(file);return {storage_key:item.key,sha256:item.sha256,byte_size:item.bytes};};
  for(const table of ['assets','scene_originals'])tables[table]=tables[table].map(row=>({...row,...assetFields(path.join(files.dataDirectory,'assets',row.file))}));
  tables.project_brand_assets=tables.project_brand_assets.map(row=>{
    const bytes=Buffer.from(row.bytes);const sha256=hash(bytes),key=`imports/${exportId}/branding/${row.id}/${sha256}.webp`;
    objects.push({key,mime:row.mime,bytes:bytes.length,sha256,embeddedBase64:bytes.toString('base64')});
    const rest={...row};delete rest.bytes;return {...rest,storage_key:key,sha256,byte_size:bytes.length};
  });
  for(const row of tables.integration_keys)row.scopes=json(row.scopes,[]);
  const sourceHashes=new Map(),targetHashes=new Map(),tourById=new Map();
  tables.tours=tables.tours.map(row=>{
    const source=json(row.payload);sourceHashes.set(row.id,aiFingerprint(source.scenes));
    const mappings=new Map();
    const payload=mapTree(source,value=>{
      if(!value.startsWith('/imo3d/'))return value;
      if(!mappings.has(value)){
        const url=new URL(value,'https://imo3d.invalid');const relative=`public${decodeURIComponent(url.pathname)}`;
        const item=fileObject(relative),id=stableAssetId(row.id,value);
        const target=`/api/imo3d/assets/${id}`;mappings.set(value,target);
        if(tables.assets.some(asset=>asset.id===id))throw new Error('Deterministic example asset ID collision.');
        tables.assets.push({id,tour_id:row.id,file:path.basename(relative),mime:item.mime,storage_key:item.key,sha256:item.sha256,byte_size:item.bytes});
      }
      return mappings.get(value);
    });
    targetHashes.set(row.id,aiFingerprint(payload.scenes));tourById.set(row.id,payload);
    return {...row,published:!!row.published,payload};
  });
  for(const row of tables.processing_jobs){row.cancel_requested=!!row.cancel_requested;row.result=json(row.result);row.warnings=json(row.warnings,[]);if(['queued','running'].includes(row.status))throw new Error('Active local jobs must finish or be cancelled before migration.');}
  for(const row of tables.ai_plan_jobs){
    if(['queued','running'].includes(row.status))throw new Error('Active AI jobs must finish or be cancelled before migration.');
    row.lease_owner=null;
    const originalResult=json(row.result);
    row.result=mapTree(originalResult,value=>{
      if(path.isAbsolute(value)&&inside(root,path.resolve(value))){
        const relative=slash(path.relative(root,path.resolve(value)));
        if(inventory.has(relative))return `imo3d-storage://${fileObject(relative).key}`;
      }
      return value;
    });
    // Only an input hash that matched the source tour is translated. Historical
    // stale jobs retain their stale status and cannot acquire a new valid hash.
    if(row.input_hash===sourceHashes.get(row.tour_id))row.input_hash=targetHashes.get(row.tour_id);
  }
  const latest=new Map();
  for(const row of tables.ai_plan_jobs){const prev=latest.get(row.tour_id);if(!prev||Date.parse(row.created_at)>=Date.parse(prev.created_at))latest.set(row.tour_id,row);}
  for(const job of latest.values()){
    if(!['draft','completed'].includes(job.status)||job.input_hash!==targetHashes.get(job.tour_id))continue;
    const tour=tourById.get(job.tour_id);if(!tour)throw new Error('Plan tour is missing.');
    for(const floor of job.result?.floors??[]){
      if(typeof floor.imagePath!=='string'||!floor.imagePath.startsWith('imo3d-storage://'))throw new Error('Plan image is missing from the verified inventory.');
      const key=floor.imagePath.slice('imo3d-storage://'.length),item=objects.find(object=>object.key===key);
      if(!item)throw new Error('Plan storage object is missing.');
      tables.approved_plan_refs.push({tour_id:job.tour_id,floor:floor.floor,job_id:job.id,storage_key:key,sha256:item.sha256,navigation:floor.navigation??null,public_metadata:{source:job.result.source??'draft',sceneCount:job.result.sceneCount,limitations:job.result.limitations??[],audit:floor.audit??null},scene_ids:floor.sceneIds??[],input_hash:job.input_hash});
    }
  }
  const uniqueObjects=[...new Map(objects.map(item=>[item.key,item])).values()];
  return {format:'imo3d-private-import-plan',version:1,exportId,sourceFingerprint:manifest.sourceFingerprint,sourceRoot:root,sourceDataDirectory:files.dataDirectory,tables,objects:uniqueObjects,counts:Object.fromEntries(IMPORT_TABLES.map(name=>[name,tables[name].length])),sourceCounts:manifest.totals.tableCounts,sceneCount:tables.tours.reduce((n,row)=>n+row.payload.scenes.length,0),publishedCount:tables.tours.filter(row=>row.published).length};
}
async function fileHash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function safePath(root,file){const resolved=await realpath(file);if(!inside(root,resolved))throw new Error('Export input resolves outside the authorized project.');return resolved;}
export async function loadVerifiedExport(root,exportPath){
  root=await realpath(root);const directory=await safePath(root,path.resolve(root,exportPath));
  if(!inside(path.join(root,'work','cloud-export'),directory))throw new Error('Only an ignored work/cloud-export package can be imported.');
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.status!=='verified-local-export'||!manifest.sourceUnchanged||manifest.issues?.length)throw new Error('Export has not passed verification.');
  const metadataBytes=await readFile(path.join(directory,'metadata.json'));
  if(hash(metadataBytes)!==manifest.metadata.sha256||await fileHash(path.join(directory,'snapshot.sqlite'))!==manifest.snapshot.sha256)throw new Error('Export checksum mismatch.');
  const metadata=JSON.parse(metadataBytes),files=JSON.parse(await readFile(path.join(directory,'files.json'),'utf8'));
  if(path.resolve(files.sourceRoot)!==root)throw new Error('Export root no longer matches this project.');
  const allowed=[path.resolve(root,files.dataDirectory,'assets'),path.resolve(root,files.dataDirectory,'ai-plans'),path.join(root,'public','imo3d')];
  for(const item of files.inventory){
    const file=await safePath(root,path.resolve(root,item.file));
    if(!allowed.some(base=>inside(base,file)))throw new Error('Inventory includes a path outside private media directories.');
    if((await stat(file)).size!==item.bytes||await fileHash(file)!==item.sha256)throw new Error('Source media checksum mismatch. Generate a fresh export.');
  }
  const sourcePath=await safePath(root,path.resolve(root,files.dataDirectory,'imo3d.sqlite'));
  const source=new DatabaseSync(sourcePath,{readOnly:true});let fingerprint;
  try{fingerprint=readMetadata(source).fingerprint;}finally{source.close();}
  if(fingerprint!==manifest.sourceFingerprint||metadata.fingerprint!==fingerprint)throw new Error('Local metadata changed after export. Generate a fresh export.');
  return {directory,plan:buildImportPlan({metadata,files,manifest,root})};
}
export function verifyTargetConfiguration(projectRef,env=process.env){
  if(!/^[a-z0-9]{20}$/.test(projectRef))throw new Error('An exact new Supabase project reference is required.');
  const url=new URL(env.SUPABASE_URL??'https://invalid.invalid');
  if(url.origin!==`https://${projectRef}.supabase.co`||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Supabase URL does not match the explicitly selected new project.');
  if(!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Server credentials are missing.');
  return {url:url.origin,key:env.SUPABASE_SERVICE_ROLE_KEY,projectRef,bucket:'imo3d-private'};
}
const objectPath=key=>{if(key.split('/').some(x=>!x||x==='.'||x==='..')||key.includes('\\'))throw new Error('Invalid object key.');return key.split('/').map(encodeURIComponent).join('/');};
function endpointLabel(endpoint){
  const pathname=new URL(endpoint,'https://placeholder.invalid').pathname;
  if(pathname.startsWith('/rest/v1/imo3d_')||pathname.startsWith('/rest/v1/rpc/imo3d_'))return pathname;
  if(pathname.startsWith('/storage/v1/upload/resumable'))return '/storage/v1/upload/resumable/{upload}';
  if(pathname.startsWith('/storage/v1/object/authenticated/'))return '/storage/v1/object/authenticated/{bucket}/{object}';
  if(pathname.startsWith('/storage/v1/object/list/'))return '/storage/v1/object/list/{bucket}';
  if(pathname.startsWith('/storage/v1/bucket/'))return '/storage/v1/bucket/{bucket}';
  return '/storage/v1/object/{bucket}/{object}';
}
const transientStatus=status=>[408,429,500,502,503,504,520,521,522,523,524].includes(status);
export function createCloudTransport(config,{fetcher=fetch,pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))}={}){
  const storageOrigin=`https://${config.projectRef}.storage.supabase.co`;
  return async(endpoint,init={})=>{
    const method=init.method??'GET',absolute=/^https:\/\//.test(endpoint);
    const url=absolute?new URL(endpoint):new URL(endpoint,endpoint.startsWith('/storage/')?storageOrigin:config.url);
    if(![config.url,storageOrigin].includes(url.origin)||url.username||url.password||url.hash)throw new Error('Unexpected cloud request destination.');
    const safeRead=['GET','HEAD'].includes(method)||method==='POST'&&url.pathname==='/storage/v1/object/list/imo3d-private';
    const attempts=safeRead?3:1;
    for(let attempt=1;attempt<=attempts;attempt++){
      const headers=new Headers(init.headers);headers.set('apikey',config.key);headers.set('Authorization',`Bearer ${config.key}`);
      let response;
      try{response=await fetcher(url.href,{...init,headers,signal:AbortSignal.timeout(120000)});}
      catch{
        if(attempt<attempts){await pause(attempt*500);continue;}
        throw new Error(`Cloud migration ${method} ${endpointLabel(url.href)} failed (network/timeout; ${attempt} attempt${attempt===1?'':'s'}). Private journal retained; no write was blindly retried.`);
      }
      if(response.ok)return response;
      const status=response.status;
      if(safeRead&&transientStatus(status)&&attempt<attempts){await response.body?.cancel();await pause(attempt*500);continue;}
      // Never include response bodies, Authorization, signed URLs or object names.
      await response.body?.cancel();throw new Error(`Cloud migration ${method} ${endpointLabel(url.href)} failed (HTTP ${status}; ${attempt} attempt${attempt===1?'':'s'}). Private journal retained; no write was blindly retried.`);
    }
    throw new Error('Cloud read retries exhausted.');
  };
}
async function fetchAll(request,table){let rows=[];for(let offset=0;;offset+=500){const page=await(await request(`/rest/v1/imo3d_${table}?select=*&limit=500&offset=${offset}`)).json();rows=rows.concat(page);if(page.length<500)return rows;}}
async function storageKeys(request,prefix=''){
  const found=[];
  for(let offset=0;;offset+=500){const page=await(await request('/storage/v1/object/list/imo3d-private',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix,limit:500,offset,sortBy:{column:'name',order:'asc'}})})).json();
    for(const item of page){if(typeof item.name!=='string'||item.name.includes('/')||item.name==='..'||item.name==='.')throw new Error('Unexpected storage inventory.');const key=prefix?`${prefix}/${item.name}`:item.name;if(item.id)found.push(key);else found.push(...await storageKeys(request,key));}
    if(page.length<500)return found;
  }
}
async function remoteHash(request,key){const response=await request(`/storage/v1/object/authenticated/imo3d-private/${objectPath(key)}`);const h=createHash('sha256');for await(const chunk of response.body)h.update(chunk);return h.digest('hex');}
function compareRecord(expected,actual){return Object.entries(expected).every(([key,value])=>{
  let a=actual[key],b=value;
  if(/_at$/.test(key)&&typeof a==='string'&&typeof b==='string'&&Number.isFinite(Date.parse(a))&&Number.isFinite(Date.parse(b))){a=new Date(a).toISOString();b=new Date(b).toISOString();}
  return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
});}
export async function verifyCloudMetadata(plan,request){
  for(const table of IMPORT_TABLES){const actual=await fetchAll(request,table),expected=plan.tables[table];if(actual.length!==expected.length)throw new Error(`Remote count verification failed for ${table}.`);
    const pk=row=>table==='approved_plan_refs'?`${row.tour_id}\0${row.floor}`:table==='project_developers'||table==='project_branding'?row.project_id:table==='scene_originals'?row.scene_id:table==='request_limits'?row.key:table==='processing_worker_lock'?row.name:row.id;
    const lookup=new Map(actual.map(row=>[pk(row),row]));for(const row of expected)if(!lookup.has(pk(row))||!compareRecord(row,lookup.get(pk(row))))throw new Error(`Remote row verification failed for ${table}.`);
  }
}
export async function uploadResumable(config,request,item,root){
  const init=await request('/storage/v1/upload/resumable',{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(item.bytes),'Upload-Metadata':Object.entries({bucketName:config.bucket,objectName:item.key,contentType:item.mime,cacheControl:'3600'}).map(([key,value])=>`${key} ${Buffer.from(value).toString('base64')}`).join(','),'x-upsert':'false'}});
  const rawLocation=init.headers.get('location');if(!rawLocation)throw new Error('Resumable upload location missing.');
  const location=new URL(rawLocation,config.url);
  if(![config.url,`https://${config.projectRef}.storage.supabase.co`].includes(location.origin)||!location.pathname.startsWith('/storage/v1/upload/resumable/'))throw new Error('Unexpected resumable upload location.');
  const file=item.embeddedBase64?null:await open(path.join(root,item.file),'r');
  const embedded=item.embeddedBase64?Buffer.from(item.embeddedBase64,'base64'):null;
  try{for(let offset=0;offset<item.bytes;){const size=Math.min(6*1024*1024,item.bytes-offset);const buffer=Buffer.allocUnsafe(size);if(file){const read=await file.read(buffer,0,size,offset);if(read.bytesRead!==size)throw new Error('Source changed during upload.');}else embedded.copy(buffer,0,offset,offset+size);
    let accepted=false;
    for(let attempt=1;attempt<=3&&!accepted;attempt++){
      try{const response=await request(location.href,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream','x-upsert':'false'},body:buffer});accepted=response.ok&&Number(response.headers.get('Upload-Offset'))===offset+size;}
      catch{/* An ambiguous write must be resolved by the authoritative TUS offset. */}
      if(!accepted){
        const head=await request(location.href,{method:'HEAD',headers:{'Tus-Resumable':'1.0.0'}});
        const raw=head.headers.get('Upload-Offset'),confirmed=raw===null?NaN:Number(raw);
        if(confirmed===offset+size)accepted=true;
        else if(confirmed!==offset)throw new Error('TUS HEAD returned an unexpected offset; stopped without retrying the chunk.');
        else if(attempt===3)throw new Error('TUS chunk failed after 3 attempts, each retry preceded by HEAD confirming no bytes committed; use --resume.');
      }
    }
    offset+=size;
  }}finally{await file?.close();}
}
export async function applyImport(plan,directory,projectRef,{resume=false,request:injectedRequest,env=process.env,onProgress}={}){
  const config=verifyTargetConfiguration(projectRef,env),request=injectedRequest??createCloudTransport(config);
  const journalPath=path.join(directory,'import-journal.json');
  let journal={format:'imo3d-private-import-journal',projectRef,exportId:plan.exportId,sourceFingerprint:plan.sourceFingerprint,uploaded:{},metadataImported:false,verified:false};
  if(resume){journal=JSON.parse(await readFile(journalPath,'utf8'));if(journal.projectRef!==projectRef||journal.exportId!==plan.exportId||journal.sourceFingerprint!==plan.sourceFingerprint)throw new Error('Resume journal target/export mismatch.');}
  else {try{await stat(journalPath);throw new Error('A prior attempt exists. Inspect its journal and use --resume.');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const existing={};for(const table of [...IMPORT_TABLES,'upload_sessions','brand_upload_sessions'])existing[table]=await(await request(`/rest/v1/imo3d_${table}?select=*&limit=1`)).json();
  if(journal.metadataImported){if(!resume)throw new Error('Target is not empty.');await verifyCloudMetadata(plan,request);}
  else if(Object.values(existing).some(rows=>rows.length)){
    // A lost response after the atomic RPC can leave committed rows before the
    // journal is flushed. Only an explicit resume of our matching prior journal
    // may adopt a byte-for-byte equivalent metadata set; never overwrite it.
    if(!resume||existing.upload_sessions.length||existing.brand_upload_sessions.length)throw new Error('Target is not empty. No data was modified.');
    await verifyCloudMetadata(plan,request);journal.metadataImported=true;
  }
  const bucket=await(await request('/storage/v1/bucket/imo3d-private')).json();if(bucket.public!==false)throw new Error('The migration bucket must be private.');
  const keys=await storageKeys(request),planned=new Map(plan.objects.map(item=>[item.key,item]));
  if(!resume&&keys.length||keys.some(key=>!planned.has(key)))throw new Error('Storage target is not empty or contains unrelated objects.');
  await writeFile(journalPath,JSON.stringify(journal,null,2),{mode:0o600,...(resume?{}:{flag:'wx'})});
  const persist=async()=>{const next=path.join(directory,'import-journal.next.json');await writeFile(next,JSON.stringify(journal,null,2),{mode:0o600});await rename(next,journalPath);};
  let completed=0;
  for(const item of plan.objects){
    if(keys.includes(item.key)){if(await remoteHash(request,item.key)!==item.sha256)throw new Error('Existing object hash mismatch; no overwrite permitted.');}
    else {
      if(item.bytes>6*1024*1024&&!injectedRequest)await uploadResumable(config,request,item,plan.sourceRoot);
      else {const bytes=item.embeddedBase64?Buffer.from(item.embeddedBase64,'base64'):await readFile(path.join(plan.sourceRoot,item.file));if(hash(bytes)!==item.sha256)throw new Error('Source changed before upload.');await request(`/storage/v1/object/imo3d-private/${objectPath(item.key)}`,{method:'POST',headers:{'Content-Type':item.mime,'x-upsert':'false'},body:bytes});}
      if(await remoteHash(request,item.key)!==item.sha256)throw new Error('Uploaded object hash mismatch.');
    }
    journal.uploaded[item.key]={sha256:item.sha256,bytes:item.bytes};await persist();completed++;
    if(completed%10===0||completed===plan.objects.length)onProgress?.({verifiedObjects:completed,totalObjects:plan.objects.length});
  }
  if(!journal.metadataImported){
    const source=new DatabaseSync(path.join(plan.sourceRoot,plan.sourceDataDirectory,'imo3d.sqlite'),{readOnly:true});
    try{if(readMetadata(source).fingerprint!==plan.sourceFingerprint)throw new Error('Local metadata changed during upload. No cloud metadata was inserted.');}finally{source.close();}
    // Recheck rows after the uploads and before the one atomic insert transaction.
    for(const table of [...IMPORT_TABLES,'upload_sessions','brand_upload_sessions'])if((await(await request(`/rest/v1/imo3d_${table}?select=*&limit=1`)).json()).length)throw new Error('Target changed while uploading. No metadata was inserted.');
    const counts=await(await request('/rest/v1/rpc/imo3d_import_metadata',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_tables:plan.tables,p_export_id:plan.exportId})})).json();
    if(IMPORT_TABLES.some(table=>Number(counts[table])!==plan.counts[table]))throw new Error('Imported counts do not match the verified plan.');
    journal.metadataImported=true;await persist();
  }
  await verifyCloudMetadata(plan,request);journal.verified=true;journal.verifiedAt=new Date().toISOString();await persist();
  return {status:'verified-cloud-import',projectRef,objects:plan.objects.length,counts:plan.counts,scenes:plan.sceneCount,publishedTours:plan.publishedCount};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};let invalid=false;
  for(let i=0;i<args.length;i++){if(['--export','--project-ref'].includes(args[i]))options[args[i].slice(2)]=args[++i];else if(['--apply','--resume'].includes(args[i]))options[args[i].slice(2)]=true;else invalid=true;}
  if(invalid||!options.export||!options['project-ref']||options.resume&&!options.apply){console.error('Usage: node scripts/imo3d-import-cloud.mjs --export work/cloud-export/<id> --project-ref <new-project-ref> [--apply [--resume]]');process.exitCode=1;}
  else try{
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const {directory,plan}=await loadVerifiedExport(root,options.export);
    if(!/^[a-z0-9]{20}$/.test(options['project-ref']))throw new Error('Exact new project ref required.');
    await writeFile(path.join(directory,'import-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
    if(options.apply)console.log(JSON.stringify(await applyImport(plan,directory,options['project-ref'],{resume:!!options.resume,onProgress:progress=>console.log(JSON.stringify(progress))}),null,2));
    else console.log(JSON.stringify({status:'dry-run',externalWrites:0,projectRef:options['project-ref'],privatePlan:`${options.export}/import-plan.json`,objects:plan.objects.length,counts:plan.counts,scenes:plan.sceneCount,publishedTours:plan.publishedCount,note:'No credentials used and no network calls made. --apply requires an empty new project and private bucket.'},null,2));
  }catch(error){console.error(error instanceof Error?error.message:'Private import failed.');process.exitCode=1;}
}
