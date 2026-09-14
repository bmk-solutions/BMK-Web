import {createHash,randomBytes,randomUUID} from "node:crypto";
import {z} from "zod";
import sharp from "sharp";
import type {CloudAccess} from "./auth";
import {cloudQuery,cloudRpc,cloudSignedDownload,cloudUploadObject} from "./client";
import {getBranding,listProjects,listTours,deleteProject} from "./repository";
import {brandingPatchSchema} from "../branding-policy";
import {handleBrandUpload} from "./branding-uploads";
import {CloudHTTPError,eq,fail,json,readBytes,readJSON,signedRedirect} from "./http";
const projectSchema=z.object({name:z.string().trim().min(2).max(120),location:z.string().max(160).default(""),developerId:z.string().uuid().nullable().optional()}).strict();
export async function cloudDevelopers(){return(await cloudQuery("developers","select=id,name,created_at&order=created_at.desc,id.asc")).map(row=>({id:row.id,name:row.name,createdAt:row.created_at}));}
const keyRecord=(row:Record<string,unknown>)=>({id:row.id,name:row.name,prefix:row.prefix,scopes:row.scopes,createdAt:row.created_at,lastUsedAt:row.last_used_at??null,revokedAt:row.revoked_at??null});
export async function cloudManagement(request:Request,segments:string[],access:CloudAccess):Promise<Response|null>{
 const[resource,id,action]=segments,method=request.method;
 if((resource==="projects"||resource==="branding-assets")&&segments.length>3)return fail("المسار غير موجود.",404);
 if(resource==="developers"){
  if(!access.sessionAdmin)return fail("تسجيل دخول الإدارة مطلوب.",401);
  if(segments.length>2)return fail("المسار غير موجود.",404);
  if(method==="GET"&&!id)return json(await cloudDevelopers());
  const{name}=z.object({name:z.string().trim().min(2).max(120)}).strict().parse(await readJSON(request,2000));
  if(method==="POST"&&!id){const row={id:randomUUID(),name,created_at:new Date().toISOString()};await cloudQuery("developers","","POST",row);return json({id:row.id,name,createdAt:row.created_at},201);}
  if(method==="PATCH"&&id){const [row]=await cloudQuery("developers",`id=eq.${eq(id)}`,"PATCH",{name});return row?json({id:row.id,name:row.name,createdAt:row.created_at}):fail("المطوّر غير موجود.",404);}return fail("العملية غير متاحة.",405);
 }
 if(resource==="branding-assets"&&id&&segments.length===2&&method==="GET"){
  const[asset]=await cloudQuery("project_brand_assets",`id=eq.${eq(id)}&limit=1`);if(!asset)return fail("الشعار غير متاح.",404);
  const projectId=String(asset.project_id),[branding]=await cloudQuery("project_branding",`project_id=eq.${eq(projectId)}&logo_asset_id=eq.${eq(id)}&limit=1`);
  const readable=access.allowed(projectId)||!access.integration&&(await listTours(projectId)).some(tour=>tour.published);
  if(!branding||!readable)return fail("الشعار غير متاح.",404);return signedRedirect(await cloudSignedDownload(String(asset.storage_key)));
 }
 if(resource!=="projects"||!id)return null;
 const project=(await listProjects()).find(project=>project.id===id);if(!project)return fail("المشروع غير موجود.",404);
 if(action==="branding-init"||action==="branding-finalize"){if(!access.allowed(id,"write"))return fail("المشروع خارج صلاحية الكتابة.",access.integration?403:401);return handleBrandUpload(request,id);}
 if(action==="branding"){
  if(method==="GET"){const readable=access.allowed(id)||!access.integration&&(await listTours(id)).some(tour=>tour.published);return readable?json(await getBranding(id)):fail("المشروع غير متاح.",404);}
  if(!access.allowed(id,"write"))return fail("المشروع خارج صلاحية الكتابة.",access.integration?403:401);
  const[old]=await cloudQuery("project_branding",`project_id=eq.${eq(id)}&limit=1`);let logoId=old?.logo_asset_id??null;let input:z.infer<typeof brandingPatchSchema>;
  if(method==="PATCH")input=brandingPatchSchema.parse(await readJSON(request));
  else if(method==="POST"){
   // Binary uploads must fit the serverless request envelope. Panoramas use the separate direct signed-upload endpoint.
   const bytes=await readBytes(request,4*1024*1024),form=await new Response(bytes,{headers:{"Content-Type":request.headers.get("content-type")??""}}).formData();
   input=brandingPatchSchema.parse({name:form.get("name"),accent:form.get("accent"),logoStyle:form.get("logoStyle")??undefined});
   const file=form.get("file");if(!(file instanceof File)||!file.size)throw new CloudHTTPError("اختر صورة شعار.");
   const source=Buffer.from(await file.arrayBuffer());let output:Buffer;
   try{const image=sharp(source,{limitInputPixels:16_777_216,animated:false}),metadata=await image.metadata();if(!["png","jpeg","webp"].includes(metadata.format??"")||!metadata.width||!metadata.height||(metadata.pages??1)>1)throw Error("INVALID_LOGO");output=await image.rotate().resize({width:1024,height:1024,fit:"inside",withoutEnlargement:true}).webp({quality:90,alphaQuality:100}).toBuffer();}catch{throw new CloudHTTPError("اختر شعارًا ثابتًا صالحًا بصيغة PNG أو JPG أو WEBP.",415);}
   logoId=randomUUID();const storageKey=`branding/${id}/${logoId}.webp`;await cloudUploadObject(storageKey,output,"image/webp");await cloudQuery("project_brand_assets","","POST",{id:logoId,project_id:id,mime:"image/webp",storage_key:storageKey,byte_size:output.byteLength,sha256:createHash("sha256").update(output).digest("hex"),created_at:new Date().toISOString()});
  }else return fail("العملية غير متاحة.",405);
  if(input.removeLogo)logoId=null;
  const row={project_id:id,name:input.name,accent:input.accent,logo_asset_id:logoId,logo_style:input.logoStyle??old?.logo_style??"clean",updated_at:new Date().toISOString()};
  await cloudQuery("project_branding",old?`project_id=eq.${eq(id)}`:"",old?"PATCH":"POST",row);return json(await getBranding(id));
 }
 if(action==="keys"){
  if(!access.sessionAdmin)return fail("إدارة مفاتيح التكامل تتطلب جلسة الاستوديو.",access.integration?403:401);
  if(method==="GET")return json((await cloudQuery("integration_keys",`project_id=eq.${eq(id)}&order=created_at.desc`)).map(keyRecord));
  if(method==="POST"){
   const input=z.object({name:z.string().trim().min(1).max(80),scopes:z.array(z.enum(["read","write","leads"])).min(1).max(3)}).parse(await readJSON(request));
   const secret=`imo3d_${randomBytes(32).toString("base64url")}`,row={id:randomUUID(),project_id:id,name:input.name,prefix:secret.slice(0,13),scopes:[...new Set(input.scopes)],secret_hash:createHash("sha256").update(secret).digest("hex"),created_at:new Date().toISOString(),last_used_at:null,revoked_at:null};await cloudQuery("integration_keys","","POST",row);return json({key:keyRecord(row),secret},201);
  }
  if(method==="DELETE"){const input=z.object({id:z.string().uuid()}).parse(await readJSON(request));const rows=await cloudQuery("integration_keys",`id=eq.${eq(input.id)}&project_id=eq.${eq(id)}`,"PATCH",{revoked_at:new Date().toISOString()});return rows.length?json({ok:true}):fail("المفتاح غير موجود في هذا المشروع.",404);}return fail("العملية غير متاحة.",405);
 }
 if(action==="usage"&&method==="GET"){
  if(!access.allowed(id))return fail("المشروع خارج صلاحية القراءة.",access.integration?403:401);
  const tours=await listTours(id),tourIds=tours.map(tour=>tour.id);let files:Record<string,unknown>[]=[];let jobs:Record<string,unknown>[]=[];
  if(tourIds.length){const filter=`tour_id=in.(${tourIds.map(eq).join(",")})`;files=[...await cloudQuery("assets",filter),...await cloudQuery("scene_originals",filter)];jobs=await cloudQuery("processing_jobs",filter);}
  const brands=await cloudQuery("project_brand_assets",`project_id=eq.${eq(id)}`),byKey=new Map(files.map(file=>[file.storage_key,file]));
  const fileBytes=[...byKey.values()].reduce((sum,file)=>sum+Number(file.byte_size??0),0),brandingBytes=brands.reduce((sum,file)=>sum+Number(file.byte_size??0),0);
  const statuses:Record<string,number>={},processing={jobs:jobs.length,statuses,elapsedSeconds:0,elapsedBasis:"created-to-last-update",timedJobs:0,unknownDurationJobs:0};
  for(const job of jobs){const status=String(job.status);statuses[status]=(statuses[status]??0)+1;if(status==="queued"||status==="running")continue;const elapsed=Date.parse(String(job.updated_at))-Date.parse(String(job.created_at));if(Number.isFinite(elapsed)&&elapsed>=0){processing.elapsedSeconds+=elapsed/1000;processing.timedJobs++;}else processing.unknownDurationJobs++;}
  return json({projectId:id,measuredAt:new Date().toISOString(),storage:{bytes:fileBytes+brandingBytes,fileBytes,brandingBytes,files:byKey.size,missingFiles:0,unreadableFiles:0,measurementBasis:"stored-object-metadata"},processing,transfer:{bytes:null}});
 }
 if(action||segments.length!==2)return null;
 if(method==="GET")return access.allowed(id)?json(project):fail("المشروع خارج صلاحية القراءة.",access.integration?403:401);
 if(!access.sessionAdmin)return fail("تعديل المشروع وحذفه يتطلبان جلسة إدارة الاستوديو.",access.integration?403:401);
 if(method==="PATCH"){const input=projectSchema.parse(await readJSON(request,2000));return json(await cloudRpc("edit_project",{p_project_id:id,p_name:input.name,p_location:input.location,p_developer_id:input.developerId??null,p_assign_developer:input.developerId!==undefined}));}
 if(method==="DELETE"){const{confirmationName}=z.object({confirmationName:z.string().min(2).max(120)}).strict().parse(await readJSON(request,2000));if(confirmationName!==project.name)throw new CloudHTTPError("اكتب اسم المشروع المطابق لتأكيد الحذف.",409);await deleteProject(id);return json({ok:true});}
 return fail("العملية غير متاحة.",405);
}
