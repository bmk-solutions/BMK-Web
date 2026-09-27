import {createHash,createHmac,randomBytes} from "node:crypto";
import {z} from "zod";
import {INVALID_LEAD_PHONE} from "./lead-validation";
import type {TourInterest} from "./tour-interest";

/**
 * The tour's half of the VERA lead federation (docs/imo3d-media-support.md, «VERA»).
 *
 * A buyer's «سجّل اهتمامك» is not kept here: it is forwarded, signed, to VERA
 * (bmk-spatial, served under /imo3d), which routes it to the developer's project
 * in Developer OS or to BMK's own inbox. This tour stores only a masked audit row.
 * Routing is VERA's: the tour sends its own ids and VERA resolves them against the
 * link registry the studio writes through the same signed channel.
 *
 * Every request is signed with VERA_INTEGRATION_SECRET (this app's own «tour360»
 * secret) over the canonical text below (`x-vera-ts` in Unix seconds); VERA refuses an
 * unknown app, a bad MAC, a clock more than 60 s off and a nonce it has seen. No secret = the feature is
 * off. The origin is VERA's own deployment, never os.bmk.solutions, so an outage
 * of the suite's front does not stop a buyer's request.
 *
 * Server-only: it holds the secret and nothing here is ever logged but a code.
 */
export const VERA_APP="tour360";
export const VERA_CONSENT_VERSION="vera-consent-2026-09-25";
/** VERA's Next basePath; the signature covers the path after it. */
export const VERA_BASE_PATH="/imo3d";
export const VERA_CONTEXT_TTL_MS=60_000;
/** How long the last good context stands in for VERA while it cannot answer. */
export const VERA_CONTEXT_STALE_MS=24*60*60_000;
const REQUEST_TIMEOUT_MS=8_000,CONTEXT_TIMEOUT_MS=2_500,MAX_CACHED=256;
export const VERA_ROUTES=["project","developer","hint","fallback"] as const;
export type VeraRouted=typeof VERA_ROUTES[number];
export type VeraLinkKind="project"|"developer";
export type VeraConfig={secret:string;origin:string};

/**
 * The secret and origin, or null (feature off). A Vercel preview never forwards a buyer, even with
 * the variables copied onto it (VERA refuses previews too). Plain http only on loopback outside production.
 */
export function veraConfig(env:NodeJS.ProcessEnv=process.env):VeraConfig|null{
 const secret=env.VERA_INTEGRATION_SECRET?.trim()??"",raw=env.VERA_INTEGRATION_ORIGIN?.trim()??"";
 if(secret.length<32||!raw||env.VERCEL_ENV&&env.VERCEL_ENV!=="production")return null;
 try{
  const url=new URL(raw),loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/")return null;
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback&&env.NODE_ENV!=="production"))return null;
  return{secret,origin:url.origin};
 }catch{return null;}
}

export const veraBodyDigest=(body:string)=>createHash("sha256").update(body,"utf8").digest("base64url");
/** The exact text a request's MAC covers. `query` is the query string as sent, without «?». */
export function veraCanonical(m:{app:string;ts:string;nonce:string;method:string;path:string;query:string;body:string}){
 return ["vera-int-v1",m.app,m.ts,m.nonce,m.method.toUpperCase(),`${m.path}?${m.query}`,veraBodyDigest(m.body)].join("\n");
}
export const veraSignature=(secret:string,canonical:string)=>"v1="+createHmac("sha256",secret).update(canonical,"utf8").digest("base64url");
/** A keyed hash that names a buyer's IP or phone without carrying it: HMAC(secret, label) truncated to 16 bytes. */
export const veraKeyHash=(secret:string,label:string)=>createHmac("sha256",secret).update(label,"utf8").digest().subarray(0,16).toString("base64url");
export const veraIpHash=(secret:string,ip:string)=>veraKeyHash(secret,"ip:"+ip);

/** The client IP as the platform reports it. Only ever hashed; never stored or logged. */
export function requestIp(request:Request){
 const real=request.headers.get("x-real-ip")?.trim(),forwarded=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
 return (real||forwarded||"unknown").slice(0,64);
}

/** «05••••123»: enough for the studio to tell two buyers apart, never the number. */
export function maskLeadPhone(phone:string){
 const digits=phone.replace(/\D/g,""),ksa=/^(?:00966|966|0)?(5\d{8})$/.exec(digits);
 if(ksa)return "05••••"+ksa[1].slice(-3);
 const international=phone.trim().startsWith("+")||digits.startsWith("00"),body=digits.replace(/^00/,"");
 return (international?"+":"")+body.slice(0,2)+"••••"+body.slice(-3);
}

