import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readMetadata,encodeSqlValue} from '../scripts/imo3d-export-cloud.mjs';
import {IMPORT_TABLES,aiFingerprint,stableAssetId,buildImportPlan,verifyTargetConfiguration,applyImport,createCloudTransport,uploadResumable} from '../scripts/imo3d-import-cloud.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ref='abcdefghijklmnopqrst';
const env={SUPABASE_URL:`https://${ref}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-test-key'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('remaps example images only in cloud copy while preserving IDs, plans and valid AI fingerprints',()=>{
  const bytes=Buffer.from([0,255,7]);const source={id:'tour-1',projectId:'project-1',revision:12,published:false,scenes:[{id:'scene-1',floor:0,image:'/imo3d/example/scene.webp',preview:'/imo3d/example/scene.webp',position:{x:1,y:2,z:3}}],plans:[{floor:0,outline:[{x:0,z:1}]}]};
  const sourceString=JSON.stringify(source),hash=aiFingerprint(source.scenes);
  const encoded=rows=>({rows:rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,encodeSqlValue(v)])))});
  const metadata={tables:{tours:encoded([{id:source.id,project_id:source.projectId,revision:12n,published:0n,payload:sourceString}]),project_brand_assets:encoded([{id:'logo-1',project_id:'project-1',mime:'image/webp',bytes,created_at:'2026-01-01T00:00:00Z'}]),ai_plan_jobs:encoded([{id:'job-1',tour_id:'tour-1',status:'draft',input_hash:hash,created_at:'2026-01-01T00:00:00Z',result:JSON.stringify({floors:[{floor:0,imagePath:path.join(root,'.imo3d-data','ai-plans','plan.png'),sceneIds:['scene-1'],navigation:{points:[{sceneId:'scene-1',x:.2,y:.4}]}}]})}])}};
  const files={dataDirectory:'.imo3d-data',inventory:[{file:'public/imo3d/example/scene.webp',sha256:sha(bytes),bytes:3},{file:'.imo3d-data/ai-plans/plan.png',sha256:sha(Buffer.from('plan')),bytes:4}]};
  const manifest={outputDirectory:'work/cloud-export/test-export-123',sourceFingerprint:'source-hash',totals:{tableCounts:{tours:1}}};
  const plan=buildImportPlan({metadata,files,manifest,root}),tour=plan.tables.tours[0].payload;
  assert.equal(metadata.tables.tours.rows[0].payload,sourceString);
  assert.equal(tour.id,source.id);assert.equal(tour.revision,12);assert.equal(tour.published,false);assert.deepEqual(tour.scenes[0].position,source.scenes[0].position);assert.deepEqual(tour.plans,source.plans);
  assert.equal(plan.tables.assets.length,1);assert.equal(tour.scenes[0].image,tour.scenes[0].preview);assert.match(tour.scenes[0].image,/^\/api\/imo3d\/assets\/[\da-f-]{36}$/);
  assert.equal(plan.tables.ai_plan_jobs[0].input_hash,aiFingerprint(tour.scenes));assert.notEqual(plan.tables.ai_plan_jobs[0].input_hash,hash);
  assert.equal(plan.tables.approved_plan_refs[0].scene_ids[0],'scene-1');assert.equal(plan.tables.project_brand_assets[0].byte_size,3);assert.equal(plan.objects.length,3);
  assert.equal(stableAssetId('tour-1','same'),stableAssetId('tour-1','same'));assert.notEqual(stableAssetId('tour-1','same'),stableAssetId('tour-2','same'));
});

test('ref mismatch rejects credentials before transport can run',()=>{
  assert.throws(()=>verifyTargetConfiguration(ref,{...env,SUPABASE_URL:'https://anotherprojectabcdef.supabase.co'}),/does not match/);
  assert.throws(()=>verifyTargetConfiguration(ref,{...env,SUPABASE_URL:`https://${ref}.supabase.co@attacker.invalid`}),/does not match/);
  assert.throws(()=>verifyTargetConfiguration('bad',env),/exact new/);
  assert.equal(verifyTargetConfiguration(ref,env).projectRef,ref);
});

