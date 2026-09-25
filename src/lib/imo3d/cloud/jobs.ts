import {z} from "zod";
import {processingSourceSchema} from "../processing-model";
import {changeSubscriptionPlan,photosEngineState,subscriptionPlanStatus,sceneSnapshot,type SubscriptionJob} from './subscription-plans';
import type {Tour,Lead} from "../model";
import type {CloudAccess} from "./auth";
import type {CloudJob} from "./types";
import {aiPlanFingerprint} from "../ai-plan-jobs";
import {imageFingerprint} from "../processing-jobs";
import {cloudDownloadObject,cloudQuery,cloudRpc,cloudSignedDownload} from "./client";
import {planImageVariant,planImageVariantOf} from "../image-variants";
import {getPlanRefs,latestAIPlan} from "./repository";
import {eq,fail,json,signedRedirect,CloudHTTPError} from "./http";
const point=z.object({x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)});
const navigation=z.object({width:z.number().positive().max(20000),height:z.number().positive().max(20000),outline:z.array(point).min(3).max(200).optional(),source:z.literal("reviewed-photo-registration"),points:z.array(point.extend({sceneId:z.string()})).max(500)});
const floor=z.object({floor:z.number(),sceneIds:z.array(z.string()),navigation:navigation.optional(),audit:z.object({verdict:z.string(),issues:z.array(z.string()),limitations:z.array(z.string())})});
const planResult=z.object({source:z.string().optional(),floors:z.array(floor),limitations:z.array(z.string()),sceneCount:z.number()});
const processingResult=z.object({registered:z.number(),total:z.number(),links:z.number(),components:z.number(),scale:z.enum(["relative","metric"]),analyzedPhotos:z.number().int().min(0).max(500).optional(),analyzedSceneIds:z.array(z.string().regex(/^[\w-]+$/).max(80)).max(500).optional(),analyzedSources:z.array(processingSourceSchema).max(500).optional(),positionedLocalPhotos:z.number().int().min(0).max(500).optional(),independentFrames:z.number().int().min(0).max(500).optional(),unmatchedPhotos:z.number().int().min(0).max(500).optional(),boundaryPhotos:z.number().optional(),recognizedPhotos:z.number().optional(),rooms:z.number().optional(),jointDepthPhotos:z.number().optional(),jointPoints:z.number().optional()});
export function publicProcessingJob(row:CloudJob|null,photosEngine?:"online"|"offline"|"unknown"){if(!row)return null;const result=processingResult.safeParse(row.result);return{id:row.id,tourId:row.tour_id,status:row.status,progress:row.progress,stage:row.stage,createdAt:row.created_at,updatedAt:row.updated_at,error:row.error,warnings:row.warnings??[],...(photosEngine?{photosEngine}:{}),...(result.success?{result:result.data}:{})};}
export async function cloudProcessing(request:Request,tour:Tour,action:string){
 if(action==="processing-cancel"&&request.method==="POST"){
  const row=await cloudRpc<CloudJob|null>("cancel_tour_workflow",{p_tour_id:tour.id});
  return json(publicProcessingJob(row));
 }
 if(action!=="processing")return null;
 if(request.method==="POST"){
  if(tour.scenes.length<2||tour.scenes.length>300)return fail("ارفع من صورتين إلى 300 صورة متداخلة للمعالجة التلقائية.",422);
  const inputHash=imageFingerprint(tour.scenes),planHash=aiPlanFingerprint(tour.scenes),snapshot=sceneSnapshot(tour);
  const [photoJobs,planJobs]=await Promise.all([
   cloudQuery<CloudJob[]>("processing_jobs",`tour_id=eq.${eq(tour.id)}&status=in.(queued,running)&limit=1`),
   cloudQuery<SubscriptionJob[]>("subscription_plan_jobs",`tour_id=eq.${eq(tour.id)}&status=in.(queued,running)&limit=1`),
  ]);
  const photoJob=photoJobs[0];let planJob:SubscriptionJob|undefined=planJobs[0];
  if(planJob?.status==='running'&&planJob.lease_until&&Date.parse(planJob.lease_until)<Date.now())planJob=undefined;
  if(planJob&&planJob.input_hash!==planHash){
   // A new upload invalidates only the old-source plan. Its lease stops that
   // worker; an unrelated/newer job can never match this conditional update.
   await cloudQuery('subscription_plan_jobs',`id=eq.${eq(planJob.id)}&tour_id=eq.${eq(tour.id)}&input_hash=eq.${eq(planJob.input_hash)}&status=in.(queued,running)`,'PATCH',{status:'stale',stage:'تغيّرت الصور؛ تبدأ معالجة الصور الحالية تلقائيًا'});
   planJob=undefined;
  }
  if(planJob&&!photoJob)return fail('المخطط الحالي قيد المعالجة. انتظر اكتماله أو أوقفه قبل إعادة تحليل مواقع الصور.',409);
  if(photoJob&&photoJob.input_hash!==inputHash)return fail('تغيّرت بيانات الجولة أثناء المعالجة. أوقف العملية الحالية ثم أعد تحليل الصور.',409);
  const row=await cloudRpc<CloudJob>("start_tour_workflow",{p_tour_id:tour.id,p_input_hash:inputHash,p_plan_hash:planHash,p_scenes:snapshot});
  // The original transaction may reuse an old draft with these photos. A
  // requested rerun must also retry its plan; this RPC reuses an active job.
  if(tour.scenes.length<=100)await cloudRpc('enqueue_subscription_plan',{p_tour_id:tour.id,p_hash:planHash,p_scenes:snapshot});
  return json(publicProcessingJob(row),202);
 }
 if(request.method==="GET"){const rows=await cloudQuery<CloudJob[]>("processing_jobs",`tour_id=eq.${eq(tour.id)}&order=created_at.desc,id.desc&limit=1`),row=rows[0]??null;return json(publicProcessingJob(row,row?.status==="queued"?await photosEngineState():undefined));}
 return fail("العملية غير متاحة.",405);
}
export async function cloudAIPlan(request:Request,tour:Tour,action:string|undefined,access:CloudAccess){
 const hash=aiPlanFingerprint(tour.scenes),readable=access.allowed(tour.projectId)||!access.integration&&tour.published;
 if(!readable)return fail("الجولة غير متاحة.",404);
 if(action==="image"){
  if(request.method!=="GET")return fail("العملية غير متاحة.",405);
  const url=new URL(request.url),job=url.searchParams.get("job"),floorNumber=Number(url.searchParams.get("floor"));
  if(!job||!Number.isInteger(floorNumber)||!url.searchParams.has("floor"))return fail("معرّف المخطط غير صالح.");
  const reference=(await getPlanRefs(tour.id)).find(ref=>ref.job_id===job&&ref.floor===floorNumber&&ref.input_hash===hash);
  if(!reference)return fail("المخطط غير متاح لهذه الصور.",404);
  const variant=planImageVariantOf(url.searchParams.get("variant"));
  if(!variant)return signedRedirect(await cloudSignedDownload(reference.storage_key));
  // The viewer shows WebP (and a ≤600 px copy in the compact map); the stored PNG is untouched.
  const bytes=await planImageVariant(await cloudDownloadObject(reference.storage_key),variant);
  return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"image/webp","Content-Length":String(bytes.byteLength),"Cache-Control":tour.published?"public, max-age=3600, s-maxage=86400":"private, no-store","X-Content-Type-Options":"nosniff"}});
 }
 if(request.method!=="GET"){
  if(!access.sessionAdmin)return fail("دخول الإدارة مطلوب.",401);
  if(request.method==="POST")return changeSubscriptionPlan(request,tour);
  if(request.method!=="DELETE")return fail("العملية غير متاحة.",405);
  return changeSubscriptionPlan(request,tour);
 }
 if(access.sessionAdmin&&new URL(request.url).searchParams.get('viewer')!=='1'){const subscription=await subscriptionPlanStatus(tour);if(subscription.job)return json(subscription);const row=await latestAIPlan(tour.id),parsed=planResult.safeParse(row?.result);return json({...subscription,job:row?{id:row.id,tourId:row.tour_id,status:row.status,progress:row.progress,stage:row.stage,error:row.error,result:parsed.success?parsed.data:null,createdAt:row.created_at}:null,stale:!!row&&row.input_hash!==hash});}
 // Published clients see only the explicitly registered floor images, never private job payloads.
 const refs=(await getPlanRefs(tour.id)).filter(ref=>ref.input_hash===hash);
 if(!refs.length)return json({configured:false,job:null,stale:false});
 const requestedFloor=new URL(request.url).searchParams.get('floor');
 const jobId=(requestedFloor!==null?refs.find(ref=>ref.floor===Number(requestedFloor)):undefined)?.job_id??refs[0].job_id,items=refs.filter(ref=>ref.job_id===jobId).map(ref=>{const parsed=navigation.safeParse(ref.navigation);return{floor:ref.floor,sceneIds:ref.scene_ids,...(parsed.success?{navigation:parsed.data}:{}),audit:{verdict:"draft",issues:[],limitations:[]}};});
 return json({configured:false,job:{id:jobId,tourId:tour.id,status:"draft",progress:1,stage:"مخطط الجولة",error:null,createdAt:tour.updatedAt,result:{floors:items,limitations:[],sceneCount:tour.scenes.length}},stale:false});
}
export async function cloudLeadsPage(options:{projectId?:string;cursor?:string;limit?:number}){
 const limit=options.limit??100;if(!Number.isInteger(limit)||limit<1||limit>1000)throw new CloudHTTPError("حجم صفحة الطلبات يجب أن يكون بين 1 و1000.");
 if(options.projectId&&!/^[\w-]{1,80}$/.test(options.projectId))throw new CloudHTTPError("معرّف المشروع غير صالح.");
 let cursor:{createdAt:string;id:string;projectId:string|null}|undefined;
 if(options.cursor){try{if(options.cursor.length>1000||!/^[\w-]+$/.test(options.cursor))throw Error();const value=JSON.parse(Buffer.from(options.cursor,"base64url").toString("utf8"));cursor=z.object({createdAt:z.string().max(80).refine(value=>Number.isFinite(Date.parse(value))),id:z.string().regex(/^[\w-]{1,80}$/),projectId:z.string().nullable()}).parse(value);if(cursor.projectId!==(options.projectId??null))throw Error();}catch{throw new CloudHTTPError("مؤشر الصفحة غير صالح لهذا المشروع. أعد تحميل الطلبات.");}}
 const page=await cloudRpc<{leads:(Lead&{projectId:string;projectName:string;tourTitle:string})[];total:number;hasMore:boolean}>("list_leads",{p_project_id:options.projectId??null,p_cursor_created_at:cursor?.createdAt??null,p_cursor_id:cursor?.id??null,p_limit:limit});
 const last=page.leads.at(-1);return{leads:page.leads,total:page.total,nextCursor:page.hasMore&&last?Buffer.from(JSON.stringify({createdAt:last.createdAt,id:last.id,projectId:options.projectId??null})).toString("base64url"):null};
}
