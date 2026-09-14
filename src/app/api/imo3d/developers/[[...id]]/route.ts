import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {z} from "zod";
import {isAdmin,sameOrigin} from "@/lib/imo3d/auth";
import {db} from "@/lib/imo3d/store";
import {listDevelopers,createDeveloper,renameDeveloper} from "@/lib/imo3d/developer-management";
import {managementJSON as json,managementFailure,readManagementJSON} from "@/lib/imo3d/management-request";
export const runtime="nodejs";
export const dynamic="force-dynamic";
async function handle(request:Request,context:{params:Promise<{id?:string[]}>}){
  if(cloudEnabled())return cloudRoute(request);
 try{
 if(request.headers.has("authorization")||!isAdmin(request))return json({error:"تسجيل دخول الإدارة مطلوب."},401);
 const ids=(await context.params).id??[];
 if(ids.length>1)return json({error:"المسار غير موجود."},404);
 if(request.method==="GET"&&!ids.length)return json(listDevelopers(db()));
 if(!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
 const {name}=z.object({name:z.string().trim().min(2).max(120)}).strict().parse(await readManagementJSON(request));
 if(request.method==="POST"&&!ids.length)return json(createDeveloper(db(),name),201);
 if(request.method==="PATCH"&&ids.length===1)return json(renameDeveloper(db(),ids[0],name));
 return json({error:"العملية غير متاحة."},405);
 }catch(error){return managementFailure(error);}
}
export {handle as GET,handle as POST,handle as PATCH};
