import {presentationScene} from '../photo-edits';
import {hotspotMedia} from "./hotspot-media";
import {cloudPhotoEdits} from "./photo-edits";
import {randomUUID} from "node:crypto";
import {tourMedia} from './media';
import {z} from "zod";
import {cloudAccess,cloudChangePassword,cloudLogin,cloudSameOrigin} from "./auth";
import {cloudQuery,cloudRpc,cloudSignedDownload} from "./client";
import {createProject,deleteTour,getAsset,getBranding,getTour,listProjects,listTours,saveTour,withinRateLimit} from "./repository";
import {cloudManagement,cloudDevelopers} from "./management";
import {cloudAIPlan,cloudLeadsPage,cloudProcessing} from "./jobs";
import {cloudFailure,fail,json,readJSON,signedRedirect} from "./http";
import {applyArchitecture,applyBoundaries,applyMetadata,requireRevision} from "./geometry";
import {handleCloudUpload} from "./uploads";
import {cameraBundleSchema,type Tour} from "../model";
import {leadPhoneSchema} from "../lead-validation";
import {tourMetadataSchema} from "../floor-assignment";
import {boundarySchema} from "../floor-boundaries";
import {architectureSaveSchema} from "../architecture-storage";
import {editTourConnection,type ConnectionEdit} from "../connection-editing";
import {removeTourScene} from "../scene-removal";
import {mergeTourSpatial} from "../tour-merge";
import {currentSurfaceModel,surfaceModelMime} from "../surface-model";
import {currentTexturedMesh,meshModelMime,maxMeshBytes} from "../mesh-model";
const tourSummary=(tour:Tour)=>{const {photoEdits,...safe}=tour;void photoEdits;return({...safe,scenes:tour.scenes.map(({depth,displayDepth,...scene})=>{void depth;void displayDepth;return scene;})});};
const revisionBody=z.object({revision:z.number().int().nonnegative()}).strict();
const pair=z.object({revision:z.number().int().nonnegative(),fromId:z.string().regex(/^[\w-]{1,80}$/),toId:z.string().regex(/^[\w-]{1,80}$/)});
async function handle(request:Request){
 const pathname=new URL(request.url).pathname,prefix="/api/imo3d/";
 if(!pathname.startsWith(prefix))return fail("المسار غير موجود.",404);
 const segments=pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
 if(segments.length>4||segments.some(segment=>segment.length>160||!/^[-\w]+$/.test(segment)))return fail("المسار غير موجود.",404);
 const[resource,id,action,last]=segments,method=request.method;
 if(method!=="GET"&&!request.headers.has('authorization')&&!cloudSameOrigin(request))return fail("المصدر غير مسموح.",403);
 const access=await cloudAccess(request);
 if(request.headers.has("authorization")&&!access.integration)return fail("مفتاح API غير صالح أو أُلغي.",401);
 if(method!=="GET"&&!access.integration&&!cloudSameOrigin(request))return fail("المصدر غير مسموح.",403);
 if(resource==='settings'&&id==='password'&&segments.length===2){
  if(!access.sessionAdmin||access.integration)return fail('دخول الإدارة مطلوب.',401);
  if(method!=='POST')return fail('العملية غير متاحة.',405);
  const input=z.object({currentPassword:z.string().min(1).max(256),newPassword:z.string().min(12,'استخدم 12 حرفًا على الأقل.').max(128),confirmPassword:z.string().max(128)}).strict().refine(value=>value.newPassword===value.confirmPassword,{message:'كلمتا المرور الجديدتان غير متطابقتين.'}).parse(await readJSON(request,3000));
  const cookie=await cloudChangePassword(request,input.currentPassword,input.newPassword);
  return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookie}});
 }
 if(resource==="session"&&segments.length===1){
  if(method==="GET")return json({admin:access.sessionAdmin,local:false,cloud:true,uploadMode:"signed"});
  if(access.integration)return fail("استخدم دخول الاستوديو لإدارة الجلسة.",403);
  if(method!=="POST")return fail("العملية غير متاحة.",405);
  const{password}=z.object({password:z.string().max(256)}).parse(await readJSON(request,2000)),cookie=await cloudLogin(request,password);
  return cookie?new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Set-Cookie":cookie,"Cache-Control":"private, no-store"}}):fail("تعذر تسجيل الدخول. تحقق من رمز الإدارة.",401);
 }
 if(resource==="assets"&&id&&segments.length===2&&method==="GET"){
  const asset=await getAsset(id);if(!asset)return fail("الملف غير موجود.",404);
  const tour=await getTour(asset.tour_id);if(!tour||(!tour.published&&!access.allowed(tour.projectId))||access.integration&&!access.allowed(tour.projectId))return fail("الملف غير موجود.",404);
  if(asset.mime===surfaceModelMime&&!tour.plans.some(plan=>currentSurfaceModel(plan,tour.scenes)?.url===`/api/imo3d/assets/${id}`))return fail("النموذج لم يعد يطابق صور الجولة.",404);
  if(asset.mime===meshModelMime){const mesh=tour.plans.map(plan=>currentTexturedMesh(plan,tour.scenes)).find(model=>model?.url===`/api/imo3d/assets/${id}`);if(!mesh||asset.byte_size!==mesh.byteLength||asset.byte_size>maxMeshBytes)return fail("النموذج لم يعد يطابق صور الجولة وحدودها.",404);}
  if(!access.sessionAdmin&&tour.scenes.some(s=>s.presentation&&[s.image,s.preview,s.thumbnail,s.detail?.image].includes(`/api/imo3d/assets/${id}`)))return fail("الملف غير متاح.",404);
  if(asset.file?.startsWith("retouch-")&&!access.sessionAdmin&&!tour.scenes.some(s=>s.presentation&&Object.values(s.presentation).includes(`/api/imo3d/assets/${id}`)))return fail("الملف غير موجود.",404);
  return signedRedirect(await cloudSignedDownload(asset.storage_key));
 }
 if(resource==="tours"&&id&&method==="GET"&&(segments.length===2||segments.length===3&&action==='media')){
  const tour=await getTour(id);if(!tour||!access.allowed(tour.projectId)&&(!tour.published||!!access.integration))return fail("الجولة غير متاحة.",404);
  if(action==='media')return json(await tourMedia(tour));
  const [branding,media]=await Promise.all([getBranding(tour.projectId),new URL(request.url).searchParams.get('media')==='1'?tourMedia(tour).catch(()=>undefined):undefined]);
  const {photoEdits,...publicTour}=tour;
  return json({...publicTour,scenes:access.sessionAdmin?tour.scenes:tour.scenes.map(presentationScene),...(access.sessionAdmin?{photoEdits}:{}),branding,...(media?{media}:{})});
 }
 if(resource==="tours"&&id&&action==="ai-plan"){
  if(last&&last!=="image")return fail("المسار غير موجود.",404);
  const tour=await getTour(id);if(!tour)return fail("الجولة غير متاحة.",404);return cloudAIPlan(request,tour,last,access);
 }
 if(resource==="leads"&&segments.length===1&&method==="POST"){
  const input=z.object({tourId:z.string().max(80),name:z.string().trim().min(2).max(100),phone:leadPhoneSchema,note:z.string().max(2000).default(""),consent:z.literal(true),website:z.string().max(100).default("")}).parse(await readJSON(request,8000));
  if(input.website)return fail("تعذر إرسال الطلب.");const tour=await getTour(input.tourId);
  if(!tour||!tour.published&&!access.allowed(tour.projectId)||access.integration&&!access.allowed(tour.projectId,"write"))return fail("الجولة غير متاحة.",404);
  if(!await withinRateLimit(`lead:${input.phone}:${tour.id}`,3,60*60_000)||!await withinRateLimit(`lead-global:${tour.id}`,100,60*60_000))return fail("تم إرسال طلبك سابقًا. حاول لاحقًا.",429);
  await cloudQuery("leads","","POST",{id:randomUUID(),tour_id:tour.id,name:input.name,phone:input.phone,note:input.note,created_at:new Date().toISOString()});return json({ok:true},201);
 }
 const management=await cloudManagement(request,segments,access);if(management)return management;
 if(!access.sessionAdmin&&!access.integration)return fail("تسجيل دخول الإدارة مطلوب.",401);
 if(resource==="dashboard"&&segments.length===1&&method==="GET"){
  const[projects,tours,developers,page]=await Promise.all([listProjects(),listTours(access.integration?.projectId),access.sessionAdmin?cloudDevelopers():Promise.resolve([]),access.sessionAdmin||access.integration?.scopes.includes("leads")?cloudLeadsPage({projectId:access.integration?.projectId,limit:100}):Promise.resolve({leads:[],total:0})]);
  return json({features:{privateExample:null,cloud:true},projects:projects.filter(project=>access.allowed(project.id)),tours:tours.filter(tour=>access.allowed(tour.projectId)).map(tourSummary),developers,leads:page.leads,leadTotal:page.total});
 }
 if(resource==="example")return fail("استيراد العينة المحلية غير متاح في النشر السحابي.",404);
 if(resource==="projects"&&segments.length===1){
  if(method==="GET")return json((await listProjects()).filter(project=>access.allowed(project.id)));
  if(method==="POST"){
   if(!access.sessionAdmin)return fail("إنشاء المشروع يتطلب جلسة إدارة الاستوديو.",403);
   const input=z.object({name:z.string().trim().min(2).max(120),location:z.string().max(160).default(""),developerId:z.string().uuid().nullable().optional()}).parse(await readJSON(request,3000));return json(await createProject(input.name,input.location,input.developerId),201);
  }
 }
 if(resource==="leads"&&segments.length===1&&method==="GET"){
  const query=new URL(request.url).searchParams,projectId=query.get("projectId")||undefined;
  if(access.integration&&(!access.integration.scopes.includes("leads")||projectId&&projectId!==access.integration.projectId))return fail("طلبات هذا المشروع خارج صلاحية مفتاح API.",403);
  const paged=query.get("paged")==="1"||query.has("cursor")||query.has("limit"),page=await cloudLeadsPage({projectId:access.integration?.projectId||projectId,cursor:query.get("cursor")||undefined,limit:query.has("limit")?Number(query.get("limit")):paged?100:1000});return json(paged?page:page.leads);
 }
 if(resource!=="tours")return fail("المسار غير موجود.",404);
 if(!id){
  if(method==="GET")return json((await listTours(access.integration?.projectId)).filter(tour=>access.allowed(tour.projectId)).map(tourSummary));
  if(method==="POST"){
   const input=z.object({projectId:z.string().uuid(),title:z.string().trim().min(2).max(120)}).parse(await readJSON(request,3000));
   if(!access.allowed(input.projectId,"write"))return fail("المشروع خارج صلاحية مفتاح API.",403);
   if(!(await listProjects()).some(project=>project.id===input.projectId))return fail("المشروع غير موجود.",404);
   const now=new Date().toISOString();return json(await saveTour({id:randomUUID(),title:input.title,projectId:input.projectId,published:false,revision:0,scenes:[],plans:[],createdAt:now,updatedAt:now,unit:{code:"",area:null,price:null,bedrooms:null,bathrooms:null},quality:{positioned:0,depthScenes:0,components:0,warnings:[]}}),201);
  }return fail("العملية غير متاحة.",405);
 }
 const tour=await getTour(id);if(!tour)return fail("الجولة غير موجودة.",404);
 if(!access.allowed(tour.projectId,method==="GET"?"read":"write"))return fail("الجولة خارج صلاحية مفتاح API.",403);
 if(action==="scenes"&&last&&method==="DELETE"){
  const{revision}=revisionBody.parse(await readJSON(request,2000));requireRevision(tour,revision);const next=removeTourScene(tour,last);if(!next)return fail("اللقطة غير موجودة.",404);
  const saved=await cloudRpc<Tour>("delete_scene",{p_tour_id:id,p_scene_id:last,p_expected_revision:revision,p_tour:next});return json({...saved,branding:await getBranding(saved.projectId)});
 }
 if(action==="hotspot-media"&&!last){if(!access.sessionAdmin)return fail("دخول الإدارة مطلوب.",401);return hotspotMedia(request,tour);}
 if(action==="photo-edits"&&!last){if(!access.sessionAdmin)return fail("دخول الإدارة مطلوب.",401);return cloudPhotoEdits(request,tour);}
 if(last)return fail("المسار غير موجود.",404);
 if(action==="images"||action==="images-init"||action==="images-finalize"){if(method!=="POST")return fail("العملية غير متاحة.",405);return handleCloudUpload(request,tour);}
 if(action==="processing"||action==="processing-cancel")return(await cloudProcessing(request,tour,action))??fail("العملية غير متاحة.",405);
 if(action==="embed"&&method==="GET"){
  if(!tour.published)return fail("أتِح رابط الجولة قبل تضمينها في منصة أخرى.",409);
  const src=new URL(`/imo3d/t/${tour.id}`,process.env.IMO3D_PUBLIC_ORIGIN||new URL(request.url).origin).href;return json({url:src,html:`<iframe src="${src}" title="360 tour" width="100%" height="700" style="border:0" allow="fullscreen" loading="lazy"></iframe>`});
 }
 if(action==="connections"&&(method==="POST"||method==="DELETE")){
  const value=method==="POST"?pair.extend({fromYaw:z.number().finite(),toYaw:z.number().finite()}).strict().parse(await readJSON(request,2000)):pair.strict().parse(await readJSON(request,2000));requireRevision(tour,value.revision);
  const connected=method==="POST"?pair.extend({fromYaw:z.number().finite(),toYaw:z.number().finite()}).parse(value):null;
  const edit:ConnectionEdit=connected?{action:"connect",fromId:connected.fromId,toId:connected.toId,fromYaw:connected.fromYaw,toYaw:connected.toYaw}:{action:"disconnect",fromId:value.fromId,toId:value.toId};
  const saved=await saveTour(editTourConnection(tour,edit),value.revision);return json({...saved,branding:await getBranding(saved.projectId)});
 }
 if(action==="architecture"&&method==="PUT"){const input=architectureSaveSchema.parse(await readJSON(request,1_000_000));return json(await saveTour(applyArchitecture(tour,input),input.revision));}
 if(action==="boundaries"&&method==="PUT"){const input=boundarySchema.parse(await readJSON(request,600_000));return json(await saveTour(applyBoundaries(tour,input),input.revision));}
 if(action==="cameras"&&method==="POST"){
  const bundle=cameraBundleSchema.parse(await readJSON(request,4_000_000)),normalize=(name:string)=>name.normalize("NFC").toLowerCase(),names=bundle.cameras.map(camera=>normalize(camera.file));
  if(new Set(names).size!==names.length)return fail("أسماء ملفات الكاميرات مكررة.");const unmatched=bundle.cameras.filter(camera=>!tour.scenes.some(scene=>normalize(scene.sourceName)===normalize(camera.file)));if(unmatched.length)return fail(`لم تُرفع هذه الصور: ${unmatched.slice(0,5).map(camera=>camera.file).join("، ")}`);
  const scenes=tour.scenes.map(scene=>{const camera=bundle.cameras.find(camera=>normalize(camera.file)===normalize(scene.sourceName));return camera?{...scene,position:camera.position,yaw:camera.yaw,floor:camera.floor,room:camera.room||scene.room,depth:camera.depth}:scene;});return json(await saveTour({...tour,...mergeTourSpatial(tour,scenes),spatialSource:"calibrated",spatialScale:"metric"},tour.revision));
 }
 if(action==="rebuild"&&method==="POST"){if(!tour.scenes.some(scene=>scene.depth))return fail("يلزم استيراد بيانات العمق لإعادة الربط وتوليد حدود الشقة. مواقع الصور وحدها لا تثبت الجدران.",422);return json(await saveTour({...tour,...mergeTourSpatial(tour,tour.scenes)},tour.revision));}
 if(!action&&method==="PATCH"){const input=tourMetadataSchema.parse(await readJSON(request,4_000_000));if(input.hotspots){for(const url of new Set(input.hotspots.flatMap(h=>[h.url,h.link]).filter(u=>u.startsWith('/api/imo3d/assets/')))){const a=await getAsset(url.split('/').pop()!);if(!a||a.tour_id!==tour.id)return fail('الملف ليس تابعًا لهذه الجولة.',400);}}return json(await saveTour(applyMetadata(tour,input),input.revision));}
 if(!action&&method==="DELETE"){const{revision}=revisionBody.parse(await readJSON(request,2000));requireRevision(tour,revision);await deleteTour(id,revision);return json({ok:true});}
 return fail("العملية غير متاحة.",405);
}
/** This branch never opens the local SQLite store or spawns a detached process. */
export async function cloudRoute(request:Request){try{return await handle(request);}catch(error){return cloudFailure(error);}}
