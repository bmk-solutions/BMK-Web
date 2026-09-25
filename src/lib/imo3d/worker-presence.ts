/**
 * Heartbeats of the engines on the owner's PC, read from `imo3d_plan_workers` (id, seen_at).
 *
 * - `subscription`: the plans role (plans and photo retouch) — the row the studio has always read.
 * - `subscription:<provider>`: the same role naming the provider it runs (`codex` or `gemini-local`),
 *   written beside the row above so no column is added to the table.
 * - `photos`: the photos role (upload processing and linking).
 *
 * A role that has never written its row is `unknown`, not `offline`: a worker built before it
 * heartbeated would otherwise be reported down while it is running.
 */
export type WorkerRow={id:string;seen_at:string};
export type EngineState='online'|'offline'|'unknown';
export type PlanProvider='codex'|'gemini-local';
export const WORKER_ONLINE_MS=90_000;
export const PLANS_WORKER_ID='subscription';
export const PHOTOS_WORKER_ID='photos';
const PROVIDERS:readonly PlanProvider[]=['codex','gemini-local'];
export const planProviderWorkerId=(provider:PlanProvider)=>`${PLANS_WORKER_ID}:${provider}`;
export function planProviderOf(id:string|undefined):PlanProvider|null{
 const value=(id??'').trim().toLowerCase();
 return value==='gemini'?'gemini-local':(PROVIDERS as readonly string[]).includes(value)?value as PlanProvider:null;
}
const fresh=(row:WorkerRow|undefined,now:number)=>!!row&&Number.isFinite(Date.parse(row.seen_at))&&now-Date.parse(row.seen_at)<WORKER_ONLINE_MS;
export function engineState(rows:readonly WorkerRow[],id:string,now=Date.now()):EngineState{
 const row=rows.find(item=>item.id===id);
 return !row?'unknown':fresh(row,now)?'online':'offline';
}
/** The provider the online plans worker reports; null when it runs a build that does not say. */
export function onlinePlanProvider(rows:readonly WorkerRow[],now=Date.now()):PlanProvider|null{
 if(engineState(rows,PLANS_WORKER_ID,now)!=='online')return null;
 const seen=PROVIDERS.map(provider=>({provider,row:rows.find(item=>item.id===planProviderWorkerId(provider))})).filter(item=>fresh(item.row,now));
 seen.sort((a,b)=>Date.parse(b.row!.seen_at)-Date.parse(a.row!.seen_at));
 return seen[0]?.provider??null;
}
/** The studio's label for the plans worker, true to what it reported. */
export function planWorkerLabel(provider:PlanProvider|null|undefined,online:boolean){
 const name=provider==='codex'?'عامل Codex':provider==='gemini-local'?'عامل Gemini':'عامل المخططات';
 return online?`${name} على جهازك متصل.`:`${name} على جهازك غير متصل. شغّل عامل المخططات واترك الجهاز متصلًا أثناء المعالجة.`;
}
