import {createHash,randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {ProcessingJob} from "./processing-model";

const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
export const imageFingerprint=(scenes:{id:string;image:string;floor:number;position:unknown;yaw:number;depth?:unknown;manualLinks?:{targetId:string;yaw:number}[];blockedLinks?:string[]}[])=>createHash("sha256").update(JSON.stringify(canonical(scenes.map(({id,image,floor,position,yaw,depth,manualLinks,blockedLinks})=>({id,image,floor,position,yaw,depth,manualLinks:manualLinks?.map(link=>({...link})).sort((a,b)=>a.targetId.localeCompare(b.targetId)),blockedLinks:blockedLinks?[...blockedLinks].sort():undefined})).sort((a,b)=>a.id.localeCompare(b.id))))).digest("hex");
export function ensureProcessingTables(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs(
    id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,stage TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    input_hash TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,result TEXT,warnings TEXT NOT NULL DEFAULT '[]');
    CREATE UNIQUE INDEX IF NOT EXISTS processing_one_active ON processing_jobs(tour_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS processing_worker_lock(name TEXT PRIMARY KEY,owner TEXT NOT NULL,lease_until INTEGER NOT NULL);`);
}
export function publicJob(row:Record<string,unknown>|undefined):ProcessingJob|null{
  if(!row)return null;return {id:String(row.id),tourId:String(row.tour_id),status:row.status as ProcessingJob["status"],progress:Number(row.progress),stage:String(row.stage),createdAt:String(row.created_at),updatedAt:String(row.updated_at),error:row.error?String(row.error):null,warnings:JSON.parse(String(row.warnings)),...(row.result?{result:JSON.parse(String(row.result))}:{} )};
}
export function latestJob(db:DatabaseSync,tourId:string){ensureProcessingTables(db);return publicJob(db.prepare("SELECT * FROM processing_jobs WHERE tour_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(tourId));}
export function enqueueJob(db:DatabaseSync,tourId:string,inputHash:string){
  ensureProcessingTables(db);const existing=db.prepare("SELECT * FROM processing_jobs WHERE tour_id=? AND status IN ('queued','running')").get(tourId);if(existing)return publicJob(existing)!;
  const id=randomUUID(),now=new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO processing_jobs(id,tour_id,status,stage,created_at,updated_at,input_hash) VALUES(?,?,'queued','في انتظار المعالجة',?,?,?)").run(id,tourId,now,now,inputHash);
  return latestJob(db,tourId)!;
}
export function cancelJob(db:DatabaseSync,tourId:string){
  ensureProcessingTables(db);const now=new Date().toISOString();
  db.prepare("UPDATE processing_jobs SET cancel_requested=1,status='cancelled',stage='أُلغيت المعالجة',updated_at=? WHERE tour_id=? AND status IN ('queued','running')").run(now,tourId);
  return latestJob(db,tourId);
}
export function claimJob(db:DatabaseSync,owner:string,now=Date.now()){
  ensureProcessingTables(db);
  db.prepare("UPDATE processing_jobs SET status='failed',error='توقفت المعالجة عدة مرات. تحقق من موارد الجهاز ثم أعد المحاولة.',stage='تحتاج إعادة محاولة',updated_at=? WHERE status='running' AND lease_until<? AND attempts>=3").run(new Date(now).toISOString(),now);
  // A process that disappeared leaves a lease, not a permanently stuck job.
  db.prepare("UPDATE processing_jobs SET status='queued',lease_owner=NULL,stage='استئناف بعد انقطاع المعالجة' WHERE status='running' AND lease_until<? AND cancel_requested=0").run(now);
  return db.prepare(`UPDATE processing_jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=?,stage='تجهيز الصور'
    WHERE id=(SELECT id FROM processing_jobs WHERE status='queued' AND cancel_requested=0 ORDER BY created_at LIMIT 1)
    RETURNING *`).get(owner,now+30_000,new Date(now).toISOString());
}
export function heartbeatJob(db:DatabaseSync,id:string,owner:string,progress:number,stage:string,now=Date.now()){
  return db.prepare("UPDATE processing_jobs SET progress=?,stage=?,lease_until=?,updated_at=? WHERE id=? AND lease_owner=? AND lease_until>=? AND status='running' AND cancel_requested=0").run(Math.max(0,Math.min(99,progress)),stage,now+30_000,new Date(now).toISOString(),id,owner,now).changes>0;
}
