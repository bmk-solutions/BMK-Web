import {z} from "zod";
export class CloudHTTPError extends Error{constructor(message:string,readonly status=400){super(message);}}
export const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
export const fail=(message:string,status=400)=>json({error:message},status);
export const eq=(value:string)=>encodeURIComponent(value);
export async function readBytes(request:Request,max:number){
 if(Number(request.headers.get("content-length"))>max)throw new CloudHTTPError("البيانات أكبر من الحد المسموح.",413);
 const reader=request.body?.getReader();if(!reader)throw new CloudHTTPError("البيانات المرسلة فارغة.");
 const chunks:Uint8Array[]=[];let size=0;while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new CloudHTTPError("البيانات أكبر من الحد المسموح.",413);}chunks.push(value);}return Buffer.concat(chunks);
}
export async function readJSON(request:Request,max=4000){return JSON.parse((await readBytes(request,max)).toString("utf8")) as unknown;}
export function cloudFailure(error:unknown){
 if(error instanceof z.ZodError)return fail(error.issues[0]?.message||"بيانات غير صالحة.");
 if(error instanceof SyntaxError)return fail("أرسل بيانات JSON صالحة.");
 if(error instanceof Error&&"status" in error&&error.status===409)return fail("تغيّرت البيانات. أعد تحميل أحدث نسخة قبل الحفظ.",409);
 if(error instanceof Error&&"status" in error&&typeof error.status==="number"&&error.status>=400&&error.status<500&&error.name!=="CloudError")return fail(error.message,error.status);
 const code=error instanceof Error?error.message:"";
 if(/CONFLICT|STALE|revision|23505/i.test(code))return fail("تغيّرت البيانات. أعد تحميل أحدث نسخة قبل الحفظ.",409);
 if(/NOT_FOUND/i.test(code))return fail("البيانات غير موجودة.",404);
 console.error("IMO3D cloud operation failed",error instanceof Error?error.name:"unknown");return fail("تعذر تأكيد العملية. أعد تحميل البيانات قبل المحاولة مجددًا.",500);
}
export function signedRedirect(url:string){return new Response(null,{status:307,headers:{Location:url,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});}
