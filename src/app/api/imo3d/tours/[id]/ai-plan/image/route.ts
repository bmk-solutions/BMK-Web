import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import {readFile} from "node:fs/promises";
import {isAdmin} from "@/lib/imo3d/auth";
import {db,getTour,dataDirectory} from "@/lib/imo3d/store";
import {aiPlanFingerprint,ensureAIPlanTables} from "@/lib/imo3d/ai-plan-jobs";
const path:typeof import("node:path")=process.getBuiltinModule("node:path");
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  if(cloudEnabled())return cloudRoute(request);
 if(request.headers.has("authorization")||!await isAdmin(request))return new Response(null,{status:401});
 const {id}=await params,url=new URL(request.url),jobId=url.searchParams.get('job'),floor=Number(url.searchParams.get('floor'));
 if(!jobId||!Number.isInteger(floor))return new Response(null,{status:400});
 ensureAIPlanTables(db());const row=db().prepare("SELECT * FROM ai_plan_jobs WHERE id=? AND tour_id=? AND status='draft'").get(jobId,id),tour=getTour(id);
 if(!row||!tour||row.input_hash!==aiPlanFingerprint(tour.scenes))return new Response(null,{status:404});
 const result=JSON.parse(String(row.result)),item=result.floors.find((item:{floor:number})=>item.floor===floor);if(!item)return new Response(null,{status:404});
 const root=path.resolve(dataDirectory(),'ai-plans',String(row.id)),file=path.resolve(item.imagePath),relative=path.relative(root,file);
 if(relative.startsWith('..')||path.isAbsolute(relative)||!file.endsWith('.png'))return new Response(null,{status:404});
 try{return new Response(await readFile(file),{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch{return new Response(null,{status:404});}
}
