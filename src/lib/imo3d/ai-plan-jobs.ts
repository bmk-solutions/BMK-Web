import {createHash,randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

export type RasterNavigation={width:number;height:number;outline?:{x:number;y:number}[];points:{sceneId:string;x:number;y:number}[];source:"reviewed-photo-registration"};
export type AIPlanResult={source?:string;floors:{floor:number;sceneIds:string[];navigation?:RasterNavigation;audit:{verdict:string;issues:string[];limitations:string[]}}[];limitations:string[];sceneCount:number};
export type AIPlanJob={id:string;tourId:string;status:string;progress:number;stage:string;error:string|null;result:AIPlanResult|null;createdAt:string};
// Explicit projection prevents private artifact paths being serialized to the browser.
const normalizedPoint=z.object({x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)});
const navigationSchema=z.object({width:z.number().positive().max(20000),height:z.number().positive().max(20000),outline:z.array(normalizedPoint).min(3).max(200).optional(),source:z.literal("reviewed-photo-registration"),points:z.array(z.object({sceneId:z.string(),x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)})).max(500)});
const publicResultSchema=z.object({source:z.string().optional(),floors:z.array(z.object({floor:z.number(),sceneIds:z.array(z.string()),navigation:navigationSchema.optional(),audit:z.object({verdict:z.string(),issues:z.array(z.string()),limitations:z.array(z.string())})})),limitations:z.array(z.string()),sceneCount:z.number()});
function publicResult(value:unknown):AIPlanResult|null{try{return publicResultSchema.parse(JSON.parse(String(value)));}catch{return null;}}
export function aiPlanFingerprint(scenes:{id:string;image:string;floor:number}[]){return createHash("sha256").update(JSON.stringify(scenes.map(({id,image,floor})=>({id,image,floor})).sort((a,b)=>a.id.localeCompare(b.id)))).digest("hex");}
export function ensureAIPlanTables(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS ai_plan_jobs(
 id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
 input_hash TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,stage TEXT NOT NULL,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS ai_plan_active ON ai_plan_jobs(tour_id) WHERE status IN ('queued','running');`);}
export function recoverAIPlanJobs(db:DatabaseSync,now=Date.now()){ensureAIPlanTables(db);db.prepare("UPDATE ai_plan_jobs SET status='failed',error='انقطع عامل المعالجة. يمكنك إعادة المحاولة؛ قد تُحتسب الطلبات السابقة لدى OpenAI.',stage='المعالجة متوقفة',updated_at=? WHERE status IN ('queued','running') AND lease_until<?").run(new Date(now).toISOString(),now);}
export function claimAIPlanJob(db:DatabaseSync,id:string,now=Date.now()){return db.prepare("UPDATE ai_plan_jobs SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='queued' AND lease_until>=? RETURNING *").get(now+60_000,new Date(now).toISOString(),id,now);}
export function cancelAIPlanJob(db:DatabaseSync,tourId:string){ensureAIPlanTables(db);return db.prepare("UPDATE ai_plan_jobs SET status='cancelled',stage='أُلغيت المعالجة',updated_at=? WHERE tour_id=? AND status IN ('queued','running')").run(new Date().toISOString(),tourId).changes;}
export function staleAIPlanJob(db:DatabaseSync,id:string){return db.prepare("UPDATE ai_plan_jobs SET status='stale',stage='تغيرت صور الجولة؛ أعد التوليد',updated_at=? WHERE id=? AND status='running'").run(new Date().toISOString(),id).changes;}
export function heartbeatAIPlanJob(db:DatabaseSync,id:string,now=Date.now()){return !!db.prepare("UPDATE ai_plan_jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_until>=?").run(now+60_000,new Date(now).toISOString(),id,now).changes;}
export function latestAIPlanJob(db:DatabaseSync,tourId:string):AIPlanJob|null{
 ensureAIPlanTables(db);const row=db.prepare('SELECT * FROM ai_plan_jobs WHERE tour_id=? ORDER BY rowid DESC LIMIT 1').get(tourId);if(!row)return null;
 return {id:String(row.id),tourId:String(row.tour_id),status:String(row.status),progress:Number(row.progress),stage:String(row.stage),error:row.error?String(row.error):null,result:row.result?publicResult(row.result):null,createdAt:String(row.created_at)};
}
export function enqueueAIPlan(db:DatabaseSync,tourId:string,hash:string){
 recoverAIPlanJobs(db);const now=new Date().toISOString();
 db.prepare("INSERT OR IGNORE INTO ai_plan_jobs(id,tour_id,input_hash,status,stage,created_at,updated_at,lease_until) VALUES(?,?,?,'queued','في انتظار تحليل الصور',?,?,?)").run(randomUUID(),tourId,hash,now,now,Date.now()+60_000);
 return latestAIPlanJob(db,tourId)!;
}