export class VeraUnavailable extends Error{constructor(readonly code:string){super(code);this.name="VeraUnavailable";}}
type VeraAnswer={status:number;data:Record<string,unknown>|null};
/** One signed request. Throws VeraUnavailable when the feature is off or VERA cannot be reached. */
export async function veraRequest(method:"GET"|"POST"|"PUT"|"DELETE",path:string,options:{query?:URLSearchParams;body?:unknown;timeoutMs?:number}={}):Promise<VeraAnswer>{
 const config=veraConfig();if(!config)throw new VeraUnavailable("INTEGRATION_DISABLED");
 const body=options.body===undefined?"":JSON.stringify(options.body),query=options.query?.toString()??"";
 const ts=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString("base64url");
 const signature=veraSignature(config.secret,veraCanonical({app:VERA_APP,ts,nonce,method,path,query,body}));
 let response:Response;
 try{
  response=await fetch(`${config.origin}${VERA_BASE_PATH}${path}${query?`?${query}`:""}`,{method,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(options.timeoutMs??REQUEST_TIMEOUT_MS),
   headers:{"Content-Type":"application/json","x-vera-app":VERA_APP,"x-vera-ts":ts,"x-vera-nonce":nonce,"x-vera-signature":signature},...(body?{body}:{})});
 }catch{throw new VeraUnavailable("UNREACHABLE");}
 const data=await response.json().catch(()=>null);
 return{status:response.status,data:data&&typeof data==="object"&&!Array.isArray(data)?data as Record<string,unknown>:null};
}
const logFailure=(operation:string,status:number,code:string)=>console.error("IMO3D VERA request failed",{app:VERA_APP,operation,status,code:/^[A-Z0-9_]{1,40}$/.test(code)?code:"UNKNOWN"});

export type TourLeadForward={tourId:string;projectId:string;developerId:string|null;title:string;url:string;unitCode:string;name:string;phone:string;note:string;ip:string};
export type VeraLeadOutcome={ok:true;routed:VeraRouted;duplicate:boolean}|{ok:false;status:number;error:string;message:string};
const RETRY="تعذّر الإرسال، حاول مجددًا.";
const BUYER_ERRORS:Record<string,{status:number;message:string}>={
 BAD_PHONE:{status:400,message:INVALID_LEAD_PHONE},
 BAD_NAME:{status:400,message:"اكتب اسمك بحرفين على الأقل."},
 NO_CONSENT:{status:400,message:"وافق على إرسال بياناتك قبل الإرسال."},
 UNIT_OFF_MARKET:{status:409,message:"هذه الوحدة غير متاحة للبيع حاليًا."},
 RATE_LIMITED:{status:429,message:"طلبات كثيرة. حاول بعد قليل."},
};
/** What the buyer is told for VERA's answer. Anything not his to fix is one retry message. */
export function veraLeadFailure(error:string,status:number):Extract<VeraLeadOutcome,{ok:false}>{
 const known=BUYER_ERRORS[status===429?"RATE_LIMITED":error];
 return known?{ok:false,error:status===429?"RATE_LIMITED":error,...known}:{ok:false,status:503,error:error||"UNAVAILABLE",message:RETRY};
}

/** Forward one buyer's request. Nothing is kept here unless VERA answers that it holds the lead. */
export async function veraForwardLead(lead:TourLeadForward):Promise<VeraLeadOutcome>{
 const config=veraConfig();if(!config)return veraLeadFailure("INTEGRATION_DISABLED",503);
 const body={app:VERA_APP,ref:{project:lead.projectId,developer:lead.developerId,developerHint:null,item:lead.tourId},buyer:{name:lead.name,phone:lead.phone,message:lead.note},
  unit:{code:lead.unitCode||null},consent:{given:true,version:VERA_CONSENT_VERSION},context:{title:lead.title,url:lead.url},client:{ipHash:veraIpHash(config.secret,lead.ip)}};
 try{
  const {status,data}=await veraRequest("POST","/api/integrations/v1/leads",{body});
  const routed=VERA_ROUTES.find(route=>route===data?.routed);
  if(status===200&&data?.ok===true&&routed)return{ok:true,routed,duplicate:data.duplicate===true};
  const code=typeof data?.error==="string"?data.error:"";
  if(!BUYER_ERRORS[code]&&status!==429)logFailure("lead",status,code);
  return veraLeadFailure(code,status);
 }catch(error){logFailure("lead",0,error instanceof VeraUnavailable?error.code:"UNREACHABLE");return veraLeadFailure("UNREACHABLE",503);}
}

