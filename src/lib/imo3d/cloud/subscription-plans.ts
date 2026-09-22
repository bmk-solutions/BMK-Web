import type {Tour} from '../model';
import {aiPlanFingerprint} from '../ai-plan-jobs';
import {cloudQuery,cloudRpc,CloudError} from './client';
import {eq,json,fail} from './http';
import {cloudSameOrigin} from './auth';
export type SubscriptionJob={id:string;tour_id:string;project_id:string;input_hash:string;status:string;stage:string;error:string|null;created_at:string;draft_ids:string[]|null;lease_until:string|null;worker_id:string|null};
export const sceneSnapshot=(tour:Tour)=>tour.scenes.map(({id,image,floor})=>({id,image,floor})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
export async function subscriptionPlanStatus(tour:Tour){
 try{
  const [workers,jobs]=await Promise.all([cloudQuery<{seen_at:string}[]>('plan_workers',`id=eq.subscription&limit=1`),cloudQuery<SubscriptionJob[]>('subscription_plan_jobs',`tour_id=eq.${eq(tour.id)}&order=created_at.desc&limit=1`)]);
  const online=!!workers[0]&&Date.now()-Date.parse(workers[0].seen_at)<90000,row=jobs[0];
  const expired=row?.status==='running'&&!!row.lease_until&&Date.parse(row.lease_until)<Date.now();
  let stage=row?.stage;
  if(row?.status==='draft'&&row.draft_ids?.length){
   const ids=row.draft_ids.filter(id=>/^[0-9a-f-]{36}$/i.test(id));
   if(ids.length){
    const drafts=await cloudQuery<{layout:{rooms:{polygon:unknown[]|null}[]}|null}[]>('chatgpt_drafts',`tour_id=eq.${eq(tour.id)}&id=in.(${ids.join(',')})&select=layout:result->layout`);
    const rooms=drafts.flatMap(d=>d.layout?.rooms??[]),located=rooms.filter(r=>Array.isArray(r.polygon)&&r.polygon.length>=3).length;
    if(rooms.length&&located<rooms.length)stage=`مسودة جزئية — تم تحديد ${located} من ${rooms.length} فراغًا؛ توزيع بقية الفراغات غير محسوم`;
   }
  }
  return {configured:online,provider:'gemini-local',workerOnline:online,job:row?{id:row.id,tourId:row.tour_id,status:expired?'failed':row.status,stage:expired?'انقطع عامل المعالجة؛ أعد المحاولة.':stage,error:expired?'لم تكتمل المعالجة. النسخ السابقة محفوظة.':row.error,createdAt:row.created_at,draftIds:row.draft_ids,result:null}:null,stale:!!row&&row.input_hash!==aiPlanFingerprint(tour.scenes)};
 }catch(error){if(error instanceof CloudError&&['42P01','PGRST205'].includes(error.code))return {configured:false,provider:'gemini-local',workerOnline:false,job:null,stale:false};throw error;}
}
export async function changeSubscriptionPlan(request:Request,tour:Tour){
 if(!cloudSameOrigin(request))return fail('مصدر الطلب غير مسموح.',403);
 if(request.method==='DELETE'){
  await cloudQuery('subscription_plan_jobs',`tour_id=eq.${eq(tour.id)}&status=in.(queued,running)`,'PATCH',{status:'cancelled',stage:'أُلغيت المعالجة'});
 }else{
  if(tour.scenes.length<2||tour.scenes.length>100)return fail('أضف من صورتين إلى 100 صورة 360 للتحليل.');
  const status=await subscriptionPlanStatus(tour);
  if(!status.workerOnline)return fail('عامل Gemini على جهازك غير متصل. شغّل عامل المخططات واترك الجهاز متصلًا أثناء المعالجة.',503);
  await cloudRpc('enqueue_subscription_plan',{p_tour_id:tour.id,p_hash:aiPlanFingerprint(tour.scenes),p_scenes:sceneSnapshot(tour)});
 }
 return json(await subscriptionPlanStatus(tour));
}
