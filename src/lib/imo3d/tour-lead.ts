import {randomBytes} from "node:crypto";
import {z} from "zod";
import {leadPhoneSchema} from "./lead-validation";
import {publicTourURL,suiteOrigin} from "./suite";
import type {Tour} from "./model";
import type {TourInterest} from "./tour-interest";
import {maskLeadPhone,requestIp,tourInterest,veraConfig,veraContext,veraForwardLead,veraKeyHash,veraLinkIds,veraLeadFailure,veraPutLink,type VeraLeadOutcome,type VeraRouted} from "./vera-integration";

/**
 * One buyer request, the same in the cloud and the local adapter: accept, limit, forward to
 * VERA, and describe the masked audit row the caller stores. VERA is the normaliser; the tour
 * checks the number with VERA's own rule first (lead-validation.ts), so a Saudi mobile has one
 * form here too and that form keys the per-phone limit.
 *
 * Server-only.
 */
export const tourLeadSchema=z.object({
 tourId:z.string().max(80),
 name:z.string({error:"اكتب اسمك."}).trim().min(2,"اكتب اسمك بحرفين على الأقل.").max(80,"الاسم أطول من 80 حرفًا."),
 phone:leadPhoneSchema,
 note:z.string().trim().max(500,"الملاحظة أطول من 500 حرف.").default(""),
 consent:z.literal(true,{error:"وافق على إرسال بياناتك قبل الإرسال."}),
 website:z.string().max(100).default(""),
});
export type TourLeadInput=z.infer<typeof tourLeadSchema>;

/** A bot fills the hidden field: it is told it succeeded, and nothing is limited, sent or stored. */
export const honeypotFilled=(raw:unknown)=>{const value=raw&&typeof raw==="object"?(raw as {website?:unknown}).website:undefined;return typeof value==="string"&&value.trim()!=="";};

export type LeadLimiter=(key:string,limit:number,windowMs:number)=>boolean|Promise<boolean>;
export type LeadLimits={spend:LeadLimiter;refund:(key:string)=>unknown};
export type LeadLimitResult={refusal:string|null;refund:()=>Promise<void>};
/** Keys the limits when VERA is off (the local adapter only): per process, so a key is never an unkeyed hash of a number or an address. */
const localKeySecret=randomBytes(32).toString("base64url");
/**
 * VERA's own per-IP limits (10 / 10 min, 30 / h) at the tour's edge, spent on every attempt: they
 * bound a buyer's retries during an outage. The per-phone (3 / h) and per-tour limits count only
 * requests VERA accepted: they are spent before the forward, so two presses at once cannot both
 * pass, and the caller refunds them when the forward fails. «أُرسل سابقًا» is therefore true.
 * Keys carry keyed hashes, never an address or a number.
 */
export async function spendLeadLimits(limits:LeadLimits,request:Request,tourId:string,phone:string):Promise<LeadLimitResult>{
 const secret=veraConfig()?.secret??localKeySecret,hash=(label:string)=>veraKeyHash(secret,label),spent:string[]=[];
 const refund=async()=>{for(const key of spent.splice(0))await (async()=>limits.refund(key))().catch(()=>{/* A refund is best effort; the window expires anyway. */});};
 const spend=async(key:string,limit:number,windowMs:number)=>{const within=await limits.spend(key,limit,windowMs);if(within)spent.push(key);return within;};
 const ip=hash("ip:"+requestIp(request));
 if(!await limits.spend(`lead-ip10:${ip}`,10,10*60_000)||!await limits.spend(`lead-ip60:${ip}`,30,60*60_000))return{refusal:"طلبات كثيرة. حاول بعد قليل.",refund};
 if(!await spend(`lead:${hash("phone:"+phone)}:${tourId}`,3,60*60_000)){await refund();return{refusal:"تم إرسال طلبك سابقًا. حاول لاحقًا.",refund};}
 if(!await spend(`lead-global:${tourId}`,100,60*60_000)){await refund();return{refusal:"طلبات كثيرة. حاول بعد قليل.",refund};}
 return{refusal:null,refund};
}

/** The refusal when this server cannot forward at all (no secret, or a preview), so nothing is limited or stored for nothing. */
export const leadsOffline=()=>veraConfig()?null:veraLeadFailure("INTEGRATION_DISABLED",503);

/** Forward to VERA with the tour's own ids; VERA resolves the developer and project, never the buyer's page. */
export function forwardTourLead(request:Request,tour:Tour,developerId:string|null,input:TourLeadInput):Promise<VeraLeadOutcome>{
 return veraForwardLead({tourId:tour.id,projectId:tour.projectId,developerId,title:tour.title,url:publicTourURL(tour.id),unitCode:tour.unit.code,name:input.name,phone:input.phone,note:input.note,ip:requestIp(request)});
}

/** The only copy the tour keeps: masked phone, tour, time, and where VERA sent it. No name, no message. */
export function leadAuditRow(id:string,tourId:string,phone:string,routed:VeraRouted,at=new Date().toISOString()){
 return{id,tour_id:tourId,phone:maskLeadPhone(phone),created_at:at,forwarded_at:at,vera_routed:routed};
}

/** The public tour payload's `interest`: VERA's context for this tour's project, developer and unit. */
export async function buyerInterest(tour:Tour,developerId:string|null):Promise<TourInterest>{
 const configured=!!veraConfig(),context=configured?await veraContext({project:tour.projectId,developer:developerId,unit:tour.unit.code||null}):null;
 return tourInterest(configured,context,suiteOrigin());
}

/** What VERA shows for a project: its most recently updated published tour, or nothing published. */
export function projectShowcase(projectName:string,tours:Tour[]){
 const shown=tours.filter(tour=>tour.published).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
 return{title:shown?.title??projectName,publicUrl:shown?publicTourURL(shown.id):null,published:!!shown,unitCode:shown?.unit.code||null};
}

/**
 * Publish and unpublish re-state a linked project's entry in VERA's registry, so VERA's project
 * page and Developer OS see the tour's current address. Only a PROJECT link names a VERA project,
 * so a project that files through its developer, a hint or the fallback is left alone.
 * Best effort: the tour is already saved, and a failure is logged by code only.
 */
export async function syncProjectLink(projectId:string,projectName:string,tours:Tour[]){
 if(!veraConfig())return;
 try{
  const context=await veraContext({project:projectId},{fresh:true});
  const ids=context?await veraLinkIds(context):null;if(!ids?.projectId)return;
  await veraPutLink({kind:"project",ref:projectId,developerId:ids.developerId,projectId:ids.projectId,...projectShowcase(projectName,tours)});
 }catch{/* The failed request logged its code; the saved tour stands. */}
}