/**
 * VERA's picture of one tour reference: where a request would go (the same order a lead meets),
 * the names the consent may use, the developer's WhatsApp and the unit's status. VERA names the
 * developer only when the reference is linked; `id`s are read when VERA sends them.
 */
export type UnitOffMarketStatus="sold"|"reserved"|"rented";
export type VeraContext={routed:VeraRouted;developer:{id:string|null;name:string|null}|null;project:{id:string|null;name:string|null}|null;whatsapp:string|null;unitOffMarket:boolean;unitStatus:UnitOffMarketStatus|null;privacyUrl:string|null};
const text=(max:number)=>z.string().trim().max(max).nullish().transform(value=>value||null);
const contextSchema=z.object({
 routed:z.enum(VERA_ROUTES),
 developer:z.object({id:text(80),name:text(200)}).nullish(),
 project:z.object({id:text(80),name:text(200)}).nullish(),
 whatsapp:text(40),
 unit:z.object({status:text(40),offMarket:z.boolean().nullish()}).nullish(),
 privacyUrl:text(500),
});
const OFF_MARKET=new Set<string>(["sold","reserved","rented"]);
const whatsappNumber=(value:string|null)=>{const digits=value?.replace(/[\s()+-]/g,"")??"";return /^[1-9]\d{7,14}$/.test(digits)?digits:null;};
const httpsUrl=(value:string|null)=>{try{const url=new URL(value??"");return url.protocol==="https:"&&!url.username&&!url.password?url.href:null;}catch{return null;}};
/** VERA's answer, normalised and bounded. Anything that does not parse is treated as «not known». */
export function parseVeraContext(data:unknown):VeraContext|null{
 const parsed=contextSchema.safeParse(data);if(!parsed.success)return null;
 const value=parsed.data,status=value.unit?.status?.toLowerCase()??"";
 return{routed:value.routed,developer:value.developer?{id:value.developer.id,name:value.developer.name}:null,project:value.project?{id:value.project.id,name:value.project.name}:null,
  whatsapp:whatsappNumber(value.whatsapp),unitOffMarket:value.unit?.offMarket===true||OFF_MARKET.has(status),unitStatus:OFF_MARKET.has(status)?status as UnitOffMarketStatus:null,privacyUrl:httpsUrl(value.privacyUrl)};
}
/**
 * VERA's context always names a project. A tour DEVELOPER's own link is read with a project
 * reference no tour project can have, so no project link answers and the developer link (or the
 * fallback) does.
 */
export const developerProbeRef=(developer:string)=>"developer-link:"+developer;

type CachedContext={value:VeraContext|null;until:number;good:VeraContext|null;goodAt:number};
const contextCache=new Map<string,CachedContext>();
export function clearVeraContextCache(){contextCache.clear();}
/**
 * VERA's context for a reference, remembered for a minute. A failure is remembered too, so an
 * outage does not slow every arrival, but it does not erase what VERA said last: for a day the
 * last good answer stands in (stale-if-error), so a linked developer keeps his name in the consent
 * and his WhatsApp button while VERA is down. `fresh` (the publish sync) reads VERA or nothing.
 */
export async function veraContext(ref:{project:string;developer?:string|null;unit?:string|null},options:{fresh?:boolean}={}):Promise<VeraContext|null>{
 if(!veraConfig())return null;
 const query=new URLSearchParams({project:ref.project});
 if(ref.developer)query.set("developer",ref.developer);if(ref.unit)query.set("unit",ref.unit);
 const key=query.toString(),now=Date.now(),hit=contextCache.get(key);
 if(!options.fresh&&hit&&hit.until>now)return hit.value;
 let answered:VeraContext|null=null;
 try{const {status,data}=await veraRequest("GET","/api/integrations/v1/context",{query,timeoutMs:CONTEXT_TIMEOUT_MS});answered=status===200?parseVeraContext(data):null;if(status!==200)logFailure("context",status,String(data?.error??""));}
 catch(error){logFailure("context",0,error instanceof VeraUnavailable?error.code:"UNREACHABLE");}
 const stale=hit?.good&&now-hit.goodAt<=VERA_CONTEXT_STALE_MS?hit.good:null;
 if(!contextCache.has(key)&&contextCache.size>=MAX_CACHED)contextCache.delete(contextCache.keys().next().value!);
 contextCache.set(key,answered?{value:answered,until:now+VERA_CONTEXT_TTL_MS,good:answered,goodAt:now}:{value:stale,until:now+VERA_CONTEXT_TTL_MS,good:stale,goodAt:stale?hit!.goodAt:0});
 return answered??(options.fresh?null:stale);
}
/**
 * The buyer's side of the context, merged into the public tour payload. An unlinked tour still
 * takes requests (BMK's inbox) but never names BMK as the developer. The Developer OS project is
 * named only when a project link files the lead under it; otherwise the tour's own name stands.
 * `beacon` is VERA's events route on the suite's origin, which the tour shares when served through it.
 */
