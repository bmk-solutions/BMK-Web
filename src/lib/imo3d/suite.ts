import {createHash} from 'node:crypto';
import {IMO3D_BASE_PATH} from './base-path.ts';

/**
 * The BMK studio suite (os.bmk.solutions/media-support) owns the owner's login. Its browser
 * cookie `ms_session` (Path=/media-support) reaches this app through the suite's rewrite; this
 * app never verifies it itself and never holds the suite's signing secret. It asks the suite's
 * zone, and remembers a positive answer for at most a minute.
 *
 * Server-only.
 */
export type SuiteSession={uid:string;email:string};

const SESSION_COOKIE='ms_session';
const POSITIVE_TTL_MS=60_000;
const MAX_CACHED=64;
const cache=new Map<string,{session:SuiteSession;until:number}>();

const origin=(value:string|undefined,fallback:string)=>new URL(value?.trim()||fallback).origin;
/** Where the owner uses the suite. Pages served through it post from this origin. */
export const suiteOrigin=()=>origin(process.env.MS_SUITE_ORIGIN,'https://os.bmk.solutions');
/** The suite zone's own deployment, which answers the session check. */
export const zoneOrigin=()=>origin(process.env.MS_ZONE_ORIGIN,'https://bmk-media-support.vercel.app');
/** This app's own host. Embeds and the ChatGPT connector live here: the suite's domain refuses framing. */
export const appOrigin=(fallback='https://bmk-imo3d.vercel.app')=>origin(process.env.IMO3D_APP_ORIGIN,fallback);

/** `next dev` on loopback is the developer's own machine: no suite, no login (unchanged local-mode rule). */
export function localDevelopmentRequest(request:Request){
  return process.env.NODE_ENV==='development'&&['127.0.0.1','localhost','[::1]'].includes(new URL(request.url).hostname);
}

/**
 * The iframe source of an embed code. It is ALWAYS this app's own host, never the suite's:
 * os.bmk.solutions answers X-Frame-Options SAMEORIGIN, so a client site could not frame a
 * suite URL. Framing stays allowed here, as it was before the move.
 */
export function embedTourURL(tourId:string,fallbackOrigin?:string){
  return appOrigin(fallbackOrigin)+IMO3D_BASE_PATH+'/t/'+encodeURIComponent(tourId);
}

/** Browser origins that serve this app's pages through the suite (same-origin writes from them are the owner's). */
export function suiteBrowserOrigins(){
  const values:string[]=[];
  for(const read of [suiteOrigin,zoneOrigin])try{values.push(read());}catch{/* A malformed setting adds no origin. */}
  return values;
}

function sessionToken(request:Request){
  for(const part of request.headers.get('cookie')?.split(';')??[]){
    const index=part.indexOf('=');if(index<0||part.slice(0,index).trim()!==SESSION_COOKIE)continue;
    const value=part.slice(index+1).trim();
    // The suite's token is base64url segments joined by dots; anything else is not forwarded.
    return /^[A-Za-z0-9._~-]{16,4096}$/.test(value)?value:null;
  }
  return null;
}

function zoneSessionURL(){
  const base=new URL(zoneOrigin());
  const loopback=['127.0.0.1','localhost','[::1]'].includes(base.hostname);
  // The token is a live credential: never send it in clear text off this machine.
  if(base.protocol!=='https:'&&!(loopback&&base.protocol==='http:'))throw Error('MS_ZONE_ORIGIN_INSECURE');
  return base.origin+'/media-support/api/_ms/session';
}

/** The owner's suite session, or null. Fails closed: any doubt is "not signed in". */
export async function suiteSession(request:Request):Promise<SuiteSession|null>{
  const token=sessionToken(request);if(!token)return null;
  const key=createHash('sha256').update(token).digest('hex'),now=Date.now(),hit=cache.get(key);
  if(hit&&hit.until>now)return hit.session;
  if(hit)cache.delete(key);
  try{
    const response=await fetch(zoneSessionURL(),{headers:{cookie:`${SESSION_COOKIE}=${token}`,accept:'application/json'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(response.status!==200){await response.body?.cancel();return null;}
    const body:unknown=await response.json();
    if(!body||typeof body!=='object')return null;
    const {ok,uid,email}=body as Record<string,unknown>;
    if(ok!==true||typeof uid!=='string'||!uid||uid.length>200)return null;
    const session={uid,email:typeof email==='string'?email.slice(0,320):''};
    if(cache.size>=MAX_CACHED)cache.delete(cache.keys().next().value!);
    cache.set(key,{session,until:now+POSITIVE_TTL_MS});
    return session;
  }catch{return null;}
}

/** Test seam: forget remembered answers. */
export function clearSuiteSessionCache(){cache.clear();}
