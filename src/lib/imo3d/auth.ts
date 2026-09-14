import { createHmac, timingSafeEqual } from "node:crypto";
import { withinRateLimit } from "./store";
export function secureEqual(a:string,b:string) {
  const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
function localDevelopment(request:Request) {
  const url=new URL(request.url);
  return process.env.NODE_ENV==="development"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname);
}
export function isAdmin(request:Request) {
  if(localDevelopment(request))return true;
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32)return false;
  const cookie=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("imo3d_session="))?.split("=")[1];
  if(!cookie)return false;const [expiry,signature]=cookie.split(".");
  if(!expiry||!signature||Number(expiry)<Date.now())return false;
  const expected=createHmac("sha256",secret).update(expiry).digest("hex");return secureEqual(signature,expected);
}
export function sameOrigin(request:Request) {
  const origin=request.headers.get("origin");
  if(!origin||request.headers.get("sec-fetch-site")==="cross-site")return false;
  try {const expected=process.env.IMO3D_PUBLIC_ORIGIN??`${new URL(request.url).protocol}//${request.headers.get("host")??new URL(request.url).host}`;
    return new URL(origin).origin===new URL(expected).origin;
  }catch{return false;}
}
export function login(request:Request,password:string) {
  if(!withinRateLimit("login",15,5*60_000))return null;
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32||!secureEqual(password,secret))return null;
  const expiry=String(Date.now()+8*60*60_000),signature=createHmac("sha256",secret).update(expiry).digest("hex");
  // The public HTTPS origin remains authoritative behind an internal HTTP proxy.
  let secure=new URL(request.url).protocol==="https:";
  try{if(process.env.IMO3D_PUBLIC_ORIGIN)secure||=new URL(process.env.IMO3D_PUBLIC_ORIGIN).protocol==="https:";}catch{/* sameOrigin rejects malformed configuration. */}
  return `imo3d_session=${expiry}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure?"; Secure":""}`;
}
