import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {z} from "zod";
import {isAdmin,sameOrigin} from "@/lib/imo3d/auth";
import {integrationForRequest} from "@/lib/imo3d/integrations";
import {db,getTour} from "@/lib/imo3d/store";
import {architectureSaveSchema,ArchitectureSaveError,saveArchitecture} from "@/lib/imo3d/architecture-storage";
import {servePayloadPaths} from "@/lib/imo3d/base-path";
export const runtime="nodejs";export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>Response.json(servePayloadPaths(body),{status,headers:{"Cache-Control":"private, no-store"}});
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  if(cloudEnabled())return cloudRoute(request);
  try{
    const token=integrationForRequest(request),hasToken=request.headers.has("authorization"),admin=!hasToken&&await isAdmin(request);
    if(hasToken&&!token||!admin&&!token)return json({error:"دخول الإدارة مطلوب."},401);
    if(!token&&!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
    const{id}=await params,tour=getTour(id);
    if(!tour)return json({error:"الجولة غير موجودة."},404);
    if(token&&(token.projectId!==tour.projectId||!token.scopes.includes("write")))return json({error:"الجولة خارج صلاحية المفتاح."},403);
    const reader=request.body?.getReader();if(!reader)return json({error:"المخطط فارغ."},400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>1_000_000){await reader.cancel();return json({error:"بيانات المخطط أكبر من الحد المسموح."},413);}chunks.push(value);}
    const input=architectureSaveSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return json(saveArchitecture(db(),id,input));
  }catch(error){
    if(error instanceof ArchitectureSaveError)return json({error:error.message},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:"بيانات العناصر المعمارية غير صالحة."},400);
    return json({error:"تعذر حفظ المخطط المعماري."},500);
  }
}
