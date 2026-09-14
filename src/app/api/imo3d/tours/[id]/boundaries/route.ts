import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {z} from "zod";
import {isAdmin,sameOrigin} from "@/lib/imo3d/auth";
import {integrationForRequest} from "@/lib/imo3d/integrations";
import {db,getTour,dataDirectory} from "@/lib/imo3d/store";
import {boundarySchema,BoundaryError,saveFloorBoundaries} from "@/lib/imo3d/floor-boundaries";
import {cleanupPrivateAssetFiles} from "@/lib/imo3d/private-asset-cleanup";
export const runtime="nodejs";export const dynamic="force-dynamic";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  if(cloudEnabled())return cloudRoute(request);
  try{const auth=integrationForRequest(request),hasAuth=request.headers.has("authorization"),admin=!hasAuth&&isAdmin(request);
    if(hasAuth&&!auth)return json({error:"مفتاح API غير صالح."},401);if(!admin&&!auth)return json({error:"دخول الإدارة مطلوب."},401);
    if(!auth&&!sameOrigin(request))return json({error:"المصدر غير مسموح."},403);
    const{id}=await params,tour=getTour(id);if(!tour)return json({error:"الجولة غير موجودة."},404);if(auth&&(auth.projectId!==tour.projectId||!auth.scopes.includes("write")))return json({error:"الجولة خارج صلاحية المفتاح."},403);
    const reader=request.body?.getReader();if(!reader)throw new BoundaryError("بيانات المخطط فارغة.");const chunks:Uint8Array[]=[];let bytes=0;
    while(true){const{value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>600000){await reader.cancel();return json({error:"بيانات المخطط تتجاوز الحد المسموح."},413);}chunks.push(value);}
    const input=boundarySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),files:string[]=[];
    const saved=saveFloorBoundaries(db(),id,input,files),cleanup=await cleanupPrivateAssetFiles(dataDirectory(),files);
    return json({...saved,...(cleanup.failed.length?{cleanupWarning:"حُفظ المخطط، لكن تعذر تنظيف بعض ملفات النموذج السابق من التخزين. تحتاج هذه الملفات إلى تنظيف لاحق."}:{})});
  }catch(error){if(error instanceof BoundaryError)return json({error:error.message},error.status);if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:"أدخل حدود غرف صالحة ثم أعد الحفظ."},400);return json({error:"تعذر حفظ المخطط."},500);}
}
