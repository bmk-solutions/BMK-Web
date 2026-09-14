import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {cloudRoute} from '../src/lib/imo3d/cloud/handlers';
import {cloudIsAdmin,cloudSameOrigin} from '../src/lib/imo3d/cloud/auth';
import {applyMetadata} from '../src/lib/imo3d/cloud/geometry';
import {publicProcessingJob} from '../src/lib/imo3d/cloud/jobs';
import {aiPlanFingerprint} from '../src/lib/imo3d/ai-plan-jobs';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import {hashAdminPassword,verifyAdminPassword} from '../src/lib/imo3d/admin-password';
const origin='https://imo3d.example',secret='synthetic-test-secret-is-at-least-32-characters',fetchOriginal=globalThis.fetch,envOriginal={...process.env};
const adminCookie=()=>{const expiry=String(Date.now()+60_000);return `imo3d_session=${expiry}.${createHmac('sha256',secret).update(expiry).digest('hex')}`;};
const req=(url:string,options:RequestInit={},admin=false)=>new Request(origin+'/api/imo3d/'+url,{...options,headers:{...(admin?{cookie:adminCookie()}:{}),...(options.method&&options.method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),...Object.fromEntries(new Headers(options.headers))}});
const result=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
type Call={url:URL;method:string;body:Record<string,unknown>|null};let storedCredential:Record<string,unknown>|null=null;let calls:Call[]=[];let mock:(call:Call)=>Response|Promise<Response>;
beforeEach(()=>{Object.assign(process.env,{IMO3D_CLOUD:'1',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key',IMO3D_ADMIN_SECRET:secret,IMO3D_PUBLIC_ORIGIN:origin,IMO3D_DATA_DIR:path.resolve('work/cloud-test-must-not-create-database')});storedCredential=null;calls=[];mock=call=>{throw Error('Unexpected cloud request '+call.url.pathname);};globalThis.fetch=async(input,init)=>{const call={url:new URL(String(input)),method:init?.method??'GET',body:typeof init?.body==='string'?JSON.parse(init.body):null};if(call.url.pathname.endsWith("/imo3d_admin_credentials")&&call.method==="GET")return result(storedCredential?[storedCredential]:[]);calls.push(call);return mock(call);};});
afterEach(()=>{globalThis.fetch=fetchOriginal;for(const key of Object.keys(process.env))if(!(key in envOriginal))delete process.env[key];Object.assign(process.env,envOriginal);});

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

