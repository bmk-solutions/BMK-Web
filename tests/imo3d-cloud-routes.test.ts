import {parseProcessingJob} from '../src/lib/imo3d/processing-model';
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {cloudRoute} from '../src/lib/imo3d/cloud/handlers';
import {cloudIsAdmin,cloudSameOrigin} from '../src/lib/imo3d/cloud/auth';
import {applyMetadata} from '../src/lib/imo3d/cloud/geometry';
import {tourMetadataSchema} from '../src/lib/imo3d/floor-assignment';
import {publicProcessingJob} from '../src/lib/imo3d/cloud/jobs';
import {aiPlanFingerprint} from '../src/lib/imo3d/ai-plan-jobs';
import {imageFingerprint} from '../src/lib/imo3d/processing-jobs';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import {hashAdminPassword,verifyAdminPassword} from '../src/lib/imo3d/admin-password';
import {PanoramaBlobCache} from '../src/components/imo3d/PanoramaBlobCache';
import {cloudSignedDownloads} from '../src/lib/imo3d/cloud/client';
import {chatgptOAuth,chatgptResource,signedValue,authorization,digest,chatgptConnection} from '../src/lib/imo3d/cloud/chatgpt-auth';
import {chatgptMCP,callChatGPTTool,chatgptDrafts} from '../src/lib/imo3d/cloud/chatgpt-mcp';
import {translatePlanIds,planFailureMessage,subscriptionChildEnvironment,validateSubscriptionAnalysis,validateImageReview,mergeSubscriptionReview,ping} from '../src/lib/imo3d/subscription-plan-worker';
import {onlinePlanProvider} from '../src/lib/imo3d/worker-presence';
import {planCheckpointDirectory,readPlanCheckpoint,savePlanCheckpoint,preparePlanPhotos,selectPlanRepairPhotos,analyzePlanPhotoBatches} from '../src/lib/imo3d/plan-checkpoints';
import {buildPlanSpatialEvidence,savePlanSpatialEvidence,readPlanSpatialEvidence} from '../src/lib/imo3d/plan-spatial-evidence';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {planEvidenceBoard} from '../src/lib/imo3d/openai-floorplan-pipeline';
import {labeledPlanSVG} from '../src/lib/imo3d/plan-labels';
import {tourShareMetadata} from '../src/lib/imo3d/cloud/share-metadata';
const origin='https://imo3d.example',secret='synthetic-test-secret-is-at-least-32-characters',fetchOriginal=globalThis.fetch,envOriginal={...process.env};
test('cloud measurement scale is capture-scoped, revision safe and does not promote inferred geometry',()=>{
 const tour=syntheticTour(),before=JSON.stringify(tour);
 const next=applyMetadata(tour,tourMetadataSchema.parse({revision:tour.revision,measurementHeightMeters:1.87,measurementScale:{sceneIds:['foreign']}}));
 assert.deepEqual(next.measurementScale,{heightMeters:1.87,source:'operator_measured',sceneIds:tour.scenes.map(scene=>scene.id)});
 assert.deepEqual(next.scenes,tour.scenes);assert.deepEqual(next.plans,tour.plans);assert.equal(next.spatialScale,tour.spatialScale);
 assert.equal(JSON.stringify(tour),before);
 assert.throws(()=>applyMetadata(tour,{revision:tour.revision+1,measurementHeightMeters:2}),/تغيّرت/);
 assert.deepEqual(applyMetadata(next,{revision:next.revision,title:'Renamed'}).measurementScale,next.measurementScale);
 assert.equal(applyMetadata(next,{revision:next.revision,measurementHeightMeters:null}).measurementScale,undefined);
});
const adminCookie=()=>{const expiry=String(Date.now()+60_000);return `imo3d_session=${expiry}.${createHmac('sha256',secret).update(expiry).digest('hex')}`;};
const req=(url:string,options:RequestInit={},admin=false)=>new Request(origin+'/api/imo3d/'+url,{...options,headers:{...(admin?{cookie:adminCookie()}:{}),...(options.method&&options.method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),...Object.fromEntries(new Headers(options.headers))}});
const result=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
type Call={url:URL;method:string;body:Record<string,unknown>|null};let storedCredential:Record<string,unknown>|null=null;let calls:Call[]=[];let mock:(call:Call)=>Response|Promise<Response>;
beforeEach(()=>{Object.assign(process.env,{IMO3D_CLOUD:'1',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key',IMO3D_ADMIN_SECRET:secret,IMO3D_PASSWORD_LOGIN:'1',IMO3D_PUBLIC_ORIGIN:origin,IMO3D_DATA_DIR:path.resolve('work/cloud-test-must-not-create-database')});storedCredential=null;calls=[];mock=call=>{throw Error('Unexpected cloud request '+call.url.pathname);};globalThis.fetch=async(input,init)=>{const call={url:new URL(String(input)),method:init?.method??'GET',body:typeof init?.body==='string'?JSON.parse(init.body):null};if(call.url.pathname.endsWith("/imo3d_admin_credentials")&&call.method==="GET")return result(storedCredential?[storedCredential]:[]);calls.push(call);return mock(call);};});
afterEach(()=>{globalThis.fetch=fetchOriginal;for(const key of Object.keys(process.env))if(!(key in envOriginal))delete process.env[key];Object.assign(process.env,envOriginal);});

test('focused plan repair covers every known room and floor without repeating all 100 photographs',()=>{
 const photos=Array.from({length:100},(_,i)=>({sceneId:'s'+i,floor:i<50?0:1}));
 const floors=[0,1].map(floor=>({floor,layout:{rooms:Array.from({length:10},(_,i)=>({evidenceSceneIds:photos.slice(floor*50+i*5,floor*50+i*5+5).map(p=>p.sceneId)}))}}));
 const selected=selectPlanRepairPhotos(photos,floors);assert.ok(selected.length<=48);assert.equal(new Set(selected.map(p=>p.sceneId)).size,selected.length);
 for(const f of floors)for(const r of f.layout.rooms)assert.ok(selected.some(p=>r.evidenceSceneIds.includes(p.sceneId)));
 assert.deepEqual(selected,photos.filter(p=>selected.includes(p)));
 assert.deepEqual(selectPlanRepairPhotos(photos.slice(0,10),floors),photos.slice(0,10));
});

test('photo batches retain checked progress after a failure, resume only missing photos, and preserve order',async()=>{
 const base=path.resolve('work/plan-batch-tests');await mkdir(base,{recursive:true});const cache=await mkdtemp(path.join(base,'run-'));
 const photos=Array.from({length:30},(_,i)=>({sceneId:'s'+i,floor:0}));let fail=true,active=0,maxActive=0;const calls:number[]=[];
 const options={photos,cache,signal:new AbortController().signal,validate:(v:unknown)=>v as {sceneId:string}[],analyze:async(batch:typeof photos,index:number)=>{
  calls.push(index);active++;maxActive=Math.max(maxActive,active);try{await new Promise(resolve=>setTimeout(resolve,index===1?15:2));if(index===1&&fail)throw Error('TEMPORARY');return [...batch].reverse().map(p=>({sceneId:p.sceneId}));}finally{active--;}
 }};
 await assert.rejects(analyzePlanPhotoBatches(options),/TEMPORARY/);assert.ok(maxActive<=2);assert.equal(active,0);
 const completedBefore=calls.filter(n=>n!==1);calls.length=0;fail=false;
 const progress:number[]=[];const result=await analyzePlanPhotoBatches({...options,progress:async(done)=>{progress.push(done);}});
 assert.deepEqual(result.map(p=>p.sceneId),photos.map(p=>p.sceneId));assert.deepEqual(calls,[0,1,2].filter(i=>!completedBefore.includes(i)));assert.ok(completedBefore.length>=1);
 assert.equal(progress.at(-1),30);assert.deepEqual([...progress].sort((a,b)=>a-b),progress);
});

test('photo batches reject partial evidence and respect cancellation before work begins',async()=>{
 const base=path.resolve('work/plan-batch-tests');await mkdir(base,{recursive:true});const cache=await mkdtemp(path.join(base,'invalid-'));
 const photos=[{sceneId:'a',floor:0},{sceneId:'b',floor:0}];let called=0;
 const options={photos,cache,signal:new AbortController().signal,validate:(v:unknown)=>v as {sceneId:string}[],analyze:async()=>{called++;return [{sceneId:'a'}];}};
 await assert.rejects(analyzePlanPhotoBatches(options),/PHOTO_COVERAGE/);
 const controller=new AbortController();controller.abort();await assert.rejects(analyzePlanPhotoBatches({...options,signal:controller.signal}));assert.equal(called,1);
});

test('repair photo selection samples the whole capture when grouping is missing',()=>{
 const photos=Array.from({length:100},(_,i)=>({sceneId:'s'+i,floor:i<50?0:1}));
 const selected=selectPlanRepairPhotos(photos,[]);assert.ok(selected.length>=45&&selected.length<=48);assert.ok(selected.some(p=>p.sceneId==='s0'));assert.ok(selected.some(p=>p.floor===1));assert.ok(selected.some(p=>Number(p.sceneId.slice(1))>95));
});

test('plan geometry keeps separate coordinate frames and rejects foreign or duplicated members',()=>{
 const tour=syntheticTour();
 const raw={version:1,scale:'relative',privatePath:'C:/private',scenes:tour.scenes.map((s,i)=>({id:s.id,floor:s.floor,component:'c'+i,position:s.position,yaw:s.yaw})),components:tour.scenes.map((s,i)=>({id:'c'+i,sceneIds:[s.id],layout:'topology_only',scaleBasis:'unscaled'}))};
 const before=JSON.stringify(raw),packet=buildPlanSpatialEvidence(tour,raw);
 assert.equal(packet.geometry.components.length,tour.scenes.length);assert.equal(JSON.stringify(raw),before);assert.equal('privatePath' in packet.geometry,false);
 assert.throws(()=>buildPlanSpatialEvidence(tour,{...raw,scenes:[...raw.scenes.slice(1),{...raw.scenes[0],id:'foreign'}]}),/PHOTO_MISMATCH/);
 assert.throws(()=>buildPlanSpatialEvidence(tour,{...raw,components:raw.components.map((c,i)=>i?c:{...c,sceneIds:[raw.scenes[1].id]})}),/FRAME_MISMATCH/);
});

test('geometry checkpoints cannot survive changed photographs, camera frames or project ownership',async()=>{
 const tour=syntheticTour(),base=path.resolve('work/plan-spatial-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'run-'));
 const raw={version:1,scale:'relative',scenes:tour.scenes.map((s,i)=>({id:s.id,floor:s.floor,component:'c'+i,position:s.position,yaw:s.yaw})),components:tour.scenes.map((s,i)=>({id:'c'+i,sceneIds:[s.id],layout:'topology_only',scaleBasis:'unscaled'}))};
 await savePlanSpatialEvidence(root,tour,raw);assert.ok(await readPlanSpatialEvidence(root,tour));
 assert.equal(await readPlanSpatialEvidence(root,{...tour,projectId:'other-project'}),null);
 assert.equal(await readPlanSpatialEvidence(root,{...tour,scenes:tour.scenes.map((s,i)=>i?s:{...s,yaw:s.yaw+1})}),null);
 assert.equal(await readPlanSpatialEvidence(root,{...tour,scenes:tour.scenes.map((s,i)=>i?s:{...s,image:'/api/imo3d/assets/new'})}),null);
 assert.ok(await readPlanSpatialEvidence(root,{...tour,title:'Renamed',revision:tour.revision+1}));
});

test('tour listing requests lightweight database summaries and still strips private render data',async()=>{
 const tour=syntheticTour();
 mock=call=>{assert.equal(call.url.pathname,'/rest/v1/rpc/imo3d_list_tour_summaries');assert.deepEqual(call.body,{p_project_id:null});return result([{...tour,photoEdits:[{private:true}],scenes:tour.scenes.map(s=>({...s,depth:{values:[1]},displayDepth:{values:[2]}}))}]);};
 const response=await cloudRoute(req('tours',{},true));assert.equal(response.status,200);
 const values=await response.json();assert.equal(values.length,1);assert.equal(values[0].id,tour.id);assert.equal(values[0].photoEdits,undefined);
 assert.ok(values[0].scenes.every((s:Record<string,unknown>)=>!('depth' in s)&&!('displayDepth' in s)));
 assert.equal(calls.length,1);
});

test('summary listing scopes integration at the database and rejects foreign rows defensively',async()=>{
 const tour=syntheticTour(),token='imo3d_'+'a'.repeat(43);
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_integration_keys'))return result([{id:'key',project_id:tour.projectId,scopes:['read'],last_used_at:new Date().toISOString()}]);
  assert.equal(call.url.pathname,'/rest/v1/rpc/imo3d_list_tour_summaries');assert.deepEqual(call.body,{p_project_id:tour.projectId});
  return result([tour,{...tour,id:'foreign-tour',projectId:'foreign-project'}]);
 };
 const response=await cloudRoute(req('tours',{headers:{Authorization:'Bearer '+token}}));assert.equal(response.status,200);
 assert.deepEqual((await response.json()).map((t:{id:string})=>t.id),[tour.id]);
});

test('anonymous listing cannot invoke even the lightweight summary RPC',async()=>{
 assert.equal((await cloudRoute(req('tours'))).status,401);assert.equal(calls.length,0);
});

test('subscription queue requires admin and an online worker, and binds each job to its tour photographs',async()=>{
 const tour=syntheticTour();let online=false;
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_plan_workers'))return result(online?[{id:'subscription',seen_at:new Date().toISOString()},{id:'subscription:codex',seen_at:new Date().toISOString()},{id:'photos',seen_at:new Date(0).toISOString()}]:[]);
  if(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_enqueue_subscription_plan')){assert.equal(call.body?.p_tour_id,tour.id);assert.equal(call.body?.p_hash,aiPlanFingerprint(tour.scenes));assert.equal((call.body?.p_scenes as unknown[]).length,tour.scenes.length);return result('job');}
  throw Error('Unexpected request');
 };
 assert.equal((await cloudRoute(req(`tours/${tour.id}/ai-plan`,{method:'POST'}))).status,404);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/ai-plan`,{method:'POST'},true))).status,503);
 assert.ok(!calls.some(c=>c.method==='POST'));
 online=true;const queued=await cloudRoute(req(`tours/${tour.id}/ai-plan`,{method:'POST'},true));assert.equal(queued.status,200);
 const queuedStatus=await queued.json();assert.equal(queuedStatus.provider,'codex');assert.equal(queuedStatus.workerOnline,true);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('subscription subprocess excludes database, API and session credentials',()=>{
 const env=subscriptionChildEnvironment({NODE_ENV:'test',PATH:'bin',USERPROFILE:'profile',SUPABASE_SERVICE_ROLE_KEY:'private',OPENAI_API_KEY:'private',IMO3D_ADMIN_SECRET:'private',CODEX_ACCESS_TOKEN:'private'});
 assert.equal(env.PATH,'bin');assert.equal(env.USERPROFILE,'profile');assert.ok(!JSON.stringify(env).includes('private'));
});
test('subscription subprocess retains Linux identity and isolated Codex directory without server secrets',()=>{
 const env=subscriptionChildEnvironment({NODE_ENV:'test',HOME:'/home/imo3d',CODEX_HOME:'/srv/imo3d/codex',XDG_CONFIG_HOME:'/home/imo3d/.config',LANG:'C.UTF-8',TMPDIR:'/tmp/imo3d',SUPABASE_SERVICE_ROLE_KEY:'private',VERCEL_TOKEN:'private',DATABASE_URL:'private'});
 assert.equal(env.HOME,'/home/imo3d');assert.equal(env.CODEX_HOME,'/srv/imo3d/codex');assert.equal(env.LANG,'C.UTF-8');assert.equal(env.TMPDIR,'/tmp/imo3d');
 assert.ok(!JSON.stringify(env).includes('private'));
});
test('administrator viewer keeps the registered floor while a new subscription draft is processing',async()=>{
 const tour=syntheticTour();mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);assert.equal(call.url.pathname,'/rest/v1/imo3d_approved_plan_refs');return result([{tour_id:tour.id,floor:0,job_id:'old-selected',input_hash:aiPlanFingerprint(tour.scenes),scene_ids:tour.scenes.map(s=>s.id),storage_key:'private/selected.png'}]);};
 const response=await cloudRoute(req(`tours/${tour.id}/ai-plan?viewer=1&floor=0`,{},true));assert.equal(response.status,200);assert.equal((await response.json()).job.id,'old-selected');
});
test('choosing a furnished draft validates source images before uploading and registers a new immutable snapshot',async()=>{
 const tour=syntheticTour(),id='00000000-0000-4000-8000-000000000001',url=origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id+'&approve=1';
 const source={id,project_id:tour.projectId,tour_id:tour.id,floor:0,input_hash:'stale',result:{qualityHold:'',furnished:{reviewStatus:'needs-review'}}};
 const png=await sharp({create:{width:256,height:256,channels:3,background:'white'}}).png().toBuffer();
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_chatgpt_drafts'))return result([source]);
  if(call.url.pathname.endsWith('/imo3d_approved_plan_refs'))return result([{floor:0,job_id:'old'}]);
  if(call.url.pathname.includes('/object/authenticated/'))return new Response(new Uint8Array(png));
  if(call.url.pathname.includes('/storage/')&&call.method==='POST'){assert.match(call.url.pathname,/reviewed-plans/);return result({});}
  assert.equal(call.url.pathname,'/rest/v1/rpc/imo3d_use_furnished_draft');assert.equal(call.body?.p_previous_job,'old');assert.equal(call.body?.p_revision,tour.revision);assert.equal(call.body?.p_draft,id);return result(true);
 };
 const request=()=>new Request(url,{method:'POST',headers:{cookie:adminCookie(),Origin:origin}});
 await assert.rejects(chatgptDrafts(request()),/تغيرت الصور/);assert.ok(!calls.some(c=>c.method==='POST'));
 source.input_hash=aiPlanFingerprint(tour.scenes);assert.equal((await chatgptDrafts(request())).status,200);assert.ok(!calls.some(c=>c.method==='DELETE'||c.method==='PATCH'));
 source.result.qualityHold='Geometry rejected';const writes=calls.filter(c=>c.method==='POST').length;await assert.rejects(chatgptDrafts(request()),/مستبعدة/);assert.equal(calls.filter(c=>c.method==='POST').length,writes);
});
test('approving a registered furnished plan preserves only its own floor points on the new snapshot',async()=>{
 const tour=syntheticTour(),id='00000000-0000-4000-8000-000000000002';
 const navigation={points:tour.scenes.filter(s=>s.floor===0).map(s=>({sceneId:s.id,x:.5,y:.5})),outline:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]};
 const source={id,project_id:tour.projectId,tour_id:tour.id,floor:0,input_hash:aiPlanFingerprint(tour.scenes),result:{navigation,furnished:{reviewStatus:'needs-review'}}};
 const png=await sharp({create:{width:512,height:256,channels:3,background:'white'}}).png().toBuffer();
 let snapshot:string|undefined,patched=false;
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_chatgpt_drafts'))return result([source]);
  if(call.url.pathname.endsWith('/imo3d_approved_plan_refs')){
   if(call.method==='PATCH'){
    assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);
    assert.equal(call.url.searchParams.get('floor'),'eq.0');
    assert.equal(call.url.searchParams.get('job_id'),'eq.'+snapshot);
    assert.deepEqual((call.body?.navigation as typeof navigation).points,navigation.points);
    assert.equal((call.body?.navigation as {width:number}).width,512);patched=true;
   }
   return result([{floor:0,job_id:'old'}]);
  }
  if(call.url.pathname.includes('/object/authenticated/'))return new Response(new Uint8Array(png));
  if(call.url.pathname.includes('/storage/'))return result({});
  assert.equal(call.url.pathname,'/rest/v1/rpc/imo3d_use_furnished_draft');snapshot=String(call.body?.p_job);return result(true);
 };
 const response=await chatgptDrafts(new Request(origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id+'&approve=1',{method:'POST',headers:{cookie:adminCookie(),Origin:origin}}));
 assert.equal(response.status,200);assert.equal(patched,true);
});

test('photo and furnished-label contracts reject omitted sources and wrong room anchors',()=>{
 const scenes=[{id:'s1',floor:0},{id:'s2',floor:0}],audit={verdict:'inconclusive',reviewedSceneIds:['s1','s2'],issues:[],limitations:['Estimate']};
 const floor={floor:0,geometryBasis:'image-supported',geometryExplanation:'Synthetic matching wall directions in s1 and s2.',evidence:scenes.map(s=>({sceneId:s.id,roomCategory:'living',visibleEvidence:['Sofa'],openings:[],distinctiveFeatures:[],uncertainties:[]})),layout:{rooms:[{id:'r',label:'صالة',evidenceSceneIds:['s1','s2'],polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],uncertainty:'Estimate'}],openings:[],uncertainties:['Estimate']},audit};
 assert.equal(validateSubscriptionAnalysis({floors:[floor]},scenes).floors.length,1);
 assert.throws(()=>validateSubscriptionAnalysis({floors:[{...floor,evidence:floor.evidence.slice(0,1)}]},scenes),/COVERAGE/);
 assert.throws(()=>validateSubscriptionAnalysis({floors:[{...floor,geometryBasis:'topology-only'}]},scenes),/GEOMETRY_UNRESOLVED/);
 const {evidence,...geometry}=floor,corrected={...evidence[0],visibleEvidence:['Two sofas; same room seen from another angle']};
 const review={floors:[{...geometry,evidenceCorrections:[corrected]}]};
 const merged=mergeSubscriptionReview({floors:[floor]},review,scenes);
 assert.deepEqual(merged.floors[0].evidence,[corrected,evidence[1]]);
 assert.deepEqual(floor.evidence,evidence,'review must not mutate checkpoint');
 assert.throws(()=>mergeSubscriptionReview({floors:[floor]},{floors:[{...geometry,evidenceCorrections:[corrected,corrected]}]},scenes),/COVERAGE/);
 assert.throws(()=>mergeSubscriptionReview({floors:[floor]},{floors:[{...geometry,evidenceCorrections:[{...corrected,sceneId:'other-tour'}]}]},scenes),/COVERAGE/);
 assert.throws(()=>mergeSubscriptionReview({floors:[floor]},{floors:[{...geometry,evidenceCorrections:[],audit:{...audit,reviewedSceneIds:['s1']}}]},scenes),/COVERAGE/);
 assert.throws(()=>mergeSubscriptionReview({floors:[floor]},{floors:[{...geometry,geometryBasis:'topology-only',evidenceCorrections:[]}]},scenes),/GEOMETRY_UNRESOLVED/);
 const image={imagePath:'generated.png',labels:[{roomId:'r',name:'صالة',x:.5,y:.5}],baseImageHasNoText:true,navigation:null,reviewNotes:'Reviewed photo furniture',audit:{...audit,verdict:'consistent'}};
 assert.equal(validateImageReview(image,['r'],['s1','s2']).labels.length,1);
 assert.throws(()=>validateImageReview(image,['different'],['s1','s2']),/COVERAGE/);
 assert.throws(()=>validateImageReview({...image,baseImageHasNoText:false},['r'],['s1','s2']));
 assert.throws(()=>validateImageReview({...image,audit},['r'],['s1','s2']),/IMAGE_AUDIT_UNRESOLVED/);
 assert.match(planFailureMessage(Error('PLAN_INCOMPLETE:7:17')),/7.*17/);
 assert.match(labeledPlanSVG(Buffer.from('x'),500,500,[{roomId:'r',name:'<script>&',x:.5,y:.5}]),/&lt;script&gt;&amp;/);
});
test('plan retries reuse validated checkpoints only for the exact tour and image fingerprint',async()=>{
 const root=path.resolve('work/plan-checkpoint-tests/'+Date.now()),directory=planCheckpointDirectory(root,'tour-a','photos-v1');
 const validate=(value:unknown)=>{if((value as {covered?:number}).covered!==100)throw Error('incomplete');return value;};
 assert.equal(await readPlanCheckpoint(directory,'analysis',validate),null);
 await savePlanCheckpoint(directory,'analysis',{covered:100});
 assert.deepEqual(await readPlanCheckpoint(directory,'analysis',validate),{covered:100});
 assert.equal(await readPlanCheckpoint(planCheckpointDirectory(root,'tour-b','photos-v1'),'analysis',validate),null);
 assert.equal(await readPlanCheckpoint(planCheckpointDirectory(root,'tour-a','photos-v2'),'analysis',validate),null);
 await savePlanCheckpoint(directory,'analysis',{covered:99});
 assert.equal(await readPlanCheckpoint(directory,'analysis',validate),null);
});
test('100 plan photos prepare with bounded concurrency and stable scene order',async()=>{
 let active=0,peak=0;const scenes=Array.from({length:100},(_,i)=>i);
 const result=await preparePlanPhotos(scenes,async(item,index)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,index%3));active--;return 'scene-'+item;},3);
 assert.equal(peak,3);assert.equal(active,0);assert.deepEqual(result,scenes.map(i=>'scene-'+i));
});
test('photo preparation drains in-flight work on failure without starting the remaining batch',async()=>{
 let active=0,started=0;
 await assert.rejects(preparePlanPhotos(Array.from({length:100},(_,i)=>i),async(item)=>{started++;active++;try{if(item===1)throw Error('download failed');await new Promise(resolve=>setTimeout(resolve,5));return item;}finally{active--;}}),/download failed/);
 assert.equal(active,0);assert.ok(started<=3);
});
test('room name edits save a new draft, preserve the base image and prevent editing stale or legacy raster labels',async()=>{
 const tour=syntheticTour(),id='00000000-0000-4000-8000-000000000001',url=origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id;
 const source={id,project_id:tour.projectId,tour_id:tour.id,floor:0,input_hash:aiPlanFingerprint(tour.scenes),result:{layout:{rooms:[{id:'r',label:'Old',evidenceSceneIds:[tour.scenes[0].id],polygon:null,uncertainty:'Uncertain'}],openings:[],uncertainties:['Uncertain']},furnished:{baseImageHasNoText:true,imageDraftId:id,labels:[{roomId:'r',name:'Old',x:.5,y:.5}]}}};
 const before=JSON.stringify(source);let saved:Record<string,unknown>|null=null;
 mock=call=>{if(call.method==='POST'){assert.equal(call.url.pathname,'/rest/v1/imo3d_chatgpt_drafts');saved=call.body;return result([call.body]);}return result(call.url.pathname.endsWith('/imo3d_tours')?[{payload:tour}]:[source]);};
 const request=()=>new Request(url,{method:'PATCH',headers:{cookie:adminCookie(),Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({names:[{roomId:'r',name:'غرفة النوم الماستر'}]})});
 const response=await chatgptDrafts(request());assert.equal(response.status,201);assert.equal(JSON.stringify(source),before);assert.notEqual(saved!.id,id);assert.equal((saved!.result as typeof source.result).furnished.imageDraftId,id);assert.equal((saved!.result as typeof source.result).layout.rooms[0].label,'غرفة النوم الماستر');
 assert.ok(!calls.some(c=>c.method==='PATCH'||c.url.pathname.includes('/storage/')));
 source.input_hash='stale';await assert.rejects(chatgptDrafts(request()),/تغيرت الصور/);
 source.input_hash=aiPlanFingerprint(tour.scenes);source.result.furnished.baseImageHasNoText=false;await assert.rejects(chatgptDrafts(request()),/صورة قديمة/);
});
test('private PNG export composites edited Arabic names while the base remains byte-identical',async()=>{
 const id='00000000-0000-4000-8000-000000000001',tour=syntheticTour(),png=await sharp({create:{width:400,height:400,channels:3,background:'white'}}).png().toBuffer();
 const row={id,project_id:tour.projectId,tour_id:tour.id,result:{furnished:{imageDraftId:id,baseImageHasNoText:true,labels:[{roomId:'r',name:'الصالة',x:.5,y:.5}]}}};
 mock=call=>call.url.pathname.includes('/storage/')?new Response(new Uint8Array(png)):result([row]);
 const url=origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id;
 const exported=await chatgptDrafts(new Request(url,{headers:{cookie:adminCookie()}})),bytes=Buffer.from(await exported.arrayBuffer());
 assert.equal(exported.headers.get('content-type'),'image/png');assert.notDeepEqual(bytes,png);assert.equal((await sharp(bytes).metadata()).width,400);
 const base=await chatgptDrafts(new Request(url+'&base=1',{headers:{cookie:adminCookie()}}));assert.deepEqual(Buffer.from(await base.arrayBuffer()),png);
});

test('ChatGPT discovery exposes scoped analysis and furnished-guide tools',async()=>{
 const request=(method:string,params={})=>new Request(origin+'/api/imo3d-chatgpt/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const tools=(await(await chatgptMCP(request('tools/list'))).json()).result.tools;
 assert.deepEqual(tools.map((tool:{name:string})=>tool.name),['list_tours','inspect_tour','inspect_scene','inspect_floorplan_draft','save_floorplan_draft']);
 assert.equal(tools[3].annotations.readOnlyHint,true);assert.equal(tools[4].annotations.destructiveHint,false);assert.equal(tools[4].annotations.readOnlyHint,false);
 const denied=await chatgptMCP(request('tools/call',{name:'inspect_scene',arguments:{tourId:'private',sceneId:'private'}}));
 assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate')!,/oauth-protected-resource/);assert.equal(calls.length,0);
});

test('furnished guide refuses a different project before reading its draft',async()=>{
 mock=()=>result([{payload:syntheticTour()}]);
 await assert.rejects(callChatGPTTool({id:'connection',project_id:'other-project',client_id:'client',expires_at:'',refresh_expires_at:''},'inspect_floorplan_draft',{tourId:'synthetic-tour',draftId:'00000000-0000-4000-8000-000000000001'}),/outside/);
 assert.equal(calls.length,1);
});

test('furnished upload needs admin, same origin, and current source images before any write',async()=>{
 const tour=syntheticTour(),id='00000000-0000-4000-8000-000000000001',url=origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id;
 await assert.rejects(chatgptDrafts(new Request(url)),/دخول الإدارة/);
 await assert.rejects(chatgptDrafts(new Request(url,{method:'POST',headers:{cookie:adminCookie(),Origin:'https://outside.example'}})),/مصدر/);
 mock=call=>result(call.url.pathname.endsWith('/imo3d_tours')?[{payload:tour}]:[{id,project_id:tour.projectId,input_hash:'old'}]);
 await assert.rejects(chatgptDrafts(new Request(url,{method:'POST',headers:{cookie:adminCookie(),Origin:origin}})),/تغيرت الصور/);
 assert.equal(calls.some(call=>call.method!=='GET'),false);
});

test('furnished image is inserted as a separate private draft and original remains unchanged',async()=>{
 const tour=syntheticTour(),id='00000000-0000-4000-8000-000000000001',url=origin+'/api/imo3d-chatgpt/drafts?tourId='+tour.id+'&id='+id;
 const source={id,project_id:tour.projectId,tour_id:tour.id,floor:0,input_hash:aiPlanFingerprint(tour.scenes),result:{source:'chatgpt-mcp',layout:{rooms:[]},audit:{verdict:'inconclusive'}}},before=JSON.stringify(source);
 const png=await sharp({create:{width:256,height:256,channels:3,background:'white'}}).png().toBuffer();
 mock=call=>{
  if(call.method==='GET')return result(call.url.pathname.endsWith('/imo3d_tours')?[{payload:tour}]:[source]);
  assert.equal(call.method,'POST');
  if(call.url.pathname.startsWith('/storage/')){assert.match(call.url.pathname,new RegExp('/chatgpt-drafts/'+tour.projectId+'/'+tour.id+'/'));return result({});}
  assert.equal(call.url.pathname,'/rest/v1/imo3d_chatgpt_drafts');assert.notEqual(call.body!.id,id);assert.equal(call.body!.tour_id,tour.id);assert.equal((call.body!.result as {furnished:{parentDraftId:string}}).furnished.parentDraftId,id);return result([call.body]);
 };
 const body=new FormData();body.set('image',new File([new Uint8Array(png)],'draft.png',{type:'image/png'}));body.set('reviewNotes','Synthetic reviewed furniture inventory');
 const response=await chatgptDrafts(new Request(url,{method:'POST',headers:{cookie:adminCookie(),Origin:origin},body}));
 assert.equal(response.status,201);assert.equal(JSON.stringify(source),before);assert.equal(calls.filter(call=>call.method==='POST').length,2);
 mock=call=>call.url.pathname.startsWith('/storage/')?new Response(new Uint8Array(png)):result([{...source,result:{...source.result,furnished:{reviewStatus:'needs-review'}}}]);
 const image=await chatgptDrafts(new Request(url,{headers:{cookie:adminCookie()}}));assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('cache-control')!,/private, no-store/);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
});

test('ChatGPT authorization binds project consent to the exact ChatGPT callback, resource and PKCE',async()=>{
 process.env.IMO3D_SESSION_SECRET=secret;
 const redirect='https://chatgpt.com/connector/oauth/test-callback';
 const clientId=signedValue({kind:'client',redirect_uris:[redirect],expires:Date.now()+60000});
 const args={client_id:clientId,redirect_uri:redirect,response_type:'code',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'test-state',scope:'imo3d:analyze',resource:chatgptResource()};
 assert.equal(authorization(args).redirect_uri,redirect);
 assert.throws(()=>authorization({...args,redirect_uri:'https://outside.example/callback'}));
 assert.throws(()=>authorization({...args,resource:'https://outside.example/mcp'}));
 assert.throws(()=>authorization({...args,code_challenge_method:'plain'}));
 assert.throws(()=>authorization({...args,redirect_uri:'https://chatgpt.com/connector/oauth/different'}));
});

test('ChatGPT code redemption checks PKCE atomically and prevents replay',async()=>{
 process.env.IMO3D_SESSION_SECRET=secret;
 const redirect='https://chatgpt.com/connector/oauth/test-callback',clientId=signedValue({kind:'client',redirect_uris:[redirect],expires:Date.now()+60000}),verifier='v'.repeat(43),code='c'.repeat(43);
 let consumed=false;
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_chatgpt_codes')){assert.equal(call.method,'DELETE');assert.equal(call.url.searchParams.get('code_hash'),'eq.'+digest(code));const valid=call.url.searchParams.get('challenge')==='eq.'+createHash('sha256').update(verifier).digest('base64url');if(!valid||consumed)return result([]);consumed=true;return result([{project_id:'only-project'}]);}assert.equal(call.url.pathname,'/rest/v1/imo3d_chatgpt_connections');assert.equal(call.body!.project_id,'only-project');assert.equal(JSON.stringify(call.body).includes('imoc_'),false);return result([call.body]);};
 const request=(v:string)=>new Request(origin+'/api/imo3d-chatgpt/token',{method:'POST',body:new URLSearchParams({client_id:clientId,grant_type:'authorization_code',redirect_uri:redirect,resource:chatgptResource(),code,code_verifier:v})});
 assert.equal((await chatgptOAuth(request('x'.repeat(43)),'token')).status,400);assert.equal(consumed,false);
 const issued=await chatgptOAuth(request(verifier),'token');assert.equal(issued.status,200);assert.match((await issued.json()).access_token,/^imoc_/);
 assert.equal((await chatgptOAuth(request(verifier),'token')).status,400);
});

test('ChatGPT token checks expiration and revocation; tools refuse another project',async()=>{
 mock=call=>{assert.equal(call.url.searchParams.get('revoked_at'),'is.null');assert.ok(call.url.searchParams.get('expires_at')!.startsWith('gt.'));return result([]);};
 assert.equal(await chatgptConnection(new Request(origin,{headers:{authorization:'Bearer imoc_'+'a'.repeat(43)}})),null);
 mock=()=>result([{payload:syntheticTour()}]);
 await assert.rejects(callChatGPTTool({id:'connection',project_id:'other-project',client_id:'client',expires_at:'',refresh_expires_at:''},'inspect_tour',{tourId:'synthetic-tour'}),/outside/);
});

test('ChatGPT cannot save a draft without all current images and their inspection receipts',async()=>{
 process.env.IMO3D_SESSION_SECRET=secret;
 const tour=syntheticTour(),connection={id:'connection',project_id:tour.projectId,client_id:'client',expires_at:'',refresh_expires_at:''},hash=aiPlanFingerprint(tour.scenes);
 const evidence=tour.scenes.map(scene=>({sceneId:scene.id,roomCategory:'unknown',visibleEvidence:['Synthetic'],openings:[],distinctiveFeatures:[],uncertainties:['Unknown geometry'],receipt:signedValue({kind:'scene',connection:connection.id,tour:tour.id,scene:scene.id,hash,expires:Date.now()+60000})}));
 const layout={rooms:[{id:'unknown',label:'Unresolved',evidenceSceneIds:tour.scenes.map(s=>s.id),polygon:null,uncertainty:'Cannot determine layout'}],openings:[],uncertainties:['Not surveyed']};
 const input={tourId:tour.id,inputHash:hash,floor:0,evidence,layout,audit:{verdict:'inconclusive',reviewedSceneIds:tour.scenes.map(s=>s.id),issues:[],limitations:['Uncertain']}};
 mock=call=>{if(call.method==='GET')return result([{payload:tour}]);assert.equal(call.url.pathname,'/rest/v1/imo3d_chatgpt_drafts');assert.equal(call.body!.input_hash,hash);assert.equal(JSON.stringify(call.body).includes('"receipt":'),false);return result([call.body]);};
 await assert.rejects(callChatGPTTool(connection,'save_floorplan_draft',{...input,evidence:evidence.slice(1)}),/every scene/);
 await assert.rejects(callChatGPTTool(connection,'save_floorplan_draft',{...input,inputHash:'0'.repeat(64)}),/changed/);
 await assert.rejects(callChatGPTTool(connection,'save_floorplan_draft',{...input,evidence:evidence.map((item,index)=>index?item:{...item,receipt:signedValue({kind:'scene',connection:'another',tour:tour.id,scene:item.sceneId,hash,expires:Date.now()+60000})})}),/receipt/);
 assert.equal(calls.some(call=>call.method!=='GET'),false);
 const saved=await callChatGPTTool(connection,'save_floorplan_draft',input);assert.match(saved.content[0].text!,/draft/);
 assert.equal(calls.filter(call=>call.method!=='GET').length,1);
});

test('viewer media signs only current display images in one batch and serves each scene reference under the suite basePath',async()=>{
 const tour={...syntheticTour(),published:true};tour.scenes[0].image='/api/imo3d/assets/display';
 const started=Date.now();
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_project_branding'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_assets')){assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);return result([{id:'display',storage_key:'tour/display.webp',mime:'image/webp'},{id:'unused',storage_key:'tour/unused.webp',mime:'image/webp'},{id:'model',storage_key:'tour/mesh',mime:'application/octet-stream'}]);}
  assert.equal(call.url.pathname,'/storage/v1/object/sign/imo3d-private');
  assert.deepEqual(call.body,{paths:['tour/display.webp'],expiresIn:300});
  return result([{path:'tour/display.webp',signedURL:'/object/sign/imo3d-private/tour/display.webp?token=test'}]);
 };
 const response=await cloudRoute(req(`tours/${tour.id}?media=1`));assert.equal(response.status,200);
 // The row keeps /api/imo3d/assets/display; the response serves it under the basePath, paired with its signed URL.
 const body=await response.json(),served='/media-support/tour/api/imo3d/assets/display';assert.equal(body.scenes[0].image,served);assert.equal(tour.scenes[0].image,'/api/imo3d/assets/display');
 assert.deepEqual(Object.keys(body.media.urls),[served]);
 assert.match(body.media.urls[served],/^https:\/\/synthetic.storage.supabase.co\/storage\/v1\//);
 assert.ok(body.media.expiresAt>=started+269000&&body.media.expiresAt<=Date.now()+270000);
 assert.match(response.headers.get('cache-control')!,/no-store/);
 assert.equal(calls.filter(call=>call.url.pathname.includes('/object/sign/')).length,1);
});

test('media refresh rejects unpublished tours without a session before looking up assets',async()=>{
 const tour={...syntheticTour(),published:false};mock=()=>result([{payload:tour}]);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/media`))).status,404);
 assert.equal(calls.length,1);
});

