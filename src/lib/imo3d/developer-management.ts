import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Developer } from "./model";
export class DeveloperError extends Error { constructor(readonly status:404|409,message:string){super(message);} }
export function ensureDeveloperTables(database:DatabaseSync){
 database.exec(`CREATE TABLE IF NOT EXISTS developers(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS project_developers(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,developer_id TEXT NOT NULL REFERENCES developers(id));
 CREATE INDEX IF NOT EXISTS idx_project_developer ON project_developers(developer_id);`);
}
export function listDevelopers(database:DatabaseSync):Developer[]{ensureDeveloperTables(database);return database.prepare("SELECT id,name,created_at AS createdAt FROM developers ORDER BY created_at DESC,id").all() as Developer[];}
export function requireDeveloper(database:DatabaseSync,id:string){ensureDeveloperTables(database);if(!database.prepare("SELECT id FROM developers WHERE id=?").get(id))throw new DeveloperError(404,"المطوّر غير موجود.");}
export function createDeveloper(database:DatabaseSync,name:string):Developer{ensureDeveloperTables(database);const item={id:randomUUID(),name,createdAt:new Date().toISOString()};database.prepare("INSERT INTO developers VALUES(?,?,?)").run(item.id,item.name,item.createdAt);return item;}
export function renameDeveloper(database:DatabaseSync,id:string,name:string):Developer{requireDeveloper(database,id);return database.prepare("UPDATE developers SET name=? WHERE id=? RETURNING id,name,created_at AS createdAt").get(name,id) as Developer;}
export function assignDeveloper(database:DatabaseSync,projectId:string,developerId:string|null){
 ensureDeveloperTables(database);
 if(!database.prepare("SELECT id FROM projects WHERE id=?").get(projectId))throw new DeveloperError(404,"المشروع غير موجود.");
 if(developerId){requireDeveloper(database,developerId);database.prepare("INSERT INTO project_developers VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET developer_id=excluded.developer_id").run(projectId,developerId);}
 else database.prepare("DELETE FROM project_developers WHERE project_id=?").run(projectId);
}
export function projectDeveloper(database:DatabaseSync,projectId:string):string|undefined{ensureDeveloperTables(database);const row=database.prepare("SELECT developer_id FROM project_developers WHERE project_id=?").get(projectId);return row?String(row.developer_id):undefined;}
