import {createHash,randomUUID} from "node:crypto";
import sharp from "sharp";
import {z} from "zod";
import {cloudConfig,cloudObjectPath,cloudQuery,cloudRpc,cloudSignedUpload,cloudUploadObject} from "./client";
import {getBranding} from "./repository";
import {brandingPatchSchema} from "../branding-policy";
import {CloudHTTPError,eq,fail,json,readJSON} from "./http";
export const MAX_LOGO_BYTES=5*1024*1024;
export const logoInitSchema=brandingPatchSchema.omit({removeLogo:true}).extend({size:z.number().int().min(1).max(MAX_LOGO_BYTES),type:z.enum(["image/png","image/jpeg","image/webp"])}).strict();
const finalizeSchema=z.object({uploadId:z.string().uuid()}).strict();
type BrandSession={id:string;project_id:string;size:number;mime:string;object_key:string;status:string};
async function logoBytes(session:BrandSession){
 const config=cloudConfig(),response=await fetch(`${config.url}/storage/v1/object/authenticated/${config.bucket}/${cloudObjectPath(session.object_key)}`,{cache:"no-store",headers:{apikey:config.serviceRoleKey,Authorization:`Bearer ${config.serviceRoleKey}`},signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new CloudHTTPError("لم يكتمل رفع الشعار بعد.",409);
 if(Number(response.headers.get("content-length"))>MAX_LOGO_BYTES)throw new CloudHTTPError("حجم الشعار يتجاوز 5 ميجابايت.",413);
 const reader=response.body?.getReader();if(!reader)throw new CloudHTTPError("ملف الشعار فارغ.");const chunks:Uint8Array[]=[];let total=0;
 while(true){const{value,done}=await reader.read();if(done)break;total+=value.length;if(total>session.size||total>MAX_LOGO_BYTES){await reader.cancel();throw new CloudHTTPError("حجم الشعار المرفوع غير صالح.",413);}chunks.push(value);}
 if(total!==session.size)throw new CloudHTTPError("ملف الشعار غير مكتمل.",422);return Buffer.concat(chunks);
}
/** Project authorization and same-origin checks are enforced by the calling router. */
export async function handleBrandUpload(request:Request,projectId:string){
 if(request.method!=="POST")return fail("العملية غير متاحة.",405);
 const action=new URL(request.url).pathname.split("/").pop();
 if(action==="branding-init"){
  const input=logoInitSchema.parse(await readJSON(request)),id=randomUUID(),objectKey=`branding-uploads/${projectId}/${id}/original`;
  await cloudRpc("begin_brand_upload",{p_id:id,p_project_id:projectId,p_size:input.size,p_mime:input.type,p_object_key:objectKey,p_name:input.name,p_accent:input.accent,p_logo_style:input.logoStyle??"clean"});
  const signed=await cloudSignedUpload(objectKey),config=cloudConfig(),storageHost=new URL(config.url).hostname.replace(".supabase.co",".storage.supabase.co");
  return json({uploadId:id,url:signed.url,token:signed.token,bucket:config.bucket,objectKey,endpoint:`https://${storageHost}/storage/v1/upload/resumable/sign`,expiresIn:7200},201);
 }
 const {uploadId}=finalizeSchema.parse(await readJSON(request));const[session]=await cloudQuery<BrandSession[]>("brand_upload_sessions",`id=eq.${eq(uploadId)}&project_id=eq.${eq(projectId)}&limit=1`);
 if(!session)return fail("جلسة رفع الشعار غير موجودة.",404);if(session.status==="completed")return json(await getBranding(projectId));
 const lease=randomUUID();await cloudRpc("claim_brand_upload",{p_id:uploadId,p_project_id:projectId,p_lease:lease});
 try{
  const bytes=await logoBytes(session);let output:Buffer;
  try{const image=sharp(bytes,{limitInputPixels:16_777_216,animated:false}),meta=await image.metadata();if(!["png","jpeg","webp"].includes(meta.format??"")||!meta.width||!meta.height||(meta.pages??1)>1)throw Error("INVALID_LOGO");output=await image.rotate().resize({width:1024,height:1024,fit:"inside",withoutEnlargement:true}).webp({quality:90,alphaQuality:100}).toBuffer();}catch{throw new CloudHTTPError("اختر شعارًا ثابتًا صالحًا بصيغة PNG أو JPG أو WEBP.",415);}
  const id=randomUUID(),storageKey=`branding/${projectId}/${id}.webp`;await cloudUploadObject(storageKey,output,"image/webp");
  await cloudRpc("commit_brand_upload",{p_id:uploadId,p_project_id:projectId,p_lease:lease,p_asset:{id,mime:"image/webp",storage_key:storageKey,byte_size:output.byteLength,sha256:createHash("sha256").update(output).digest("hex")}});
  return json(await getBranding(projectId));
 }catch(error){await cloudRpc("release_brand_upload",{p_id:uploadId,p_lease:lease}).catch(()=>{});throw error;}
}