test('authorized media refresh permits a private tour and omits missing signed objects',async()=>{
 const tour={...syntheticTour(),published:false};tour.scenes[0].image='/api/imo3d/assets/display';
 mock=call=>call.url.pathname.endsWith('/imo3d_tours')?result([{payload:tour}]):call.url.pathname.endsWith('/imo3d_assets')?result([{id:'display',storage_key:'missing.webp',mime:'image/webp'}]):result([{path:'missing.webp',error:'not found',signedURL:null}]);
 const response=await cloudRoute(req(`tours/${tour.id}/media`,{},true));assert.equal(response.status,200);assert.deepEqual((await response.json()).urls,{});
});

test('batch storage signing rejects untrusted origins and ignores unsolicited paths',async()=>{
 mock=()=>result([{path:'ok.webp',signedURL:'https://untrusted.example/image'}]);
 await assert.rejects(cloudSignedDownloads(['ok.webp']),/Unexpected storage URL/);
 mock=()=>result([{path:'other.webp',signedURL:'/object/sign/other'}]);
 assert.equal((await cloudSignedDownloads(['ok.webp'])).size,0);
});

test('compressed panorama cache evicts by byte budget and recency and clears on disposal',()=>{
 const cache=new PanoramaBlobCache(6),blob=()=>new Blob(['abc']);
 cache.set('a',blob());cache.set('b',blob());assert.ok(cache.get('a'));
 cache.set('c',blob());assert.equal(cache.get('b'),undefined);assert.ok(cache.get('a'));
 cache.set('huge',new Blob(['1234567']));assert.equal(cache.get('huge'),undefined);
 cache.set('a',new Blob(['1']));cache.set('d',new Blob(['12']));assert.ok(cache.get('c'));
 cache.clear();assert.equal(cache.get('a'),undefined);assert.equal(cache.get('d'),undefined);
});

