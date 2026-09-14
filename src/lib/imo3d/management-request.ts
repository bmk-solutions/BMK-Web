import { DeveloperError } from "./developer-management";
import { z } from "zod";
import { ManagementError } from "./project-management";

export const managementJSON=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
export async function readManagementJSON(request:Request){
  if(Number(request.headers.get("content-length"))>2000)throw new Error("INVALID_INPUT");
  const reader=request.body?.getReader();if(!reader)throw new Error("INVALID_INPUT");
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>2000){await reader.cancel();throw new Error("INVALID_INPUT");}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("INVALID_INPUT");}
}
export function managementFailure(error:unknown){
  if(error instanceof ManagementError||error instanceof DeveloperError)return managementJSON({error:error.message},error.status);
  if(error instanceof z.ZodError)return managementJSON({error:error.issues[0]?.message??"البيانات غير صالحة."},400);
  if(error instanceof Error&&error.message==="INVALID_INPUT")return managementJSON({error:"أرسل بيانات JSON صالحة لا تزيد على 2000 بايت."},400);
  console.error("IMO 3D management failed",error instanceof Error?error.message:"unknown error");
  return managementJSON({error:"تعذر تنفيذ العملية. أعد تحميل البيانات قبل المحاولة مجددًا."},500);
}
