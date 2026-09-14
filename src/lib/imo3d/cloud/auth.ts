import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {cloudQuery} from "./client";
import {withinRateLimit} from "./repository";
export type CloudScope="read"|"write"|"leads";
export type CloudAccess={sessionAdmin:boolean;integration:{id:string;projectId:string;scopes:CloudScope[]}|null;allowed:(projectId:string,scope?:CloudScope)=>boolean};
export const secureEqual=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function cloudIsAdmin(request:Request){
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32)return false;
  const cookie=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("imo3d_session="))?.slice(14);
  const match=/^(\d{13})\.([a-f0-9]{64})$/.exec(cookie??"");if(!match||Number(match[1])<Date.now()||Number(match[1])>Date.now()+8*60*60_000)return false;
  return secureEqual(match[2],createHmac("sha256",secret).update(match[1]).digest("hex"));
}
export function cloudSameOrigin(request:Request){
  const origin=request.headers.get("origin");if(!origin||request.headers.get("sec-fetch-site")==="cross-site")return false;
  try{return new URL(origin).origin===new URL(process.env.IMO3D_PUBLIC_ORIGIN||request.url).origin;}catch{return false;}
}
export async function cloudLogin(request:Request,password:string){
  if(!await withinRateLimit("login",15,5*60_000))return null;
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32||!secureEqual(password,secret))return null;
  const expiry=String(Date.now()+8*60*60_000),signature=createHmac("sha256",secret).update(expiry).digest("hex");
  const secure=new URL(process.env.IMO3D_PUBLIC_ORIGIN||request.url).protocol==="https:";
  return `imo3d_session=${expiry}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure?"; Secure":""}`;
}
export async function cloudAccess(request:Request):Promise<CloudAccess>{
  const authorization=request.headers.get("authorization");let integration:CloudAccess["integration"]=null;
  if(authorization!==null){
    const token=/^Bearer (imo3d_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
    if(token){const hash=createHash("sha256").update(token).digest("hex");const [row]=await cloudQuery("integration_keys",`select=id,project_id,scopes,last_used_at&secret_hash=eq.${hash}&revoked_at=is.null&limit=1`);
      if(row&&Array.isArray(row.scopes)){integration={id:String(row.id),projectId:String(row.project_id),scopes:row.scopes.filter((s):s is CloudScope=>s==="read"||s==="write"||s==="leads")};
        if(!row.last_used_at||Date.now()-Date.parse(String(row.last_used_at))>60_000)await cloudQuery("integration_keys",`id=eq.${encodeURIComponent(String(row.id))}&revoked_at=is.null`,"PATCH",{last_used_at:new Date().toISOString()});
      }
    }
  }
  const sessionAdmin=authorization===null&&cloudIsAdmin(request);
  return{sessionAdmin,integration,allowed:(projectId,scope="read")=>sessionAdmin||!!integration&&integration.projectId===projectId&&integration.scopes.includes(scope)};
}