test('password changes store only a salted hash, revoke previous cookies and keep the new session',async()=>{
 const password='New synthetic passphrase 2026';
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_rate_limit'))return result(true);
  if(call.url.pathname.endsWith('/imo3d_admin_credentials')&&call.method==='POST'){storedCredential=call.body;return result([storedCredential]);}
  throw Error('Unexpected mutation');
 };
 const oldRequest=req('session',{},true);
 const response=await cloudRoute(req('settings/password',{method:'POST',body:JSON.stringify({currentPassword:secret,newPassword:password,confirmPassword:password})},true));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 assert.equal(JSON.stringify(storedCredential).includes(password),false);
 assert.match(String(storedCredential!.password_hash),/^scrypt:/);
 assert.equal(await verifyAdminPassword(password,String(storedCredential!.password_hash)),true);
 assert.equal(await cloudIsAdmin(oldRequest),false);
 const cookie=response.headers.get('set-cookie')!.split(';')[0];
 assert.equal(await cloudIsAdmin(req('session',{headers:{cookie}})),true);
 assert.match(response.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict.*Secure/);
 const oldLogin=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password:secret})}));assert.equal(oldLogin.status,401);
 const newLogin=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password})}));assert.equal(newLogin.status,200);
});

test('password settings reject anonymous, cross-origin, mismatched, short and incorrect-current requests without credential writes',async()=>{
 mock=call=>call.url.pathname.endsWith('/imo3d_rate_limit')?result(true):(()=>{throw Error('Unexpected write');})();
 const payload={currentPassword:secret,newPassword:'A different long passphrase',confirmPassword:'A different long passphrase'};
 assert.equal((await cloudRoute(req('settings/password',{method:'POST',body:JSON.stringify(payload)}))).status,401);
 assert.equal((await cloudRoute(req('settings/password',{method:'POST',headers:{Origin:'https://outside.example'},body:JSON.stringify(payload)},true))).status,403);
 for(const body of [{...payload,confirmPassword:'wrong'},{...payload,newPassword:'short',confirmPassword:'short'},{...payload,currentPassword:'incorrect'}]){
  assert.equal((await cloudRoute(req('settings/password',{method:'POST',body:JSON.stringify(body)},true))).status,400);
 }
 assert.equal(calls.some(call=>call.url.pathname.endsWith('/imo3d_admin_credentials')),false);
});

