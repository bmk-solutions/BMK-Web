import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {DeveloperError,listDevelopers} from "@/lib/imo3d/developer-management";
import { NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,unlink } from "node:fs/promises";
// Resolve private runtime data without tracing its contents into build assets.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");
import { addLead,dataDirectory,db,getTour,installExample,newProject,newTour,projects,saveTour,toursSummary,withinRateLimit } from "@/lib/imo3d/store";
import { isAdmin,login,sameOrigin } from "@/lib/imo3d/auth";
import {servePayloadPaths} from "@/lib/imo3d/base-path";
import {embedTourURL,passwordLoginEnabled} from "@/lib/imo3d/suite";
import {privateExamplePreview,PrivateExampleUnavailableError} from "@/lib/imo3d/private-example";
import { cameraBundleSchema,type Scene,type Tour } from "@/lib/imo3d/model";
import {initialRoomSemantic} from "@/lib/imo3d/room-semantics";
import {AuthoredPlanCalibrationError,mergeTourSpatial} from "@/lib/imo3d/tour-merge";
import {leadPhoneSchema} from "@/lib/imo3d/lead-validation";
import {getLeads,LeadQueryError} from "@/lib/imo3d/lead-query";
import {cancelJob,enqueueJob,imageFingerprint,latestJob} from "@/lib/imo3d/processing-jobs";
import {wakeProcessingWorker} from "@/lib/imo3d/processing-launcher";
import {brandingForProject} from "@/lib/imo3d/branding";
import {integrationForRequest} from "@/lib/imo3d/integrations";
import {FloorAssignmentError,saveTourMetadata,tourMetadataSchema,uploadFloorSchema} from "@/lib/imo3d/floor-assignment";
import {currentSurfaceModel,surfaceModelMime} from "@/lib/imo3d/surface-model";
import {currentTexturedMesh,meshModelMime,maxMeshBytes} from "@/lib/imo3d/mesh-model";
import {pruneUnreferencedSurfaceAssets} from "@/lib/imo3d/surface-model-cleanup";
import {cleanupPrivateAssetFiles} from "@/lib/imo3d/private-asset-cleanup";

