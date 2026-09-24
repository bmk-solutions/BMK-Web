import { createHmac, timingSafeEqual } from "node:crypto";
import { withinRateLimit } from "./store";
import { IMO3D_BASE_PATH } from "./base-path.ts";
import { localDevelopmentRequest, passwordLoginEnabled, suiteBrowserOrigins, suiteSession } from "./suite.ts";
export function secureEqual(a:string,b:string) {
  const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
/** The owner: a studio-suite session (his login); the legacy password session only while IMO3D_PASSWORD_LOGIN=1. */
export async function isAdmin(request:Request) {
  if(localDevelopmentRequest(request))return true;
  return passwordLoginEnabled()&&legacySessionAdmin(request)||!!await suiteSession(request);
}
function legacySessionAdmin(request:Request) {
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
    // Pages served through the suite (os.bmk.solutions/media-support/tour) post from the suite's origin.
    const value=new URL(origin).origin;return value===new URL(expected).origin||suiteBrowserOrigins().includes(value);
  }catch{return false;}
}
export function login(request:Request,password:string) {
  if(!withinRateLimit("login",15,5*60_000))return null;
  const secret=process.env.IMO3D_ADMIN_SECRET;if(!secret||secret.length<32||!secureEqual(password,secret))return null;
  const expiry=String(Date.now()+8*60*60_000),signature=createHmac("sha256",secret).update(expiry).digest("hex");
  // The public HTTPS origin remains authoritative behind an internal HTTP proxy.
  let secure=new URL(request.url).protocol==="https:";
  try{if(process.env.IMO3D_PUBLIC_ORIGIN)secure||=new URL(process.env.IMO3D_PUBLIC_ORIGIN).protocol==="https:";}catch{/* sameOrigin rejects malformed configuration. */}
  return `imo3d_session=${expiry}.${signature}; Path=${IMO3D_BASE_PATH}; HttpOnly; SameSite=Strict; Max-Age=28800${secure?"; Secure":""}`;
}