async function fixture(){
  const parent=path.join(root,'work','cloud-import-tests');await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'fixture-'));
  await mkdir(path.join(directory,'.imo3d-data'));const db=new DatabaseSync(path.join(directory,'.imo3d-data','imo3d.sqlite'));db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','Private project');");const fingerprint=readMetadata(db).fingerprint;db.close();
  const bytes=Buffer.from('private media payload');const tables=Object.fromEntries(IMPORT_TABLES.map(name=>[name,[]]));tables.projects=[{id:'p1',name:'Private project'}];
  const plan={exportId:'test-export-123',sourceFingerprint:fingerprint,sourceRoot:directory,sourceDataDirectory:'.imo3d-data',tables,counts:Object.fromEntries(IMPORT_TABLES.map(name=>[name,tables[name].length])),objects:[{key:'imports/test-export-123/media.webp',mime:'image/webp',bytes:bytes.length,sha256:sha(bytes),embeddedBase64:bytes.toString('base64')}],sceneCount:0,publishedCount:0};
  const cloud=Object.fromEntries([...IMPORT_TABLES,'upload_sessions','brand_upload_sessions'].map(name=>[name,[]]));const media=new Map(),calls=[];
  let loseResponse=false;
  const request=async(endpoint,init={})=>{
    const method=init.method??'GET';calls.push({endpoint,method,upsert:new Headers(init.headers).get('x-upsert')});
    if(endpoint.startsWith('/rest/v1/imo3d_')){const url=new URL(endpoint,'https://test.invalid'),table=url.pathname.replace('/rest/v1/imo3d_',''),limit=Number(url.searchParams.get('limit')??500),offset=Number(url.searchParams.get('offset')??0);return Response.json(cloud[table].slice(offset,offset+limit));}
    if(endpoint==='/storage/v1/bucket/imo3d-private')return Response.json({id:'imo3d-private',public:false});
    if(endpoint==='/storage/v1/object/list/imo3d-private'){const {prefix}=JSON.parse(init.body);const entries=new Map();for(const key of media.keys()){if(prefix&&!key.startsWith(prefix+'/'))continue;const remainder=prefix?key.slice(prefix.length+1):key;const name=remainder.split('/')[0];entries.set(name,{name,id:remainder.includes('/')?null:'object-id'});}return Response.json([...entries.values()]);}
    if(endpoint.startsWith('/storage/v1/object/authenticated/imo3d-private/'))return new Response(media.get(decodeURIComponent(endpoint.slice('/storage/v1/object/authenticated/imo3d-private/'.length))));
    if(endpoint.startsWith('/storage/v1/object/imo3d-private/')){const key=decodeURIComponent(endpoint.slice('/storage/v1/object/imo3d-private/'.length));assert.equal(method,'POST');assert.equal(new Headers(init.headers).get('x-upsert'),'false');assert.equal(media.has(key),false);media.set(key,Buffer.from(init.body));return Response.json({});}
    if(endpoint==='/rest/v1/rpc/imo3d_import_metadata'){const {p_tables}=JSON.parse(init.body);for(const table of IMPORT_TABLES)cloud[table]=structuredClone(p_tables[table]);if(loseResponse){loseResponse=false;throw new Error('Synthetic lost response after commit');}return Response.json(plan.counts);}
    throw new Error('Unexpected mock request');
  };
  return {directory,plan,request,cloud,media,calls,loseNextCommitResponse:()=>{loseResponse=true;}};
}