test('stored password changes use a version condition and report a concurrent edit',async()=>{
 const password='Existing synthetic passphrase';
 storedCredential={password_hash:await hashAdminPassword(password),version:'971ad4c8-4c16-4a68-9d50-d537c325d425'};
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_rate_limit'))return result(true);if(call.method==='PATCH'){assert.equal(call.url.searchParams.get('version'),'eq.'+storedCredential!.version);return result([]);}throw Error('Unexpected request');};
 const login=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password})}));const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const response=await cloudRoute(req('settings/password',{method:'POST',headers:{cookie},body:JSON.stringify({currentPassword:password,newPassword:'Next synthetic passphrase',confirmPassword:'Next synthetic passphrase'})}));
 assert.equal(response.status,409);assert.equal(response.headers.has('set-cookie'),false);
 assert.equal(await cloudIsAdmin(req('session',{headers:{cookie}})),true);
});

test('password hashes have independent salts and fail closed on malformed encodings',async()=>{
 const a=await hashAdminPassword('A long test passphrase'),b=await hashAdminPassword('A long test passphrase');
 assert.notEqual(a,b);assert.equal(await verifyAdminPassword('wrong',a),false);assert.equal(await verifyAdminPassword('anything','scrypt:broken'),false);
});

test('the session signing key can be independent of the administrator password',async()=>{
 process.env.IMO3D_SESSION_SECRET='independent-server-only-session-signing-key';
 mock=call=>call.url.pathname.endsWith('/imo3d_rate_limit')?result(true):(()=>{throw Error('Unexpected request');})();
 assert.equal(await cloudIsAdmin(req('session',{},true)),false);
 const response=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password:secret})}));
 assert.equal(response.status,200);
 assert.equal(await cloudIsAdmin(req('session',{headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]}})),true);
});
test('cloud sessions require a valid signed cookie even on localhost',async()=>{
 assert.equal(await cloudIsAdmin(new Request('http://127.0.0.1:3000')),false);
 assert.equal(await cloudIsAdmin(req('session',{},true)),true);
 const response=await cloudRoute(req('session'));assert.equal(response.status,200);assert.deepEqual(await response.json(),{admin:false,local:false,cloud:true,uploadMode:'signed'});assert.equal(calls.length,0);
});
test('invalid bearer never falls back to a valid admin session',async()=>{
 const response=await cloudRoute(req('dashboard',{headers:{Authorization:'Bearer invalid'}},true));assert.equal(response.status,401);assert.equal(calls.length,0);
});
test('cross-origin writes are rejected before any database operation',async()=>{
 const request=req('projects',{method:'POST',headers:{Origin:'https://outside.example'},body:JSON.stringify({name:'New project'})},true);
 assert.equal(cloudSameOrigin(request),false);assert.equal((await cloudRoute(request)).status,403);assert.equal(calls.length,0);
});
test('login applies durable rate limiting before verifying credentials',async()=>{
 mock=call=>{assert.equal(call.url.pathname,'/rest/v1/rpc/imo3d_rate_limit');return result(false);};
 const response=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password:secret})}));assert.equal(response.status,401);assert.equal(response.headers.has('set-cookie'),false);assert.equal(calls[0].body?.p_key,'login');
});
test('unpublished tours and their images remain inaccessible publicly',async()=>{
 const tour=syntheticTour();mock=call=>call.url.pathname.endsWith('/imo3d_assets')?result([{id:'asset',tour_id:tour.id,mime:'image/webp',storage_key:'assets/a.webp'}]):result([{payload:tour}]);
 assert.equal((await cloudRoute(req('tours/'+tour.id))).status,404);
 assert.equal((await cloudRoute(req('assets/asset'))).status,404);assert.equal(calls.some(call=>call.url.pathname.includes('/sign/')),false);
});
test('published assets authorize first then redirect to short-lived storage URL',async()=>{
 const tour={...syntheticTour(),published:true};mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_assets'))return result([{id:'asset',tour_id:tour.id,mime:'image/webp',storage_key:'assets/a.webp'}]);
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.includes('/object/sign/')){assert.equal(call.body?.expiresIn,300);return result({signedURL:'/object/sign/imo3d-private/assets/a.webp?token=synthetic'});}throw Error('unexpected');
 };
 const response=await cloudRoute(req('assets/asset'));assert.equal(response.status,307);assert.match(response.headers.get('location')!,/^https:\/\/synthetic\.storage\.supabase\.co\/storage\/v1\/object\/sign\//);assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('integration cannot read another project even when it is published',async()=>{
 const token='imo3d_'+'a'.repeat(43),tour={...syntheticTour(),published:true};mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_integration_keys')){assert.equal(call.url.searchParams.get('secret_hash'),'eq.'+createHash('sha256').update(token).digest('hex'));return result([{id:'key',project_id:'other-project',scopes:['read'],last_used_at:new Date().toISOString()}]);}
  return result([{payload:tour}]);
 };
 assert.equal((await cloudRoute(req('tours/'+tour.id,{headers:{Authorization:'Bearer '+token}},true))).status,404);
});
test('stale scene removal fails before CAS or storage modification',async()=>{
 const tour=syntheticTour();mock=()=>result([{payload:tour}]);const response=await cloudRoute(req(`tours/${tour.id}/scenes/${tour.scenes[0].id}`,{method:'DELETE',body:JSON.stringify({revision:88})},true));assert.equal(response.status,409);assert.equal(calls.length,1);
});
test('scene removal uses one CAS RPC and removes reciprocal navigation references',async()=>{
 const tour=syntheticTour();mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_delete_scene')){const next=call.body!.p_tour as ReturnType<typeof syntheticTour>;assert.equal(call.body?.p_expected_revision,tour.revision);assert.equal(next.scenes.length,tour.scenes.length-1);assert.ok(next.scenes.every(scene=>!scene.links.includes(tour.scenes[0].id)));return result({...next,revision:1});}
  if(call.url.pathname.endsWith('/imo3d_project_branding'))return result([]);throw Error('unexpected');
 };
 const response=await cloudRoute(req(`tours/${tour.id}/scenes/${tour.scenes[0].id}`,{method:'DELETE',body:JSON.stringify({revision:tour.revision})},true));assert.equal(response.status,200);assert.equal(calls.filter(call=>call.method!=='GET').length,1);assert.ok(!existsSync(path.join(process.env.IMO3D_DATA_DIR!,'imo3d.sqlite')));
});
test('manual connections reject different floors without issuing a write',async()=>{
 const tour=syntheticTour();tour.scenes[1].floor=1;mock=()=>result([{payload:tour}]);const response=await cloudRoute(req(`tours/${tour.id}/connections`,{method:'POST',body:JSON.stringify({revision:tour.revision,fromId:tour.scenes[0].id,toId:tour.scenes[1].id,fromYaw:0,toYaw:180})},true));assert.equal(response.status,400);assert.equal(calls.filter(call=>call.method!=='GET').length,0);
});
test('floor reassignment invalidates moved poses and crossing links',()=>{
 const tour=syntheticTour(),scenes=tour.scenes.map(scene=>({id:scene.id,name:scene.name,room:scene.room,floor:scene.id===tour.scenes[0].id?1:0}));const next=applyMetadata(tour,{revision:tour.revision,scenes});assert.equal(next.scenes[0].position,null);assert.ok(next.scenes[0].links.length===0);assert.ok(next.scenes.slice(1).every(scene=>!scene.links.includes(next.scenes[0].id)));
});
test('published plan status projects only registered metadata and hides job paths',async()=>{
 const tour={...syntheticTour(),published:true};mock=call=>call.url.pathname.endsWith('/imo3d_tours')?result([{payload:tour}]):result([{tour_id:tour.id,floor:0,job_id:'job',input_hash:aiPlanFingerprint(tour.scenes),scene_ids:tour.scenes.map(scene=>scene.id),storage_key:'private/plan.png',public_metadata:{imagePath:'C:/private/plan.png',auditPath:'C:/private/audit.json'}}]);
 const response=await cloudRoute(req(`tours/${tour.id}/ai-plan`));assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('storage_key'));assert.ok(!text.includes('C:/private'));assert.ok(!text.includes('public_metadata'));
});
test('stale plan registration never produces a signed download',async()=>{
 const tour={...syntheticTour(),published:true};mock=call=>call.url.pathname.endsWith('/imo3d_tours')?result([{payload:tour}]):result([{tour_id:tour.id,floor:0,job_id:'job',input_hash:'stale',storage_key:'private/plan.png'}]);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/ai-plan/image?job=job&floor=0`))).status,404);assert.ok(!calls.some(call=>call.url.pathname.includes('/object/sign')));
});
test('processing response drops unrecognized private result fields',()=>{
 const job=publicProcessingJob({id:'job',tour_id:'tour',status:'completed',progress:1,stage:'done',created_at:'now',updated_at:'now',input_hash:'hash',lease_until:0,error:null,result:{registered:2,total:2,links:2,components:1,scale:'relative',privatePath:'C:/private/report',audit:{secret:'private'}},warnings:[]});assert.ok(!JSON.stringify(job).includes('private'));
});
test('5 MiB logo initialization returns a signed direct upload, without sending image bytes through Vercel',async()=>{
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_projects'))return result([{id:'synthetic-project',name:'project',location:'',created_at:'now'}]);
  if(call.url.pathname.endsWith('/imo3d_project_developers'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_begin_brand_upload')){assert.equal(call.body?.p_size,5*1024*1024);return result(true);}
  if(call.url.pathname.includes('/object/upload/sign/'))return result({url:'/object/upload/sign/imo3d-private/brand?token=synthetic'});throw Error('unexpected');
 };
 const response=await cloudRoute(req('projects/synthetic-project/branding-init',{method:'POST',body:JSON.stringify({name:'Brand',accent:'#24b18b',logoStyle:'clean',size:5*1024*1024,type:'image/png'})},true));assert.equal(response.status,201);const body=await response.json();assert.equal(body.bucket,'imo3d-private');assert.match(body.endpoint,/^https:\/\/synthetic\.storage\.supabase\.co\//);assert.ok(body.token);assert.equal(calls.filter(call=>call.url.pathname.includes('/object/')&&call.method==='POST').length,1);
});
test('oversize logo fails before a storage reservation is created',async()=>{
 mock=call=>call.url.pathname.endsWith('/imo3d_projects')?result([{id:'synthetic-project',name:'project',location:'',created_at:'now'}]):result([]);
 const response=await cloudRoute(req('projects/synthetic-project/branding-init',{method:'POST',body:JSON.stringify({name:'Brand',accent:'#24b18b',size:5*1024*1024+1,type:'image/png'})},true));assert.equal(response.status,400);assert.equal(calls.some(call=>call.url.pathname.includes('/rpc/')),false);
});
test('logo finalize rejects disguised SVG and releases the lease without altering branding',async()=>{
 const id='10000000-0000-4000-8000-000000000001',bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_projects'))return result([{id:'synthetic-project',name:'project',location:'',created_at:'now'}]);
  if(call.url.pathname.endsWith('/imo3d_project_developers'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_brand_upload_sessions'))return result([{id,project_id:'synthetic-project',status:'pending',size:bytes.length,mime:'image/png',object_key:'upload/logo'}]);
  if(call.url.pathname.endsWith('/imo3d_claim_brand_upload')||call.url.pathname.endsWith('/imo3d_release_brand_upload'))return result(true);
  if(call.url.pathname.includes('/object/authenticated/'))return new Response(bytes);throw Error('unexpected');
 };
 const response=await cloudRoute(req('projects/synthetic-project/branding-finalize',{method:'POST',body:JSON.stringify({uploadId:id})},true));assert.equal(response.status,415);assert.ok(calls.some(call=>call.url.pathname.endsWith('/imo3d_release_brand_upload')));assert.ok(!calls.some(call=>call.url.pathname.endsWith('/imo3d_commit_brand_upload')));
});
test('a database CAS conflict returns actionable text without backend details',async()=>{
 const tour=syntheticTour();mock=call=>call.url.pathname.endsWith('/imo3d_tours')?result([{payload:tour}]):result({code:'40001'},409);
 const response=await cloudRoute(req(`tours/${tour.id}`,{method:'PATCH',body:JSON.stringify({revision:0,title:'New title'})},true));assert.equal(response.status,409);const body=await response.json();assert.match(body.error,/أعد تحميل/);assert.ok(!body.error.includes('CONFLICT'));
});
import sharp from 'sharp';
for(const newFloor of [0,1])test(`actual Sharp finalization commits spatial data for ${newFloor===0?'the first':'a new'} floor in one RPC`,async()=>{
 const tour=syntheticTour();if(newFloor===0){tour.scenes=[];tour.plans=[];tour.quality={positioned:0,depthScenes:0,components:0,warnings:[]};}
 const uploadId='10000000-0000-4000-8000-000000000001',sceneId='10000000-0000-4000-8000-000000000002';
 const image=await sharp({create:{width:1024,height:512,channels:3,background:'#a2b4bc'}}).png().toBuffer();
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_upload_sessions'))return result([{id:uploadId,tour_id:tour.id,name:'new-floor.png',size:image.length,mime:'image/png',floor:newFloor,object_key:'uploads/synthetic/original',scene_id:sceneId,status:'pending',expires_at:new Date(Date.now()+60000).toISOString(),lease_token:null}]);
  if(call.url.pathname.endsWith('/imo3d_claim_upload'))return result(true);
  if(call.url.pathname.includes('/object/authenticated/'))return new Response(new Uint8Array(image));
  if(call.url.pathname.includes('/storage/v1/object/imo3d-private/'))return result({});
  if(call.url.pathname.endsWith('/imo3d_commit_upload_v2')){
   const prepared=call.body!.p_tour as ReturnType<typeof syntheticTour>;assert.equal(prepared.scenes.length,tour.scenes.length+1);assert.deepEqual(call.body?.p_scene,prepared.scenes.find(scene=>scene.id===sceneId));assert.ok(prepared.plans.some(plan=>plan.floor===newFloor));assert.ok(tour.plans.every(plan=>prepared.plans.some(candidate=>JSON.stringify(candidate)===JSON.stringify(plan))));assert.equal(prepared.quality.components,newFloor===0?1:2);assert.equal(call.body?.p_expected_revision,tour.revision);return result({...prepared,revision:tour.revision+1});
  }
  throw Error('Unexpected '+call.url.pathname);
 };
 const response=await cloudRoute(req(`tours/${tour.id}/images-finalize`,{method:'POST',body:JSON.stringify({uploadId,revision:tour.revision})},true));assert.equal(response.status,201);assert.equal(calls.filter(call=>call.url.pathname.endsWith('/imo3d_commit_upload_v2')).length,1);assert.ok(!calls.some(call=>call.url.pathname.endsWith('/imo3d_save_tour')));
});



test('cloud room entry view preserves geometry and uses optimistic revision checks',()=>{
 const tour=syntheticTour(),before=JSON.stringify(tour),view={yaw:-75,pitch:10,fov:65};
 const next=applyMetadata(tour,tourMetadataSchema.parse({revision:tour.revision,entryView:{sceneId:tour.scenes[1].id,view}}));
 assert.deepEqual(next.scenes[1].entryView,view);assert.deepEqual(next.plans,tour.plans);assert.equal(JSON.stringify(tour),before);
 assert.throws(()=>applyMetadata(next,{revision:next.revision+1,entryView:{sceneId:tour.scenes[0].id,view}}),/تغيّرت/);
 assert.throws(()=>applyMetadata(next,{revision:next.revision,entryView:{sceneId:'foreign',view}}),/غير موجودة/);
 assert.equal(applyMetadata(next,{revision:next.revision,entryView:{sceneId:tour.scenes[1].id,view:null}}).scenes[1].entryView,undefined);
});


test('photo edit draft metadata and assets remain private until a draft is applied',async()=>{
 const tour=syntheticTour();tour.published=true;const assetId='00000000-0000-4000-8000-000000000009';
 tour.photoEdits=[{id:assetId,sceneId:tour.scenes[0].id,source:tour.scenes[0].image,prompt:'Private edit prompt',yaw:0,pitch:0,fov:50,status:'draft',createdAt:'2020-01-01',updatedAt:'2020-01-01'}];
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);if(call.url.pathname.endsWith('/imo3d_project_branding'))return result([]);if(call.url.pathname.endsWith('/imo3d_assets'))return result([{id:assetId,tour_id:tour.id,file:'retouch-draft.webp',storage_key:'retouch/test.webp',mime:'image/webp'}]);if(call.url.pathname.includes('/object/sign/'))return result({signedURL:'/object/sign/imo3d-private/retouch/test.webp?token=synthetic'});throw Error('Unexpected '+call.url.pathname);};
 const publicBody=await (await cloudRoute(req('tours/'+tour.id))).json();assert.equal(publicBody.photoEdits,undefined);
 assert.equal((await cloudRoute(req('assets/'+assetId))).status,404);assert.equal(calls.filter(c=>c.method==='POST').length,0);
 tour.scenes[0].presentation={image:'/api/imo3d/assets/'+assetId,preview:'/preview',thumbnail:'/thumb',width:4096,height:2048};
 assert.equal((await cloudRoute(req('assets/'+assetId))).status,307);
});
test('photo editing requires admin, optimistic revision and never mutates source assets',async()=>{
 const tour=syntheticTour();tour.published=true;
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);if(call.url.pathname.endsWith('/imo3d_save_tour')){const next=call.body!.p_tour as typeof tour;assert.deepEqual(next.scenes,tour.scenes);assert.equal(next.photoEdits![0].status,'queued');assert.equal(call.body!.p_expected_revision,tour.revision);return result({...next,revision:tour.revision+1});}throw Error('Unexpected '+call.url.pathname);};
 const input={revision:tour.revision,action:'create',sceneId:tour.scenes[0].id,prompt:'Remove the camera',yaw:0,pitch:-90,fov:85};
 assert.equal((await cloudRoute(req(`tours/${tour.id}/photo-edits`,{method:'POST',body:JSON.stringify(input)}))).status,401);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/photo-edits`,{method:'POST',body:JSON.stringify({...input,revision:99})},true))).status,409);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/photo-edits`,{method:'POST',body:JSON.stringify(input)},true))).status,200);
 assert.equal(calls.filter(c=>c.method!=='GET').length,1);
});
test('hotspot uploads reject disallowed formats and oversized images before signing',async()=>{
 const tour=syntheticTour();mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);throw Error('Unexpected storage write');};
 for(const input of [{action:'init',mime:'image/svg+xml',size:200},{action:'init',mime:'image/png',size:11_000_000},{action:'init',mime:'video/mp4',size:60_000_000}])assert.ok((await cloudRoute(req(`tours/${tour.id}/hotspot-media`,{method:'POST',body:JSON.stringify(input)},true))).status>=400);
 assert.equal(calls.filter(c=>c.method!=='GET').length,0);
});


for(const initialStatus of ['queued','running','cancelled','completed',null])test(`processing cancellation returns a renderable latest job for ${initialStatus ?? 'no prior job'}`,async()=>{
 const tour=syntheticTour();const before=JSON.stringify(tour);
 let row=initialStatus?{id:'cancel-test',tour_id:tour.id,status:initialStatus,progress:35,stage:'Processing',created_at:'2026-01-01',updated_at:'2026-01-01',error:null,warnings:[],result:null,input_hash:'private-hash',lease_owner:'private-worker',lease_until:0}:null;
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  assert.ok(call.url.pathname.endsWith('/rpc/imo3d_cancel_tour_workflow'));
  assert.equal(call.method,'POST');assert.equal(call.body?.p_tour_id,tour.id);
  if(row&&['queued','running'].includes(row.status))row={...row,status:'cancelled',stage:'أُلغيت المعالجة'};
  return result(row);
 };
 for(let repeat=0;repeat<2;repeat++){
  const response=await cloudRoute(req(`tours/${tour.id}/processing-cancel`,{method:'POST'},true));assert.equal(response.status,200);
  const body=await response.json(),job=parseProcessingJob(body);
  assert.equal(job?.status??null,initialStatus===null?null:initialStatus==='completed'?'completed':'cancelled');
  if(job){assert.equal(job.warnings.length,0);assert.equal(body.lease_owner,undefined);assert.equal(body.input_hash,undefined);assert.equal(job.tourId,tour.id);}
 }
 assert.equal(JSON.stringify(tour),before);assert.equal(calls.filter(c=>c.url.pathname.endsWith('/rpc/imo3d_cancel_tour_workflow')).length,2);
});

test('processing responses reject old cancellation counts before reaching render state',()=>{
 for(const value of [0,1,2,undefined,{}, {status:'cancelled'}, {id:'x',warnings:null}])assert.throws(()=>parseProcessingJob(value),/تعذر قراءة حالة/);
 assert.equal(parseProcessingJob(null),null);
 const job=parseProcessingJob({id:'a',tourId:'b',status:'cancelled',progress:35,stage:'Cancelled',createdAt:'2026-01-01',updatedAt:'2026-01-01',error:null});assert.deepEqual(job?.warnings,[]);
});


test('compact scene aliases round-trip without altering descriptive text or hiding layout failures',()=>{
 const value={id:'a-long-scene-id',floor:0,evidenceSceneIds:['a-long-scene-id'],notes:'Door by a-long-scene-id'};
 const short=new Map([['a-long-scene-id','S1']]),long=new Map([['S1','a-long-scene-id']]);
 assert.deepEqual(translatePlanIds(translatePlanIds(value,short),long),value);
 assert.equal((translatePlanIds(value,short) as typeof value).notes,value.notes);
 assert.ok(!planFailureMessage(Error('Layout omitted scene evidence.')).includes('اشتراك'));
 assert.ok(planFailureMessage(Error('GEOMETRY_UNRESOLVED')).includes('توزيع الجدران'));
});


test('photo retries request a fresh plan even when the atomic workflow reused an old partial draft',async()=>{
 const tour=syntheticTour();mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs')||call.url.pathname.endsWith('/imo3d_subscription_plan_jobs')){assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);assert.equal(call.url.searchParams.get('status'),'in.(queued,running)');return result([]);}
  if(call.url.pathname.endsWith('/rpc/imo3d_enqueue_subscription_plan')){assert.equal(call.body?.p_hash,aiPlanFingerprint(tour.scenes));assert.equal((call.body?.p_scenes as unknown[]).length,tour.scenes.length);return result('fresh-plan-after-old-draft');}
  assert.ok(call.url.pathname.endsWith('/rpc/imo3d_start_tour_workflow'));
  assert.equal(call.body?.p_tour_id,tour.id);assert.ok(call.body?.p_input_hash);assert.ok(call.body?.p_plan_hash);
  assert.equal((call.body?.p_scenes as unknown[]).length,tour.scenes.length);
  return result({id:'automatic-job',tour_id:tour.id,status:'queued',stage:'Queued',progress:0,warnings:[],created_at:'2026-01-01',updated_at:'2026-01-01'});
 };
 const response=await cloudRoute(req(`tours/${tour.id}/processing`,{method:'POST'},true));assert.equal(response.status,202);assert.equal((await response.json()).id,'automatic-job');
 assert.deepEqual(calls.filter(c=>c.url.pathname.includes('/rpc/')).map(c=>c.url.pathname.split('/').at(-1)),['imo3d_start_tour_workflow','imo3d_enqueue_subscription_plan']);
});

for(const status of ['queued','running'])test(`photo reanalysis preserves an active ${status} same-source plan`,async()=>{
 const tour=syntheticTour();mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  assert.equal(call.method,'GET');assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs'))return result([]);
  assert.ok(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs'));
  return result([{id:'existing-plan',status,input_hash:aiPlanFingerprint(tour.scenes),lease_until:new Date(Date.now()+60000).toISOString()}]);
 };
 const response=await cloudRoute(req(`tours/${tour.id}/processing`,{method:'POST'},true));assert.equal(response.status,409);assert.match((await response.json()).error,/المخطط الحالي/);assert.equal(calls.filter(c=>c.method!=='GET').length,0);
});

test('new photos invalidate only their own obsolete plan before starting the automatic sequence',async()=>{
 const tour=syntheticTour();mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs')){
   if(call.method==='GET')return result([{id:'old-plan',status:'running',input_hash:'old-photo-hash',lease_until:new Date(Date.now()+60000).toISOString()}]);
   assert.equal(call.method,'PATCH');assert.equal(call.url.searchParams.get('id'),'eq.old-plan');assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);assert.equal(call.url.searchParams.get('input_hash'),'eq.old-photo-hash');assert.equal(call.url.searchParams.get('status'),'in.(queued,running)');assert.equal(call.body?.status,'stale');return result([{id:'old-plan'}]);
  }
  if(call.url.pathname.endsWith('/rpc/imo3d_start_tour_workflow'))return result({id:'new-photos',tour_id:tour.id,status:'queued',progress:0,stage:'queued'});
  assert.ok(call.url.pathname.endsWith('/rpc/imo3d_enqueue_subscription_plan'));return result('new-plan');
 };
 const response=await cloudRoute(req(`tours/${tour.id}/processing`,{method:'POST'},true));assert.equal(response.status,202);
 assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
});

test('retrying an active photo workflow repairs the plan queue without replacing either active job',async()=>{
 const tour=syntheticTour(),photo={id:'existing-photo',tour_id:tour.id,status:'running',input_hash:imageFingerprint(tour.scenes),progress:40,stage:'matching'};mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs'))return result([photo]);
  if(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs'))return result([{id:'existing-plan',status:'queued',input_hash:aiPlanFingerprint(tour.scenes)}]);
  if(call.url.pathname.endsWith('/rpc/imo3d_start_tour_workflow'))return result(photo);
  assert.ok(call.url.pathname.endsWith('/rpc/imo3d_enqueue_subscription_plan'));return result('existing-plan');
 };
 const response=await cloudRoute(req(`tours/${tour.id}/processing`,{method:'POST'},true));assert.equal(response.status,202);assert.equal((await response.json()).id,photo.id);assert.equal(calls.filter(c=>c.method==='PATCH').length,0);
});

test('an expired plan lease does not permanently block photo workflow retries',async()=>{
 const tour=syntheticTour();mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs'))return result([{id:'expired-plan',status:'running',input_hash:aiPlanFingerprint(tour.scenes),lease_until:new Date(Date.now()-60000).toISOString()}]);
  if(call.url.pathname.endsWith('/rpc/imo3d_start_tour_workflow'))return result({id:'recovered-photo',tour_id:tour.id,status:'queued',progress:0,stage:'queued'});
  assert.ok(call.url.pathname.endsWith('/rpc/imo3d_enqueue_subscription_plan'));return result('replacement-plan');
 };
 const response=await cloudRoute(req(`tours/${tour.id}/processing`,{method:'POST'},true));assert.equal(response.status,202);assert.equal(calls.filter(c=>c.method==='PATCH').length,0);
});


test('reference boards fit the image-tool byte budget and preserve two-column order',async()=>{
 const base=path.resolve('work/plan-board-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'run-'));
 const files=await Promise.all(['#ff0000','#0000ff'].map(async(color,i)=>{const file=path.join(root,i+'.png');await writeFile(file,await sharp({create:{width:1152,height:768,channels:3,background:color}}).png().toBuffer());return file;}));
 const board=await planEvidenceBoard(files),meta=await sharp(board).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,1440);assert.equal(meta.height,480);assert.ok(board.length<=900_000);
 const left=await sharp(board).extract({left:360,top:240,width:1,height:1}).raw().toBuffer(),right=await sharp(board).extract({left:1080,top:240,width:1,height:1}).raw().toBuffer();assert.ok(left[0]>240&&left[2]<15);assert.ok(right[2]>240&&right[0]<15);
 await assert.rejects(planEvidenceBoard([]),/INVALID_BOARD_SIZE/);
});


test('plan polling labels partial drafts honestly and reads only their layout metadata',async()=>{
 const tour=syntheticTour(),draft='00000000-0000-4000-8000-000000000001';
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_plan_workers'))return result([{id:'subscription',seen_at:new Date().toISOString()}]);
  if(call.url.pathname.endsWith('/imo3d_subscription_plan_jobs'))return result([{id:'job',tour_id:tour.id,status:'draft',stage:'ready',input_hash:aiPlanFingerprint(tour.scenes),draft_ids:[draft]}]);
  assert.ok(call.url.pathname.endsWith('/imo3d_chatgpt_drafts'));assert.equal(call.url.searchParams.get('tour_id'),'eq.'+tour.id);assert.equal(call.url.searchParams.get('select'),'layout:result->layout');
  return result([{layout:{rooms:[{polygon:[{}, {}, {}]},{polygon:null}]}}]);
 };
 const response=await cloudRoute(req(`tours/${tour.id}/ai-plan`,{},true));assert.equal(response.status,200);
 const data=await response.json();assert.match(data.job.stage,/1 من 2/);assert.equal(data.stale,false);assert.equal(data.provider,null);assert.equal(data.workerOnline,true);

});

test('plan polling hides private and missing tours before querying jobs',async()=>{
 const tour=syntheticTour();let missing=false;
 mock=call=>{assert.ok(call.url.pathname.endsWith('/imo3d_tours'));return result(missing?[]:[{payload:{...tour,published:false}}]);};
 assert.equal((await cloudRoute(req(`tours/${tour.id}/ai-plan`))).status,404);
 missing=true;assert.equal((await cloudRoute(req(`tours/${tour.id}/ai-plan`,{},true))).status,404);
 assert.equal(calls.length,2);
});
test('a studio-suite session unlocks the admin API; without one the API answers 401 JSON',async()=>{
 const token='suite-token.'+'b'.repeat(40);process.env.MS_ZONE_ORIGIN='https://zone.example.test';
 mock=call=>{
  if(call.url.origin==='https://zone.example.test'){assert.equal(call.url.pathname,'/media-support/api/_ms/session');return result({ok:true,uid:'owner',email:'owner@example.test'});}
  throw Error('Unexpected cloud request '+call.url.pathname);
 };
 const suiteReq=(url:string,init:RequestInit={})=>new Request(origin+'/media-support/tour/api/imo3d/'+url,{...init,headers:{cookie:'ms_session='+token,...Object.fromEntries(new Headers(init.headers))}});
 assert.deepEqual(await (await cloudRoute(suiteReq('session'))).json(),{admin:true,local:false,cloud:true,uploadMode:'signed'});
 assert.equal(await cloudIsAdmin(suiteReq('session')),true);
 assert.equal(calls.filter(call=>call.url.origin==='https://zone.example.test').length,1,'the positive answer is remembered');
 const anonymous=await cloudRoute(new Request(origin+'/media-support/tour/api/imo3d/dashboard'));
 assert.equal(anonymous.status,401);assert.match(anonymous.headers.get('content-type')!,/json/);assert.deepEqual(await anonymous.json(),{error:'تسجيل دخول الإدارة مطلوب.'});
 mock=call=>call.url.origin==='https://zone.example.test'?result({ok:false},401):(()=>{throw Error('Unexpected '+call.url.pathname);})();
 const refused=new Request(origin+'/media-support/tour/api/imo3d/dashboard',{headers:{cookie:'ms_session=other-token.'+'c'.repeat(40)}});
 assert.equal((await cloudRoute(refused)).status,401);
});

test('API paths answer under the suite basePath and at their old form; stray prefixes do not',async()=>{
 for(const path of ['/media-support/tour/api/imo3d/session','/api/imo3d/session'])assert.equal((await cloudRoute(new Request(origin+path))).status,200,path);
 for(const path of ['/media-support/api/imo3d/session','/media-support/tourx/api/imo3d/session'])assert.equal((await cloudRoute(new Request(origin+path))).status,404,path);
});

test('writes from the suite origin are same-origin; foreign and cross-site origins are refused',()=>{
 const post=(headers:Record<string,string>)=>new Request(origin+'/media-support/tour/api/imo3d/tours',{method:'POST',headers});
 assert.equal(cloudSameOrigin(post({Origin:'https://os.bmk.solutions'})),true);
 assert.equal(cloudSameOrigin(post({Origin:'https://bmk-media-support.vercel.app'})),true);
 assert.equal(cloudSameOrigin(post({Origin:origin})),true);
 assert.equal(cloudSameOrigin(post({Origin:'https://evil.example.test'})),false);
 assert.equal(cloudSameOrigin(post({Origin:'https://os.bmk.solutions','Sec-Fetch-Site':'cross-site'})),false);
 assert.equal(cloudSameOrigin(post({})),false);
});

test('embed codes frame the app host under the new basePath even when the public origin is the suite',async()=>{
 const tour={...syntheticTour(),published:true};process.env.IMO3D_PUBLIC_ORIGIN='https://os.bmk.solutions';
 mock=call=>call.url.pathname.endsWith('/imo3d_tours')?result([{payload:tour}]):(()=>{throw Error('Unexpected '+call.url.pathname);})();
 const response=await cloudRoute(new Request('https://os.bmk.solutions/media-support/tour/api/imo3d/tours/'+tour.id+'/embed',{headers:{cookie:adminCookie()}}));
 assert.equal(response.status,200);const body=await response.json(),src='https://bmk-imo3d.vercel.app/media-support/tour/t/'+tour.id;
 assert.equal(body.url,src);assert.ok(body.html.includes('<iframe src="'+src+'"'));assert.equal(body.html.includes('os.bmk.solutions'),false);
});

test('the legacy password session cookie is scoped to this app, not to the whole suite domain',async()=>{
 mock=call=>call.url.pathname.endsWith('/imo3d_rate_limit')?result(true):(()=>{throw Error('Unexpected request');})();
 const response=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password:secret})}));
 assert.equal(response.status,200);assert.match(response.headers.get('set-cookie')!,/; Path=\/media-support\/tour; /);
});

test('by default the old password login is closed: its cookie is not admin and POST session is refused before any check',async()=>{
 delete process.env.IMO3D_PASSWORD_LOGIN;const token='suite-token.'+'d'.repeat(40);process.env.MS_ZONE_ORIGIN='https://zone.example.test';
 mock=call=>{
  if(call.url.origin==='https://zone.example.test')return result({ok:true,uid:'owner',email:'owner@example.test'});
  throw Error('Unexpected cloud request '+call.url.pathname);
 };
 assert.equal(await cloudIsAdmin(req('session',{},true)),false,'a valid legacy cookie opens nothing');
 assert.deepEqual(await (await cloudRoute(req('session',{},true))).json(),{admin:false,local:false,cloud:true,uploadMode:'signed'});
 assert.equal((await cloudRoute(req('dashboard',{},true))).status,401);
 const login=await cloudRoute(req('session',{method:'POST',body:JSON.stringify({password:secret})}));
 assert.equal(login.status,403);assert.equal(login.headers.has('set-cookie'),false);
 assert.deepEqual(calls,[],'no rate-limit call and no credential lookup: the password is never checked');
 assert.equal(await cloudIsAdmin(new Request(origin+'/media-support/tour/api/imo3d/session',{headers:{cookie:'ms_session='+token}})),true,'the suite session still opens the API');
 process.env.IMO3D_PASSWORD_LOGIN='1';assert.equal(await cloudIsAdmin(req('session',{},true)),true,'the break-glass switch reopens it');
});

const buyerDepth=()=>({width:32,height:16,values:Array.from({length:512},(_,i)=>i<64?0:3+i/1e5),confidence:.6,coverage:.875,source:'monocular-multiview-floor-aligned' as const,units:'camera_height' as const,purpose:'display_only' as const});
test('a buyer arrival omits display depth and names the scenes that have it; the administrator keeps it',async()=>{
 const tour={...syntheticTour(),published:true};tour.scenes=tour.scenes.map((scene,index)=>index<2?{...scene,displayDepth:buyerDepth()}:scene);
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);if(call.url.pathname.endsWith('/imo3d_project_branding')||call.url.pathname.endsWith('/imo3d_projects'))return result([]);throw Error('unexpected '+call.url.pathname);};
 const buyer=await (await cloudRoute(req(`tours/${tour.id}`))).json();
 assert.ok(buyer.scenes.every((scene:Record<string,unknown>)=>!('displayDepth' in scene)));assert.deepEqual(buyer.deferredDepth,[tour.scenes[0].id,tour.scenes[1].id]);
 const admin=await (await cloudRoute(req(`tours/${tour.id}`,{},true))).json();
 assert.equal(admin.scenes[0].displayDepth.width,32);assert.equal(admin.deferredDepth,undefined);
});
test('scene depth is public and cacheable only for a published tour, and only where the scene has it',async()=>{
 const tour={...syntheticTour(),published:true};tour.scenes[0]={...tour.scenes[0],displayDepth:buyerDepth()};
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);throw Error('unexpected '+call.url.pathname);};
 const served=await cloudRoute(req(`tours/${tour.id}/depth/${tour.scenes[0].id}`));assert.equal(served.status,200);
 assert.equal(served.headers.get('cache-control'),'public, max-age=300, s-maxage=86400');assert.equal((await served.json()).values.length,512);
 assert.equal((await cloudRoute(req(`tours/${tour.id}/depth/${tour.scenes[1].id}`))).status,404);
 tour.published=false;assert.equal((await cloudRoute(req(`tours/${tour.id}/depth/${tour.scenes[0].id}`))).status,404);
 const admin=await cloudRoute(req(`tours/${tour.id}/depth/${tour.scenes[0].id}`,{},true));assert.equal(admin.status,200);assert.equal(admin.headers.get('cache-control'),'private, no-store');
});
test('the published plan is served as WebP and a ≤600 px mini; without a variant it stays the signed PNG',async()=>{
 const tour={...syntheticTour(),published:true},png=await sharp({create:{width:1086,height:1448,channels:3,background:'white'}}).png().toBuffer();
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_approved_plan_refs'))return result([{tour_id:tour.id,floor:0,job_id:'job',input_hash:aiPlanFingerprint(tour.scenes),scene_ids:[],storage_key:'private/plan.png'}]);
  if(call.url.pathname==='/storage/v1/object/authenticated/imo3d-private/private/plan.png')return new Response(new Uint8Array(png));
  if(call.url.pathname==='/storage/v1/object/sign/imo3d-private/private/plan.png')return result({signedURL:'/object/sign/imo3d-private/private/plan.png?token=t'});
  throw Error('unexpected '+call.url.pathname);
 };
 const mini=await cloudRoute(req(`tours/${tour.id}/ai-plan/image?job=job&floor=0&variant=mini`));assert.equal(mini.status,200);assert.equal(mini.headers.get('content-type'),'image/webp');
 assert.equal(mini.headers.get('cache-control'),'public, max-age=3600, s-maxage=86400');
 const miniMeta=await sharp(Buffer.from(await mini.arrayBuffer())).metadata();assert.equal(miniMeta.format,'webp');assert.ok(Math.max(miniMeta.width!,miniMeta.height!)<=600);
 const full=await cloudRoute(req(`tours/${tour.id}/ai-plan/image?job=job&floor=0&variant=webp`));assert.equal((await sharp(Buffer.from(await full.arrayBuffer())).metadata()).width,1086);
 const original=await cloudRoute(req(`tours/${tour.id}/ai-plan/image?job=job&floor=0`));assert.equal(original.status,307);
});
test('a shared link’s picture is the first scene, 1200×630 JPEG, for published tours only',async()=>{
 const tour={...syntheticTour(),published:true},panorama=await sharp({create:{width:2048,height:1024,channels:3,background:'#8aa'}}).webp().toBuffer();tour.scenes[0].preview='/api/imo3d/assets/preview-0';
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_assets')){assert.equal(call.url.searchParams.get('id'),'eq.preview-0');return result([{id:'preview-0',tour_id:tour.id,file:'p.webp',mime:'image/webp',storage_key:'tour/preview.webp'}]);}
  if(call.url.pathname==='/storage/v1/object/authenticated/imo3d-private/tour/preview.webp')return new Response(new Uint8Array(panorama));
  throw Error('unexpected '+call.url.pathname);
 };
 const image=await cloudRoute(req(`tours/${tour.id}/og-image`));assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg');
 const meta=await sharp(Buffer.from(await image.arrayBuffer())).metadata();assert.deepEqual([meta.format,meta.width,meta.height],['jpeg',1200,630]);
 tour.published=false;assert.equal((await cloudRoute(req(`tours/${tour.id}/og-image`))).status,404);
});
test('a queued upload reports the photos engine: offline when its heartbeat is stale, unknown when it never beat',async()=>{
 const tour=syntheticTour();let photos:{id:string;seen_at:string}[]=[{id:'photos',seen_at:new Date(Date.now()-5*60_000).toISOString()}];
 const job={id:'job',tour_id:tour.id,status:'queued',progress:0,stage:'في انتظار المعالجة',created_at:new Date(Date.now()-3*60_000).toISOString(),updated_at:new Date(Date.now()-3*60_000).toISOString(),input_hash:'h',lease_until:0,error:null,result:null,warnings:[]};
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);if(call.url.pathname.endsWith('/imo3d_processing_jobs'))return result(call.url.searchParams.get('status')==='eq.running'?[]:[job]);if(call.url.pathname.endsWith('/imo3d_plan_workers'))return result(photos);throw Error('unexpected '+call.url.pathname);};
 const offline=parseProcessingJob(await (await cloudRoute(req(`tours/${tour.id}/processing`,{},true))).json());assert.equal(offline?.photosEngine,'offline');
 photos=[];assert.equal(parseProcessingJob(await (await cloudRoute(req(`tours/${tour.id}/processing`,{},true))).json())?.photosEngine,'unknown');
 photos=[{id:'photos',seen_at:new Date().toISOString()}];assert.equal(parseProcessingJob(await (await cloudRoute(req(`tours/${tour.id}/processing`,{},true))).json())?.photosEngine,'online');
});
test('the shared-link card is read on the server from the published tour, its branding and its project; anything else is neutral',async()=>{
 const tour={...syntheticTour(),published:true,title:'شقة 101'};
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_project_branding'))return result([{name:'مساكن الروضة',accent:'#24b18b',logo_asset_id:'logo-1',logo_style:'clean'}]);
  if(call.url.pathname.endsWith('/imo3d_projects')){assert.equal(call.url.searchParams.get('id'),'eq.'+tour.projectId);return result([{name:'برج الروضة',location:'جدة'}]);}
  throw Error('unexpected '+call.url.pathname);
 };
 const card=await tourShareMetadata(tour.id);
 assert.deepEqual(card.title,{absolute:'شقة 101 — مساكن الروضة'});assert.equal((card.openGraph as {url:string}).url,'https://os.bmk.solutions/media-support/tour/t/synthetic-tour');
 assert.deepEqual(card.icons,{icon:'https://os.bmk.solutions/media-support/tour/api/imo3d/branding-assets/logo-1',apple:'https://os.bmk.solutions/media-support/tour/api/imo3d/branding-assets/logo-1'});
 tour.published=false;assert.deepEqual((await tourShareMetadata(tour.id)).title,{absolute:'جولة افتراضية 360°'});
 mock=()=>{throw Error('outage');};assert.deepEqual((await tourShareMetadata('synthetic-tour')).title,{absolute:'جولة افتراضية 360°'});
 assert.deepEqual((await tourShareMetadata('../x')).title,{absolute:'جولة افتراضية 360°'});
});

test('ENG-1: the plans worker heartbeat creates exactly its presence row and its provider row, then only refreshes them',async()=>{
 const rows=new Map<string,string>(),writes:string[]=[];
 mock=call=>{
  assert.ok(call.url.pathname.endsWith('/imo3d_plan_workers'),call.url.pathname);
  if(call.method==='PATCH'){const id=decodeURIComponent(call.url.searchParams.get('id')!.replace(/^eq\./,''));writes.push('PATCH '+id);if(!rows.has(id))return result([]);rows.set(id,String(call.body!.seen_at));return result([{id}]);}
  assert.equal(call.method,'POST');const id=String(call.body!.id);writes.push('POST '+id);rows.set(id,String(call.body!.seen_at));return result([{id}],201);
 };
 await ping('codex');
 assert.deepEqual([...rows.keys()].sort(),['subscription','subscription:codex']);
 assert.deepEqual(writes,['PATCH subscription','POST subscription','PATCH subscription:codex','POST subscription:codex']);
 writes.length=0;await ping('codex');assert.deepEqual(writes,['PATCH subscription','PATCH subscription:codex'],'a second beat only refreshes');
 writes.length=0;await ping();assert.deepEqual(writes,['PATCH subscription'],'a worker that names no provider writes only presence');
 const now=Date.now();assert.equal(onlinePlanProvider([...rows].map(([id,seen_at])=>({id,seen_at})),now),'codex');
});
test('ENG-2 / ENG-3: the photos engine is not called offline while a job holds a live lease, and a failed read says unknown',async()=>{
 const tour=syntheticTour(),stale=[{id:'photos',seen_at:new Date(Date.now()-6*3_600_000).toISOString()}];let running:{id:string}[]=[{id:'other-tour-job'}],workersFail=false;
 const job={id:'job',tour_id:tour.id,status:'queued',progress:0,stage:'في انتظار المعالجة',created_at:new Date(Date.now()-3*60_000).toISOString(),updated_at:new Date(Date.now()-3*60_000).toISOString(),input_hash:'h',lease_until:0,error:null,result:null,warnings:[]};
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_plan_workers'))return workersFail?result({code:'PGRST000'},503):result(stale);
  if(call.url.pathname.endsWith('/imo3d_processing_jobs')){
   if(call.url.searchParams.get('status')==='eq.running'){assert.match(call.url.searchParams.get('lease_until')!,/^gt\.\d{13}$/);assert.ok(Number(call.url.searchParams.get('lease_until')!.slice(3))>=Date.now()-5_000,'the lease must be live now');return result(running);}
   return result([job]);
  }
  throw Error('unexpected '+call.url.pathname);
 };
 const engine=async()=>parseProcessingJob(await (await cloudRoute(req(`tours/${tour.id}/processing`,{},true))).json())?.photosEngine;
 assert.equal(await engine(),'online','an engine rolled back to a build that does not beat is working on another tour');
 running=[];assert.equal(await engine(),'offline');
 workersFail=true;assert.equal(await engine(),'unknown','a PostgREST hiccup is not an outage');
});
test('ENG-3: an unpublished tour’s plan WebP and share picture are never cached publicly, even for the administrator',async()=>{
 const tour={...syntheticTour(),published:false},png=await sharp({create:{width:900,height:1200,channels:3,background:'white'}}).png().toBuffer(),panorama=await sharp({create:{width:2048,height:1024,channels:3,background:'#8aa'}}).webp().toBuffer();tour.scenes[0].preview='/api/imo3d/assets/preview-0';
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_approved_plan_refs'))return result([{tour_id:tour.id,floor:0,job_id:'job',input_hash:aiPlanFingerprint(tour.scenes),scene_ids:[],storage_key:'private/plan.png'}]);
  if(call.url.pathname==='/storage/v1/object/authenticated/imo3d-private/private/plan.png')return new Response(new Uint8Array(png));
  if(call.url.pathname.endsWith('/imo3d_assets'))return result([{id:'preview-0',tour_id:tour.id,file:'p.webp',mime:'image/webp',storage_key:'tour/preview.webp'}]);
  if(call.url.pathname==='/storage/v1/object/authenticated/imo3d-private/tour/preview.webp')return new Response(new Uint8Array(panorama));
  throw Error('unexpected '+call.url.pathname);
 };
 for(const variant of ['webp','mini']){const image=await cloudRoute(req(`tours/${tour.id}/ai-plan/image?job=job&floor=0&variant=${variant}`,{},true));assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'private, no-store',variant);}
 const card=await cloudRoute(req(`tours/${tour.id}/og-image`,{},true));assert.equal(card.status,200);assert.equal(card.headers.get('cache-control'),'private, no-store');
 tour.published=true;
 assert.equal((await cloudRoute(req(`tours/${tour.id}/og-image`))).headers.get('cache-control'),'public, max-age=3600, s-maxage=86400');
});
test('ENG-3: an integration key reads the whole tour, display depth included; only an anonymous arrival defers it',async()=>{
 const token='imo3d_'+'b'.repeat(43),tour={...syntheticTour(),published:true};tour.scenes[0]={...tour.scenes[0],displayDepth:buyerDepth()};
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_integration_keys'))return result([{id:'key',project_id:tour.projectId,scopes:['read'],last_used_at:new Date().toISOString()}]);
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_project_branding')||call.url.pathname.endsWith('/imo3d_projects'))return result([]);
  throw Error('unexpected '+call.url.pathname);
 };
 const data=await (await cloudRoute(req(`tours/${tour.id}`,{headers:{Authorization:'Bearer '+token}}))).json();
 assert.equal(data.scenes[0].displayDepth.width,32);assert.equal(data.deferredDepth,undefined);
});
test('BUY-4: a buyer’s tour names its project, so the tab title matches the shared card',async()=>{
 const tour={...syntheticTour(),published:true};
 mock=call=>{
  if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);
  if(call.url.pathname.endsWith('/imo3d_project_branding'))return result([]);
  if(call.url.pathname.endsWith('/imo3d_projects')){assert.equal(call.url.searchParams.get('id'),'eq.'+tour.projectId);return result([{name:'Aved',location:'جدة'}]);}
  throw Error('unexpected '+call.url.pathname);
 };
 const data=await (await cloudRoute(req(`tours/${tour.id}`))).json();
 assert.deepEqual(data.branding,{name:'IMO 3D',accent:'#24b18b',projectName:'Aved'});
 mock=call=>{if(call.url.pathname.endsWith('/imo3d_projects'))throw Error('outage');if(call.url.pathname.endsWith('/imo3d_tours'))return result([{payload:tour}]);return result([]);};
 assert.deepEqual((await (await cloudRoute(req(`tours/${tour.id}`))).json()).branding,{name:'IMO 3D',accent:'#24b18b'},'the tour still opens when the project read fails');
});