export function tourInterest(configured:boolean,context:VeraContext|null,suite:string):TourInterest{
 const linked=!!context&&context.routed!=="fallback";
 return{enabled:configured,developerName:linked?context.developer?.name??null:null,projectName:context?.routed==="project"?context.project?.name??null:null,whatsapp:linked?context.whatsapp:null,
  unitOffMarket:context?.unitOffMarket??false,unitStatus:context?.unitStatus??null,privacyUrl:context?.privacyUrl??null,bmkInbox:context?.routed==="fallback",beacon:configured?`${suite}${VERA_BASE_PATH}/api/events`:null};
}

export type VeraCatalogue={developers:{id:string;name:string;local:boolean}[];projects:{id:string;name:string}[]};
const catalogueSchema=z.object({
 developers:z.array(z.object({id:z.string().max(80),name:z.string().max(200),source:z.string().max(20).nullish()})).max(2000).default([]),
 projects:z.array(z.object({id:z.string().max(80),name:z.string().max(200)})).max(2000).default([]),
});
/** VERA's developers (platform and local, labelled by `source`), or one developer's projects. */
export async function veraCatalogue(developer?:string):Promise<VeraCatalogue>{
 const {status,data}=await veraRequest("GET","/api/integrations/v1/catalogue",{query:new URLSearchParams(developer?{developer}:{})});
 const parsed=catalogueSchema.safeParse(data);
 if(status!==200||!parsed.success){logFailure("catalogue",status,String(data?.error??""));throw new VeraUnavailable("CATALOGUE");}
 return{developers:parsed.data.developers.map(item=>({id:item.id,name:item.name,local:item.source==="local"})),projects:parsed.data.projects.map(item=>({id:item.id,name:item.name}))};
}
/**
 * The ids behind a linked context: VERA's own when it sends them, otherwise the one catalogue
 * entry with that exact name (two developers or projects with one name resolve to nothing).
 */
export async function veraLinkIds(context:VeraContext):Promise<{developerId:string;projectId:string|null}|null>{
 if(context.developer?.id)return{developerId:context.developer.id,projectId:context.project?.id??null};
 const developerName=context.developer?.name,projectName=context.project?.name;if(!developerName)return null;
 const developers=(await veraCatalogue()).developers.filter(item=>item.name===developerName);if(developers.length!==1)return null;
 if(!projectName)return{developerId:developers[0].id,projectId:null};
 const projects=(await veraCatalogue(developers[0].id)).projects.filter(item=>item.name===projectName);
 return projects.length===1?{developerId:developers[0].id,projectId:projects[0].id}:null;
}

export type VeraLinkInput={kind:VeraLinkKind;ref:string;developerId:string;projectId:string|null;title:string;publicUrl:string|null;published:boolean;unitCode:string|null};
/** Write one entry of VERA's link registry. VERA refuses a target a lead could never reach (409 BAD_TARGET). */
export async function veraPutLink(link:VeraLinkInput){
 const {status,data}=await veraRequest("PUT","/api/integrations/v1/links",{body:{kind:link.kind,ref:link.ref,developerId:link.developerId,projectId:link.projectId,title:link.title,publicUrl:link.publicUrl,published:link.published,unitCode:link.unitCode,actor:null}});
 if(status===200&&data?.ok===true)return;
 const code=String(data?.error??"");logFailure("link",status,code);throw new VeraUnavailable(code==="BAD_TARGET"?code:"LINK");
}
/** Remove one entry; an entry that is already gone is not an error. */
export async function veraDeleteLink(kind:VeraLinkKind,ref:string){
 const {status,data}=await veraRequest("DELETE","/api/integrations/v1/links",{query:new URLSearchParams({kind,ref})});
 if(status===200&&data?.ok===true||status===404&&data?.error==="NOT_FOUND")return;
 logFailure("unlink",status,String(data?.error??""));throw new VeraUnavailable("LINK");
}
