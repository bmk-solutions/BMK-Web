import type { DatabaseSync } from "node:sqlite";
import {projectDeveloper,requireDeveloper,assignDeveloper} from "./developer-management";
import type { Project } from "./model";

export class ManagementError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
type RemovedResources = { files: string[]; tourIds: string[]; jobIds: string[] };
const projectFromRow=(row:Record<string,unknown>):Project=>({id:String(row.id),name:String(row.name),location:String(row.location),createdAt:String(row.createdAt)});
export function readProject(database: DatabaseSync, id: string): Project | null {
  const row=database.prepare("SELECT id,name,location,created_at AS createdAt FROM projects WHERE id=?").get(id);
  return row ? {...projectFromRow(row),...(projectDeveloper(database,id)?{developerId:projectDeveloper(database,id)}:{})} : null;
}
export function editProject(database: DatabaseSync, id: string, input: {name:string;location:string;developerId?:string|null}): Project {
  if(input.developerId)requireDeveloper(database,input.developerId);
  const row=database.prepare("UPDATE projects SET name=?,location=? WHERE id=? RETURNING id,name,location,created_at AS createdAt").get(input.name,input.location,id);
  if(!row)throw new ManagementError(404,"المشروع غير موجود.");
  if(input.developerId!==undefined)assignDeveloper(database,id,input.developerId);
  return readProject(database,id)!;
}
const tableNames=(database:DatabaseSync)=>new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));

function removeTourRows(database:DatabaseSync,id:string,tables:Set<string>,files:Set<string>,jobIds:string[]) {
  for(const table of ["assets","scene_originals"] as const){
    if(!tables.has(table))continue;
    for(const row of database.prepare(`SELECT file FROM ${table} WHERE tour_id=?`).all(id))files.add(String(row.file));
    database.prepare(`DELETE FROM ${table} WHERE tour_id=?`).run(id);
  }
  if(tables.has("processing_jobs")){
    for(const row of database.prepare("SELECT id FROM processing_jobs WHERE tour_id=?").all(id))jobIds.push(String(row.id));
    // The worker checks the job's authority again in the same transaction as its
    // final save. Revoking and removing this row prevents a deleted tour returning.
    database.prepare("UPDATE processing_jobs SET cancel_requested=1,status='cancelled',lease_owner=NULL WHERE tour_id=?").run(id);
    database.prepare("DELETE FROM processing_jobs WHERE tour_id=?").run(id);
  }
  if(tables.has("leads"))database.prepare("DELETE FROM leads WHERE tour_id=?").run(id);
  database.prepare("DELETE FROM tours WHERE id=?").run(id);
}

function unreferencedFiles(database:DatabaseSync,tables:Set<string>,files:Set<string>) {
  const retained=new Set<string>();
  for(const table of ["assets","scene_originals"] as const){
    if(tables.has(table))for(const row of database.prepare(`SELECT file FROM ${table}`).all())retained.add(String(row.file));
  }
  return [...files].filter(file=>!retained.has(file));
}

/** Commit metadata first; the caller may then remove only the returned private filenames. */
export function removeTour(database:DatabaseSync,id:string,revision:number):RemovedResources {
  database.exec("BEGIN IMMEDIATE");
  try{
    const tour=database.prepare("SELECT revision FROM tours WHERE id=?").get(id);
    if(!tour)throw new ManagementError(404,"الجولة غير موجودة.");
    if(Number(tour.revision)!==revision)throw new ManagementError(409,"تغيّرت الجولة. أعد تحميلها وراجعها قبل الحذف.");
    const tables=tableNames(database),files=new Set<string>(),jobIds:string[]=[];
    removeTourRows(database,id,tables,files,jobIds);
    const removed={files:unreferencedFiles(database,tables,files),tourIds:[id],jobIds};
    database.exec("COMMIT");return removed;
  }catch(error){database.exec("ROLLBACK");throw error;}
}

export function removeProject(database:DatabaseSync,id:string,confirmationName:string):RemovedResources {
  database.exec("BEGIN IMMEDIATE");
  try{
    const project=readProject(database,id);
    if(!project)throw new ManagementError(404,"المشروع غير موجود.");
    if(confirmationName!==project.name)throw new ManagementError(409,"اسم التأكيد لا يطابق اسم المشروع الحالي. راجع الاسم قبل الحذف.");
    const tables=tableNames(database),files=new Set<string>(),jobIds:string[]=[];
    const tourIds=database.prepare("SELECT id FROM tours WHERE project_id=?").all(id).map(row=>String(row.id));
    for(const tourId of tourIds)removeTourRows(database,tourId,tables,files,jobIds);
    // Branding points at its image row. Remove that reference before its blob.
    for(const table of ["project_branding","project_brand_assets","integration_keys"] as const){
      if(tables.has(table))database.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
    }
    database.prepare("DELETE FROM projects WHERE id=?").run(id);
    const removed={files:unreferencedFiles(database,tables,files),tourIds,jobIds};
    database.exec("COMMIT");return removed;
  }catch(error){database.exec("ROLLBACK");throw error;}
}
