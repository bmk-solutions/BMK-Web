import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
// Resolve the private database directory at runtime, never as build assets.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");
import { randomUUID } from "node:crypto";
import type { Lead, Project, Tour } from "./model";
import {readPrivateExample,PrivateExampleUnavailableError} from "./private-example";
import {ensureDeveloperTables,requireDeveloper,assignDeveloper} from "./developer-management";
import { getLeads } from "./lead-query";

// Keep the volume on the existing Node host. Never use an ephemeral serverless disk.
export const dataDirectory = () => process.env.IMO3D_DATA_DIR ?? path.join(process.cwd(),".imo3d-data");
let database: DatabaseSync | undefined;
export function db() {
  if(database)return database;
  mkdirSync(dataDirectory(),{recursive:true});
  database=new DatabaseSync(path.join(dataDirectory(),"imo3d.sqlite"));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tours(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,published INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tours_project ON tours(project_id);
    CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),name TEXT NOT NULL,phone TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_leads_tour ON leads(tour_id,created_at);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),file TEXT NOT NULL,mime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),file TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_assets_tour ON assets(tour_id);
    CREATE TABLE IF NOT EXISTS request_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  ensureDeveloperTables(database);
  return database;
}
export function projects(): Project[] {
  return db().prepare("SELECT p.id,p.name,p.location,p.created_at AS createdAt,d.developer_id AS developerId FROM projects p LEFT JOIN project_developers d ON d.project_id=p.id ORDER BY p.created_at DESC").all() as Project[];
}
export function newProject(name:string,location:string,developerId?:string|null):Project {
  if(developerId)requireDeveloper(db(),developerId);
  const project={id:randomUUID(),name,location,createdAt:new Date().toISOString(),...(developerId?{developerId}:{})};
  db().prepare("INSERT INTO projects VALUES(?,?,?,?)").run(project.id,name,location,project.createdAt);if(developerId)assignDeveloper(db(),project.id,developerId);return project;
}
export function tours(projectId?:string):Tour[] {
  const rows=projectId?db().prepare("SELECT payload FROM tours WHERE project_id=?").all(projectId):db().prepare("SELECT payload FROM tours").all();
  return rows.map(r=>JSON.parse(String(r.payload)));
}
/** List metadata without materializing depth arrays in the JavaScript heap. */
export function toursSummary(projectId?:string):Tour[] {
  // Filter authorization scope before JSON processing. Assets stay as existing
  // URLs; this query never reads uploaded originals or their binary contents.
  const scoped=projectId!==undefined;
  const statement=db().prepare(`SELECT json_set(t.payload, '$.scenes', (
    SELECT json_group_array(json_remove(scene.value, '$.depth', '$.displayDepth'))
    FROM json_each(t.payload, '$.scenes') AS scene
  )) AS payload FROM tours AS t${scoped?" WHERE t.project_id=?":""}`);
  const summaries:Tour[]=[];
  for(const row of scoped?statement.iterate(projectId):statement.iterate())summaries.push(JSON.parse(String(row.payload)));
  return summaries;
}
export function getTour(id:string):Tour|null {
  const row=db().prepare("SELECT payload FROM tours WHERE id=?").get(id);return row?JSON.parse(String(row.payload)):null;
}
export function saveTour(tour:Tour,expectedRevision?:number) {
  const next={...tour,revision:tour.revision+1,updatedAt:new Date().toISOString()};
  if(expectedRevision===undefined){db().prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(next.id,next.projectId,next.revision,next.published?1:0,JSON.stringify(next));}
  else {const result=db().prepare("UPDATE tours SET revision=?,published=?,payload=? WHERE id=? AND revision=?").run(next.revision,next.published?1:0,JSON.stringify(next),next.id,expectedRevision);
    if(!result.changes)throw new Error("CONFLICT");}
  return next;
}
export function newTour(projectId:string,title:string) {
  const now=new Date().toISOString();
  return saveTour({id:randomUUID(),title,projectId,published:false,revision:0,scenes:[],plans:[],createdAt:now,updatedAt:now,
    unit:{code:"",area:null,price:null,bedrooms:null,bathrooms:null},quality:{positioned:0,depthScenes:0,components:0,warnings:[]}});
}
export function leads(projectId?:string):Lead[] {
  return getLeads(db(),{projectId,limit:1000}).leads;
}
export function addLead(tourId:string,name:string,phone:string,note:string) {
  const id=randomUUID();db().prepare("INSERT INTO leads VALUES(?,?,?,?,?,?)").run(id,tourId,name,phone,note,new Date().toISOString());return id;
}
export function withinRateLimit(key:string,limit:number,windowMs:number) {
  const now=Date.now();
  db().prepare("DELETE FROM request_limits WHERE expires < ?").run(now);
  const row=db().prepare("INSERT INTO request_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count").get(key,now+windowMs);
  return Number(row?.count)<=limit;
}
export function installExample() {
  // Idempotent, explicit import from the reference selected by the user.
  const data=readPrivateExample();if(!data)throw new PrivateExampleUnavailableError();
  if(getTour(data.id))return getTour(data.id)!;
  db().exec("BEGIN IMMEDIATE");
  try {db().prepare("INSERT OR IGNORE INTO projects VALUES(?,?,?,?)").run(data.projectId,data.title,"",data.createdAt);
    const tour=saveTour(data);db().exec("COMMIT");return tour;
  }catch(e){db().exec("ROLLBACK");throw e;}
}
