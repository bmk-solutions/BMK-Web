import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { z } from "zod";
import { isAdmin,sameOrigin } from "@/lib/imo3d/auth";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import { dataDirectory,db } from "@/lib/imo3d/store";
import { editProject,readProject,removeProject } from "@/lib/imo3d/project-management";
import { managementFailure,managementJSON as json,readManagementJSON } from "@/lib/imo3d/management-request";
import { cleanupPrivateAssetFiles } from "@/lib/imo3d/private-asset-cleanup";
import { cleanupProcessingArtifacts } from "@/lib/imo3d/processing-cleanup";

export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
async function handle(request:Request,context:Context){
  if(cloudEnabled())return cloudRoute(request);
  const {id}=await context.params;
  const integration=integrationForRequest(request),hasAuthorization=request.headers.has("authorization");
  if(hasAuthorization&&!integration)return json({error:"مفتاح API غير صالح أو أُلغي."},401);
  const admin=!hasAuthorization&&isAdmin(request);
  if(request.method==="GET"){
    if(!admin&&!integration)return json({error:"تسجيل دخول الإدارة مطلوب."},401);
    if(integration&&(integration.projectId!==id||!integration.scopes.includes("read")))return json({error:"المشروع خارج صلاحية مفتاح API."},403);
    const project=readProject(db(),id);return project?json(project):json({error:"المشروع غير موجود."},404);
  }
  if(integration)return json({error:"تعديل المشروع وحذفه يتطلبان جلسة إدارة الاستوديو."},403);
  if(!admin)return json({error:"تسجيل دخول الإدارة مطلوب."},401);
  if(!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
  const body=await readManagementJSON(request);
  if(request.method==="PATCH"){
    const input=z.object({name:z.string().trim().min(2,"أدخل اسم مشروع من حرفين على الأقل.").max(120),location:z.string().max(160).default(""),developerId:z.string().uuid().nullable().optional()}).strict().parse(body);
    return json(editProject(db(),id,input));
  }
  const input=z.object({confirmationName:z.string().min(2).max(120)}).strict().parse(body);
  const removed=removeProject(db(),id,input.confirmationName);
  const [cleanup,processing]=await Promise.all([
    cleanupPrivateAssetFiles(dataDirectory(),removed.files),
    cleanupProcessingArtifacts(dataDirectory(),removed.jobIds),
  ]);
  return json({ok:true,...(cleanup.failed.length||processing.skipped.length||processing.failed.length?{cleanupWarning:"حُذف المشروع. تعذّر تنظيف بعض ملفات التخزين الخاصة؛ يلزم إعادة محاولة تنظيفها على الخادم."}:{})});
}
async function safe(request:Request,context:Context){
  if(cloudEnabled())return cloudRoute(request);try{return await handle(request,context);}catch(error){return managementFailure(error);}}
export {safe as GET,safe as PATCH,safe as DELETE};
