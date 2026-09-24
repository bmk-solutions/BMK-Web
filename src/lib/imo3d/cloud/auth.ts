import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {cloudQuery} from "./client";
import {withinRateLimit} from "./repository";
import {hashAdminPassword,verifyAdminPassword} from '../admin-password';
import {CloudHTTPError} from './http';
import {IMO3D_BASE_PATH} from '../base-path';
import {suiteBrowserOrigins,suiteSession} from '../suite';
export type CloudScope="read"|"write"|"leads";
export type CloudAccess={sessionAdmin:boolean;integration:{id:string;projectId:string;scopes:CloudScope[]}|null;allowed:(projectId:string,scope?:CloudScope)=>boolean};
export const secureEqual=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
type Credential={id:string;password_hash:string;version:string};
const signingSecret=()=>process.env.IMO3D_SESSION_SECRET||process.env.IMO3D_ADMIN_SECRET;
async function credential(){return (await cloudQuery<Credential[]>('admin_credentials','select=password_hash,version&id=eq.administrator&limit=1'))[0]??null;}
/** The owner: a studio-suite session (his login), or the legacy IMO3D password session, still honoured by the API. */
export async function cloudIsAdmin(request:Request){return await legacySessionAdmin(request)||!!await suiteSession(request);}
async function legacySessionAdmin(request:Request){
  const secret=signingSecret();if(!secret||secret.length<32)return false;
  const cookie=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("imo3d_session="))?.slice(14);
  const match=/^(\d{13})\.(?:([a-z0-9-]{1,40})\.)?([a-f0-9]{64})$/.exec(cookie??"");if(!match||Number(match[1])<Date.now()||Number(match[1])>Date.now()+8*60*60_000)return false;
  const signed=match[2]?`${match[1]}.${match[2]}`:match[1];
  if(!secureEqual(match[3],createHmac('sha256',secret).update(signed).digest('hex')))return false;
  const current=await credential();return (match[2]??'bootstrap')===(current?.version??'bootstrap');
}
export function cloudSameOrigin(request:Request){
  const origin=request.headers.get("origin");if(!origin||request.headers.get("sec-fetch-site")==="cross-site")return false;
  // Pages served through the suite (os.bmk.solutions/media-support/tour) post from the suite's origin.
  try{const value=new URL(origin).origin;return value===new URL(process.env.IMO3D_PUBLIC_ORIGIN||request.url).origin||suiteBrowserOrigins().includes(value);}catch{return false;}
}
export async function cloudLogin(request:Request,password:string){
  if(!await withinRateLimit("login",15,5*60_000))return null;
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32)return null;
  const current=await credential();if(!(current?await verifyAdminPassword(password,current.password_hash):secureEqual(password,secret)))return null;
  return sessionCookie(request,current?.version??'bootstrap');
}
function sessionCookie(request:Request,version:string){
  const secret=signingSecret();if(!secret||secret.length<32)throw new Error('Admin signing key unavailable');
  const expiry=String(Date.now()+8*60*60_000),value=`${expiry}.${version}`,signature=createHmac("sha256",secret).update(value).digest("hex");
  const secure=new URL(process.env.IMO3D_PUBLIC_ORIGIN||request.url).protocol==="https:";
  // Scoped to this app: on the suite's domain a Path=/ cookie would reach every other app there.
  return `imo3d_session=${value}.${signature}; Path=${IMO3D_BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=28800${secure?"; Secure":""}`;
}
export async function cloudChangePassword(request:Request,currentPassword:string,newPassword:string){
  if(!await withinRateLimit('change-password',5,5*60_000))throw new CloudHTTPError('محاولات كثيرة. انتظر خمس دقائق ثم حاول مجددًا.',429);
  const current=await credential(),secret=process.env.IMO3D_ADMIN_SECRET;
  if(!secret||!(current?await verifyAdminPassword(currentPassword,current.password_hash):secureEqual(currentPassword,secret)))throw new CloudHTTPError('كلمة المرور الحالية غير صحيحة.',400);
  if(secureEqual(currentPassword,newPassword))throw new CloudHTTPError('اختر كلمة مرور مختلفة عن الحالية.',400);
  const version=randomUUID(),next={id:'administrator',password_hash:await hashAdminPassword(newPassword),version,updated_at:new Date().toISOString()};
  const saved=await cloudQuery<Credential[]>('admin_credentials',current?`id=eq.administrator&version=eq.${current.version}`:'',current?'PATCH':'POST',next);
  if(!saved?.length)throw new CloudHTTPError('تغيّرت كلمة المرور في جلسة أخرى. سجّل الدخول مجددًا.',409);
  return sessionCookie(request,version);
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
  const sessionAdmin=authorization===null&&await cloudIsAdmin(request);
  return{sessionAdmin,integration,allowed:(projectId,scope="read")=>sessionAdmin||!!integration&&integration.projectId===projectId&&integration.scopes.includes(scope)};
}
