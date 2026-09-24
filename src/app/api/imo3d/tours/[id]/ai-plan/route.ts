import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {isAdmin,sameOrigin} from "@/lib/imo3d/auth";
import {db,getTour} from "@/lib/imo3d/store";
import {aiPlanFingerprint,cancelAIPlanJob,enqueueAIPlan,latestAIPlanJob,recoverAIPlanJobs} from "@/lib/imo3d/ai-plan-jobs";
import {launchAIPlan} from "@/lib/imo3d/ai-plan-launcher";
import {servePayloadPaths} from "@/lib/imo3d/base-path";
export const runtime="nodejs";export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>Response.json(servePayloadPaths(body),{status,headers:{"Cache-Control":"private, no-store"}});
async function handle(request:Request,context:{params:Promise<{id:string}>}){
  if(cloudEnabled())return cloudRoute(request);
 if(request.headers.has("authorization")||!await isAdmin(request))return json({error:"دخول الإدارة مطلوب."},401);
 if(request.method!=="GET"&&!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
 const {id}=await context.params,tour=getTour(id);if(!tour)return json({error:"الجولة غير موجودة."},404);
 recoverAIPlanJobs(db());const configured=!!process.env.OPENAI_API_KEY?.trim();
 if(request.method==="DELETE")cancelAIPlanJob(db(),id);
 if(request.method==="POST"){
  if(!configured)return json({error:"أضف OPENAI_API_KEY إلى إعدادات الخادم لتفعيل GPT Image 2.5."},503);
  if(!tour.scenes.length||tour.scenes.length>100)return json({error:"أضف بين صورة واحدة و100 صورة في الجولة."},400);
  const job=enqueueAIPlan(db(),id,aiPlanFingerprint(tour.scenes));if(job.status==="queued")launchAIPlan(job.id);
 }
 const job=latestAIPlanJob(db(),id);const row=job&&db().prepare('SELECT input_hash FROM ai_plan_jobs WHERE id=?').get(job.id);
 return json({configured,job,stale:!!row&&row.input_hash!==aiPlanFingerprint(tour.scenes)});
}
export const GET=handle;export const POST=handle;export const DELETE=handle;