export const runtime="nodejs";
export const maxDuration=300;
export const dynamic="force-dynamic";
// Stored asset paths leave in their served form (under the suite basePath).
const json=(value:unknown,status=200)=>NextResponse.json(servePayloadPaths(value),{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
const fail=(message:string,status=400)=>json({error:message},status);
type Context={params:Promise<{path:string[]}>};
async function savedTourResponse(tour:Tour,files:readonly string[],status=200){
  const cleanup=await cleanupPrivateAssetFiles(dataDirectory(),files);
  return json({...tour,...(cleanup.failed.length?{cleanupWarning:"حُفظت الجولة، لكن تعذر تنظيف بعض ملفات النموذج السابق من التخزين. تحتاج هذه الملفات إلى تنظيف لاحق."}:{})},status);
}
function saveSpatialTour(tour:Tour,expectedRevision:number){
  const database=db();database.exec("BEGIN IMMEDIATE");
  try{
    const saved=saveTour(tour,expectedRevision),files=pruneUnreferencedSurfaceAssets(database,saved);
    cancelJob(database,tour.id);database.exec("COMMIT");return{tour:saved,files};
  }catch(error){database.exec("ROLLBACK");throw error;}
}
async function readJSON(request:Request,max=24_000_000) {
  if(Number(request.headers.get("content-length"))>max)throw Error("TOO_LARGE");
  const reader=request.body?.getReader();if(!reader)throw Error("EMPTY");const chunks:Uint8Array[]=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw Error("TOO_LARGE");}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function handle(request:Request,context:Context) {
  if(cloudEnabled())return cloudRoute(request);
  const segments=(await context.params).path;const [resource,id,action]=segments,method=request.method;
  if(segments.length>3)return fail("المسار غير موجود",404);
  const integration=integrationForRequest(request),hasAuthorization=request.headers.has("authorization");
  if(hasAuthorization&&!integration)return fail("مفتاح API غير صالح أو أُلغي",401);
  const sessionAdmin=!hasAuthorization&&await isAdmin(request);
  const admin=sessionAdmin||!!integration;
  const allowed=(projectId:string,scope:"read"|"write"|"leads"="read")=>sessionAdmin||!!integration&&integration.projectId===projectId&&integration.scopes.includes(scope);
  if(method!=="GET"&&!integration&&!sameOrigin(request))return fail("المصدر غير مسموح",403);
  if(integration&&method!=="GET"&&!integration.scopes.includes("write")&&resource!=="leads")return fail("مفتاح API لا يملك صلاحية الكتابة",403);
  if(resource==="session"){
    if(method==="GET")return json({admin:sessionAdmin,local:process.env.NODE_ENV==="development"});
    if(integration)return fail("استخدم دخول الاستوديو لإدارة الجلسة",403);
    if(!passwordLoginEnabled())return fail("الدخول بكلمة المرور متوقف. سجّل الدخول بحساب استوديو BMK.",403);
    const {password}=z.object({password:z.string().max(256)}).parse(await readJSON(request,2000));
    const cookie=login(request,password);return cookie?NextResponse.json({ok:true},{headers:{"Set-Cookie":cookie,"Cache-Control":"no-store"}}):fail("تعذر تسجيل الدخول. تحقق من رمز الإدارة.",401);
  }
  if(resource==="assets"&&method==="GET"){
    const row=db().prepare("SELECT * FROM assets WHERE id=?").get(id);if(!row)return fail("الملف غير موجود",404);
    const tour=getTour(String(row.tour_id));if(!tour||(!tour.published&&!allowed(tour.projectId))||(integration&&!allowed(tour.projectId)))return fail("الملف غير موجود",404);
    if(row.mime===surfaceModelMime&&!tour.plans.some(plan=>currentSurfaceModel(plan,tour.scenes)?.url===`/api/imo3d/assets/${id}`))return fail("النموذج لم يعد يطابق صور الجولة",404);
    const mesh=row.mime===meshModelMime?tour.plans.map(plan=>currentTexturedMesh(plan,tour.scenes)).find(model=>model?.url===`/api/imo3d/assets/${id}`):undefined;
    if(row.mime===meshModelMime&&!mesh)return fail("النموذج لم يعد يطابق صور الجولة وحدودها",404);
    const content=await readFile(path.join(dataDirectory(),"assets",String(row.file)));
    if(mesh&&(content.byteLength!==mesh.byteLength||content.byteLength>maxMeshBytes))return fail("ملف النموذج غير متاح",404);
    return new Response(content,{headers:{"Content-Type":String(row.mime),"Content-Length":String(content.byteLength),"Cache-Control":"private, max-age=3600","X-Content-Type-Options":"nosniff"}});
  }
  if(resource==="tours"&&id&&method==="GET"&&!action){
    const tour=getTour(id);if(!tour||(!tour.published&&!allowed(tour.projectId))||(integration&&!allowed(tour.projectId)))return fail("الجولة غير متاحة",404);return json({...tour,branding:brandingForProject(tour.projectId)});
  }
  if(resource==="leads"&&method==="POST"){
    const input=z.object({tourId:z.string().max(80),name:z.string().trim().min(2).max(100),phone:leadPhoneSchema,note:z.string().max(2000).default(""),consent:z.literal(true),website:z.string().max(100).default("")}).parse(await readJSON(request,8000));
    if(input.website)return fail("تعذر إرسال الطلب",400);
    const tour=getTour(input.tourId);if(!tour||(!tour.published&&!allowed(tour.projectId))||(integration&&!allowed(tour.projectId,"write")))return fail("الجولة غير متاحة",404);
    if(!withinRateLimit(`lead:${input.phone}:${tour.id}`,3,60*60_000)||!withinRateLimit(`lead-global:${tour.id}`,100,60*60_000))return fail("تم إرسال طلبك سابقًا. حاول لاحقًا.",429);
    addLead(tour.id,input.name,input.phone,input.note);return json({ok:true},201);
  }
  if(!admin)return fail("تسجيل دخول الإدارة مطلوب",401);
  if(resource==="dashboard"&&method==="GET"){
    const page=sessionAdmin||integration?.scopes.includes("leads")?getLeads(db(),{projectId:integration?.projectId,limit:100}):{leads:[],total:0};
    return json({features:{privateExample:sessionAdmin?privateExamplePreview():null},developers:sessionAdmin?listDevelopers(db()):[],projects:projects().filter(p=>allowed(p.id)),tours:toursSummary(integration?.projectId).filter(t=>allowed(t.projectId)),leads:page.leads,leadTotal:page.total});
  }
  if(resource==="projects"&&method==="GET")return json(projects().filter(p=>allowed(p.id)));
  if(resource==="tours"&&!id&&method==="GET")return json(toursSummary(integration?.projectId).filter(t=>allowed(t.projectId)));
  if(resource==="leads"&&method==="GET"){
    const query=new URL(request.url).searchParams,requestedProject=query.get("projectId")||undefined;
    if(integration&&(!integration.scopes.includes("leads")||requestedProject&&requestedProject!==integration.projectId))return fail("طلبات هذا المشروع خارج صلاحية مفتاح API",403);
    const paged=query.get("paged")==="1"||query.has("cursor")||query.has("limit");
    const page=getLeads(db(),{projectId:integration?.projectId||requestedProject,cursor:query.get("cursor")||undefined,limit:query.has("limit")?Number(query.get("limit")):paged?100:1000});
    return json(paged?page:page.leads);
  }
  if(resource==="example"&&method==="POST"){if(!sessionAdmin)return fail("يتطلب استيراد العينة دخول الإدارة",403);return json(installExample(),201);}
  if(resource==="projects"&&method==="POST"){
    if(!sessionAdmin)return fail("مفتاح التكامل مخصص للمشروع الذي اخترته",403);
    const input=z.object({name:z.string().trim().min(2).max(120),location:z.string().max(160).default(""),developerId:z.string().uuid().nullable().optional()}).parse(await readJSON(request,3000));
    return json(newProject(input.name,input.location,input.developerId),201);
  }
  if(resource==="tours"&&!id&&method==="POST"){
    const input=z.object({projectId:z.string().uuid(),title:z.string().trim().min(2).max(120)}).parse(await readJSON(request,3000));
    if(!allowed(input.projectId,"write"))return fail("المشروع خارج صلاحية مفتاح API",403);
    if(!projects().some(p=>p.id===input.projectId))return fail("المشروع غير موجود",404);return json(newTour(input.projectId,input.title),201);
  }
  if(resource!=="tours"||!id)return fail("المسار غير موجود",404);
  const tour=getTour(id);if(!tour)return fail("الجولة غير موجودة",404);
  if(!allowed(tour.projectId,method==="GET"?"read":"write"))return fail("الجولة خارج صلاحية مفتاح API",403);
  if(action==="processing"&&method==="GET"){const job=latestJob(db(),tour.id);if(job?.status==="queued"||job?.status==="running")wakeProcessingWorker();return json(job);}
  if(action==="processing"&&method==="POST"){
    if(tour.scenes.length<2||tour.scenes.length>300)return fail("ارفع من صورتين إلى 300 صورة متداخلة للمعالجة التلقائية.",422);
    const job=enqueueJob(db(),tour.id,imageFingerprint(tour.scenes));wakeProcessingWorker();return json(job,202);
  }
  if(action==="processing-cancel"&&method==="POST")return json(cancelJob(db(),tour.id));
  if(action==="embed"&&method==="GET"){
    if(!tour.published)return fail("أتِح رابط الجولة قبل تضمينها في منصة أخرى.",409);
    // This app's own host, never the suite's: os.bmk.solutions refuses framing (SAMEORIGIN).
    const src=embedTourURL(tour.id,new URL(request.url).origin);
    return json({url:src,html:`<iframe src="${src}" title="360 tour" width="100%" height="700" style="border:0" allow="fullscreen" loading="lazy"></iframe>`});
  }
  if(action==="images"&&method==="POST"){
    const maxSize=100*1024*1024,maxPixels=268_435_456,maxMultipartSize=maxSize+65_536;
    const length=Number(request.headers.get("content-length"));if(length>maxMultipartSize)return fail("الحد الأقصى للصورة 100 ميجابايت (MiB)",413);
    if(tour.scenes.length>=500)return fail("الحد الحالي 500 لقطة للجولة");
    const reader=request.body?.getReader();if(!reader)return fail("اختر صورة بانوراما");const chunks:Uint8Array[]=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxMultipartSize){await reader.cancel();return fail("الحد الأقصى للصورة 100 ميجابايت (MiB)",413);}chunks.push(value);}
    const body=await new Response(Buffer.concat(chunks),{headers:{"content-type":request.headers.get("content-type")||""}}).formData();const file=body.get("file");if(!(file instanceof File))return fail("اختر صورة بانوراما");
    chunks.length=0;
    const floor=uploadFloorSchema.parse(body.get("floor"));
    if(!file.name.trim()||file.name.length>200)return fail("اسم ملف الصورة يجب ألا يتجاوز 200 حرف. أعد تسمية الملف ثم ارفعه.");
    if(tour.scenes.some(s=>s.sourceName.normalize("NFC").toLowerCase()===file.name.normalize("NFC").toLowerCase()))return fail("توجد لقطة بهذا الاسم بالفعل. غيّر اسم الملف لتجنب مطابقة كاميرا خاطئة.",409);
    if(file.size>maxSize)return fail("الحد الأقصى للصورة 100 ميجابايت (MiB)",413);
    if(!file.size)return fail("حجم الصورة غير صالح",413);
    const bytes=Buffer.from(await file.arrayBuffer());
    let meta:sharp.Metadata;
    try {meta=await sharp(bytes,{limitInputPixels:maxPixels,animated:false}).metadata();}catch(error){
      if(error instanceof Error&&/pixel limit/i.test(error.message))return fail("دقة الصورة تتجاوز الحد الآمن البالغ 268 مليون بكسل؛ بانوراما 20K مدعومة ضمن حد الحجم.",413);
      return fail("ملف الصورة غير قابل للقراءة. اختر صورة JPG أو PNG أو WEBP صالحة.",415);
    }
    if(!["jpeg","png","webp"].includes(meta.format??"")||!meta.width||!meta.height||Math.abs(meta.width/meta.height-2)>0.03||meta.width<1024)return fail("يلزم صورة 360 كاملة بنسبة 2:1 وعرض 1024 بكسل على الأقل");
    if((meta.pages??1)>1)return fail("اختر بانوراما ثابتة؛ الصور المتحركة أو متعددة الصفحات غير مدعومة.",415);
    if(meta.width*meta.height>maxPixels)return fail("دقة الصورة تتجاوز الحد الآمن البالغ 268 مليون بكسل.",413);
    if([5,6,7,8].includes(meta.orientation??1))return fail("اتجاه الصورة يجعلها عمودية. صدّر البانوراما بنسبة 2:1 دون تدوير EXIF.");
    const sceneId=randomUUID();await mkdir(path.join(dataDirectory(),"assets"),{recursive:true});
    const variants:Record<string,string>={},records:{id:string;file:string}[]=[],written:string[]=[];
    let detail:Scene["detail"];
    try{
    const originalFile=`${sceneId}.original.${meta.format}`;const originalPath=path.join(dataDirectory(),"assets",originalFile);written.push(originalPath);await writeFile(originalPath,bytes,{flag:"wx"});
    for(const [key,width,quality] of [["image",4096,86],["preview",2048,78],["thumbnail",512,72]] as const){
      const assetId=randomUUID(),filename=`${assetId}.webp`;const output=await sharp(bytes,{limitInputPixels:maxPixels,animated:false}).rotate().resize({width,withoutEnlargement:true}).webp({quality}).toBuffer();
      const destination=path.join(dataDirectory(),"assets",filename);written.push(destination);await writeFile(destination,output,{flag:"wx"});variants[key]=`/api/imo3d/assets/${assetId}`;records.push({id:assetId,file:filename});
    }
    if(meta.width>4096){
      const assetId=randomUUID(),filename=`${assetId}.webp`;
      const output=await sharp(bytes,{limitInputPixels:maxPixels,animated:false}).rotate().resize({width:8192,withoutEnlargement:true}).webp({quality:94}).toBuffer({resolveWithObject:true});
      const destination=path.join(dataDirectory(),"assets",filename);written.push(destination);await writeFile(destination,output.data,{flag:"wx"});records.push({id:assetId,file:filename});
      detail={image:`/api/imo3d/assets/${assetId}`,width:output.info.width,height:output.info.height};
    }
    const scene:Scene={id:sceneId,name:file.name.replace(/\.[^.]+$/,"").trim().slice(0,100)||"لقطة 360",sourceName:file.name,room:"لقطات تحتاج تسمية",roomSemantic:initialRoomSemantic(sceneId),floor,
      image:variants.image,preview:variants.preview,thumbnail:variants.thumbnail,...(detail?{detail}:{}),position:null,yaw:0,links:[]};
    const scenes=[...tour.scenes,scene];db().exec("BEGIN IMMEDIATE");
    try{for(const record of records)db().prepare("INSERT INTO assets VALUES(?,?,?,?)").run(record.id,tour.id,record.file,"image/webp");
      db().prepare("INSERT INTO scene_originals VALUES(?,?,?,?,?,?)").run(sceneId,tour.id,originalFile,`image/${meta.format}`,meta.width,meta.height);
      const saved=saveTour({...tour,...mergeTourSpatial(tour,scenes)},tour.revision),files=pruneUnreferencedSurfaceAssets(db(),saved);
      cancelJob(db(),tour.id);db().exec("COMMIT");return savedTourResponse(saved,files,201);
    }catch(error){db().exec("ROLLBACK");throw error;}
    }catch(error){await Promise.all(written.map(file=>unlink(file).catch(()=>{})));throw error;}
  }
  if(action==="cameras"&&method==="POST"){
    const bundle=cameraBundleSchema.parse(await readJSON(request));
    const normalized=(s:string)=>s.normalize("NFC").toLowerCase();
    const names=bundle.cameras.map(c=>normalized(c.file));if(new Set(names).size!==names.length)return fail("أسماء ملفات الكاميرات مكررة");
    const unmatched=bundle.cameras.filter(c=>!tour.scenes.some(s=>normalized(s.sourceName)===normalized(c.file)));
    if(unmatched.length)return fail(`لم تُرفع هذه الصور: ${unmatched.slice(0,5).map(c=>c.file).join("، ")}`);
    const scenes=tour.scenes.map(scene=>{const camera=bundle.cameras.find(c=>normalized(c.file)===normalized(scene.sourceName));return camera?{...scene,position:camera.position,yaw:camera.yaw,floor:camera.floor,room:camera.room||scene.room,depth:camera.depth}:scene;});
    const saved=saveSpatialTour({...tour,...mergeTourSpatial(tour,scenes),spatialSource:"calibrated",spatialScale:"metric"},tour.revision);
    return savedTourResponse(saved.tour,saved.files);
  }
  if(action==="rebuild"&&method==="POST"){
    if(!tour.scenes.some(s=>s.depth))return fail("يلزم استيراد بيانات العمق لإعادة الربط وتوليد حدود الشقة. مواقع الصور وحدها لا تثبت الجدران.",422);
    const saved=saveSpatialTour({...tour,...mergeTourSpatial(tour,tour.scenes)},tour.revision);
    return savedTourResponse(saved.tour,saved.files);
  }
  if(!action&&method==="PATCH"){
    const input=tourMetadataSchema.parse(await readJSON(request));
    const files:string[]=[],saved=saveTourMetadata(db(),tour.id,input,files);return savedTourResponse(saved,files);
  }
  return fail("العملية غير متاحة",405);
}
async function safe(request:Request,context:Context) {
  if(cloudEnabled())return cloudRoute(request);
  try{return await handle(request,context);}catch(error){
    if(error instanceof PrivateExampleUnavailableError)return fail(error.message,404);
    if(error instanceof DeveloperError||error instanceof FloorAssignmentError||error instanceof LeadQueryError||error instanceof AuthoredPlanCalibrationError)return fail(error.message,error.status);
    if(error instanceof SyntaxError||error instanceof Error&&error.message==="EMPTY")return fail("أرسل بيانات JSON صالحة وغير فارغة.",400);
    if(error instanceof z.ZodError)return fail(error.issues[0]?.message??"بيانات غير صالحة");
    if(error instanceof Error&&error.message==="CONFLICT")return fail("تغيرت الجولة في نافذة أخرى. أعد تحميلها قبل الحفظ.",409);
    if(error instanceof Error&&error.message==="TOO_LARGE")return fail("الملف أكبر من الحد المسموح",413);
    console.error("IMO 3D request failed",error instanceof Error?error.message:"unknown error");return fail("تعذر تنفيذ العملية. لم يتم تأكيد الحفظ، حاول مجددًا.",500);
  }
}
export {safe as GET,safe as POST,safe as PATCH};
