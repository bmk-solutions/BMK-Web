import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { z } from "zod";
import { GET as readTour,PATCH as updateTour } from "../../[...path]/route";
import { isAdmin,sameOrigin } from "@/lib/imo3d/auth";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import { dataDirectory,db,getTour } from "@/lib/imo3d/store";
import { removeTour } from "@/lib/imo3d/project-management";
import { managementFailure,managementJSON as json,readManagementJSON } from "@/lib/imo3d/management-request";
import { cleanupPrivateAssetFiles } from "@/lib/imo3d/private-asset-cleanup";
import { cleanupProcessingArtifacts } from "@/lib/imo3d/processing-cleanup";

export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){
  if(cloudEnabled())return cloudRoute(request);
  const {id}=await context.params;return readTour(request,{params:Promise.resolve({path:["tours",id]})});
}
export async function PATCH(request:Request,context:Context){
  if(cloudEnabled())return cloudRoute(request);
  const {id}=await context.params;return updateTour(request,{params:Promise.resolve({path:["tours",id]})});
}
export async function DELETE(request:Request,context:Context){
  if(cloudEnabled())return cloudRoute(request);
  try{
    const integration=integrationForRequest(request),hasAuthorization=request.headers.has("authorization");
    if(hasAuthorization&&!integration)return json({error:"مفتاح API غير صالح أو أُلغي."},401);
    const admin=!hasAuthorization&&isAdmin(request);
    if(!admin&&!integration)return json({error:"تسجيل دخول الإدارة مطلوب."},401);
    if(!integration&&!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
    const {id}=await context.params,tour=getTour(id);
    if(!tour)return json({error:"الجولة غير موجودة."},404);
    if(integration&&(integration.projectId!==tour.projectId||!integration.scopes.includes("write")))return json({error:"الجولة خارج صلاحية الكتابة لمفتاح API."},403);
    const input=z.object({revision:z.number().int().min(0)}).strict().parse(await readManagementJSON(request));
    const removed=removeTour(db(),id,input.revision);
    const [cleanup,processing]=await Promise.all([
      cleanupPrivateAssetFiles(dataDirectory(),removed.files),
      cleanupProcessingArtifacts(dataDirectory(),removed.jobIds),
    ]);
    return json({ok:true,...(cleanup.failed.length||processing.skipped.length||processing.failed.length?{cleanupWarning:"حُذفت الجولة. تعذّر تنظيف بعض ملفات التخزين الخاصة؛ يلزم إعادة محاولة تنظيفها على الخادم."}:{})});
  }catch(error){return managementFailure(error);}
}