test('insert-only import checks empty target, hashes remote media and verifies exact metadata',async()=>{
  const f=await fixture(),progress=[];const result=await applyImport(f.plan,f.directory,ref,{env,request:f.request,onProgress:p=>progress.push(p)});
  assert.equal(result.status,'verified-cloud-import');assert.equal(result.publishedTours,0);assert.equal(f.media.size,1);assert.equal(f.cloud.projects[0].id,'p1');
  assert.ok(f.calls.every(call=>!['PATCH','DELETE'].includes(call.method)));assert.equal(progress.at(-1).verifiedObjects,1);
  const journal=JSON.parse(await readFile(path.join(f.directory,'import-journal.json'),'utf8'));assert.equal(journal.verified,true);
  assert.ok(!JSON.stringify(journal).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test('preexisting old row aborts before any media or metadata writes',async()=>{
  const f=await fixture();f.cloud.projects.push({id:'older-unrelated-project',name:'Retain me'});
  await assert.rejects(applyImport(f.plan,f.directory,ref,{env,request:f.request}),/Target is not empty/);
  assert.equal(f.media.size,0);assert.equal(f.cloud.projects[0].id,'older-unrelated-project');assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('explicit matching resume recovers a committed RPC with lost response without reinserting or overwriting',async()=>{
  const f=await fixture();f.loseNextCommitResponse();
  await assert.rejects(applyImport(f.plan,f.directory,ref,{env,request:f.request}),/lost response/);
  assert.equal(f.cloud.projects.length,1);
  const before=f.calls.filter(call=>call.endpoint==='/rest/v1/rpc/imo3d_import_metadata').length;
  const result=await applyImport(f.plan,f.directory,ref,{resume:true,env,request:f.request});
  assert.equal(result.status,'verified-cloud-import');assert.equal(f.calls.filter(call=>call.endpoint==='/rest/v1/rpc/imo3d_import_metadata').length,before);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.endpoint.startsWith('/storage/v1/object/imo3d-private/')).length,1);
});

test('read retry is bounded and storage uses dedicated host; POST writes are never blindly retried',async()=>{
  let calls=0;const urls=[];const request=createCloudTransport(verifyTargetConfiguration(ref,env),{pause:async()=>{},fetcher:async url=>{urls.push(url);calls++;return calls<3?new Response('private diagnostic',{status:520}):Response.json({public:false});}});
  assert.equal((await request('/storage/v1/bucket/imo3d-private')).status,200);assert.equal(calls,3);assert.ok(urls.every(url=>url.startsWith(`https://${ref}.storage.supabase.co/`)));
  let writes=0;const writeRequest=createCloudTransport(verifyTargetConfiguration(ref,env),{pause:async()=>{},fetcher:async()=>{writes++;return new Response('secret server response',{status:520});}});
  await assert.rejects(writeRequest('/storage/v1/object/imo3d-private/private-apartment-name.png',{method:'POST',body:'bytes'}),error=>error.message.includes('POST /storage/v1/object/{bucket}/{object}')&&error.message.includes('520')&&!error.message.includes('private-apartment')&&!error.message.includes('secret'));
  assert.equal(writes,1);
});

test('TUS lost PATCH response is resolved with HEAD without duplicate bytes',async()=>{
  const config=verifyTargetConfiguration(ref,env),bytes=Buffer.from('one chunk');let patches=0,heads=0;
  const request=async(_endpoint,init)=>{
    if(init.method==='POST')return new Response(null,{status:201,headers:{location:`https://${ref}.storage.supabase.co/storage/v1/upload/resumable/private-upload-id`}});
    if(init.method==='PATCH'){patches++;throw new Error('Ambiguous connection lost after server committed');}
    if(init.method==='HEAD'){heads++;return new Response(null,{headers:{'Upload-Offset':String(bytes.length)}});}
    throw Error('Unexpected');
  };
  await uploadResumable(config,request,{key:'safe/path',mime:'image/webp',bytes:bytes.length,embeddedBase64:bytes.toString('base64')},root);
  assert.equal(patches,1);assert.equal(heads,1);
});

test('TUS retries only after HEAD confirms unchanged offset and rejects ambiguous partial offsets',async()=>{
  const config=verifyTargetConfiguration(ref,env),bytes=Buffer.from('one chunk');let patches=0,heads=0;
  const request=async(_endpoint,init)=>{
    if(init.method==='POST')return new Response(null,{status:201,headers:{location:`https://${ref}.storage.supabase.co/storage/v1/upload/resumable/id`}});
    if(init.method==='PATCH'){patches++;if(patches===1)throw Error('Interrupted');return new Response(null,{headers:{'Upload-Offset':String(bytes.length)}});}
    if(init.method==='HEAD'){heads++;return new Response(null,{headers:{'Upload-Offset':'0'}});}
  };
  const item={key:'safe/path',mime:'image/webp',bytes:bytes.length,embeddedBase64:bytes.toString('base64')};await uploadResumable(config,request,item,root);assert.equal(patches,2);assert.equal(heads,1);
  let unsafePatches=0;const partial=async(_endpoint,init)=>{if(init.method==='POST')return new Response(null,{status:201,headers:{location:`https://${ref}.storage.supabase.co/storage/v1/upload/resumable/id`}});if(init.method==='PATCH'){unsafePatches++;throw Error('Interrupted');}return new Response(null,{headers:{'Upload-Offset':'3'}});};
  await assert.rejects(uploadResumable(config,partial,item,root),/unexpected offset/);assert.equal(unsafePatches,1);
});
