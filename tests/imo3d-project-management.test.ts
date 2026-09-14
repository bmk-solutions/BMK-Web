import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { editProject,ManagementError,readProject,removeProject,removeTour } from "../src/lib/imo3d/project-management";
import { ensureProcessingTables,heartbeatJob } from "../src/lib/imo3d/processing-jobs";

function database(){
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,location TEXT,created_at TEXT);
    CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),revision INTEGER,payload TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT);
    CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT);
    CREATE TABLE leads(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id));
    INSERT INTO projects VALUES('a','Project A','Riyadh','2026-09-08'),('b','Project B','Jeddah','2026-09-08');
    INSERT INTO tours VALUES('a1','a',3,'{}'),('a2','a',2,'{}'),('b1','b',5,'{}');
    INSERT INTO assets VALUES('asset-a','a1','a.webp'),('shared-a','a1','shared.webp'),('asset-a2','a2','a2.webp'),('shared-b','b1','shared.webp'),('asset-b','b1','b.webp');
    INSERT INTO scene_originals VALUES('scene-a','a1','a.original.jpg'),('scene-b','b1','b.original.jpg');
    INSERT INTO leads VALUES('lead-a','a1'),('lead-a2','a2'),('lead-b','b1');`);
  return db;
}
const count=(db:DatabaseSync,table:string)=>Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
function job(db:DatabaseSync,id:string,tourId:string){
  ensureProcessingTables(db);
  db.prepare("INSERT INTO processing_jobs(id,tour_id,status,stage,created_at,updated_at,input_hash,lease_owner,lease_until) VALUES(?,?,'running','matching','','','hash','worker',?)").run(id,tourId,Date.now()+60_000);
}

test("project edit changes only the requested project's fields and preserves its creation date",()=>{
  const db=database();try{
    const originalB=readProject(db,"b");
    assert.deepEqual(editProject(db,"a",{name:"Renamed project",location:"Dammam"}),{id:"a",name:"Renamed project",location:"Dammam",createdAt:"2026-09-08"});
    assert.deepEqual(readProject(db,"b"),originalB);assert.equal(count(db,"tours"),3);
    assert.throws(()=>editProject(db,"missing",{name:"Name",location:""}),error=>error instanceof ManagementError&&error.status===404);
  }finally{db.close();}
});

test("stale tour revisions and incorrect project confirmation leave all resources and live jobs intact",()=>{
  const db=database();try{
    job(db,"job-a","a1");
    assert.throws(()=>removeTour(db,"a1",2),error=>error instanceof ManagementError&&error.status===409);
    assert.throws(()=>removeProject(db,"a","Project A "),error=>error instanceof ManagementError&&error.status===409);
    assert.equal(count(db,"tours"),3);assert.equal(count(db,"assets"),5);assert.equal(count(db,"leads"),3);
    assert.equal(heartbeatJob(db,"job-a","worker",25,"matching"),true);
  }finally{db.close();}
});

test("tour deletion removes its children, invalidates active worker authority, and preserves shared/private neighbor resources",()=>{
  const db=database();try{
    job(db,"job-a","a1");job(db,"job-b","b1");
    const removed=removeTour(db,"a1",3);
    assert.deepEqual(removed.files.sort(),["a.original.jpg","a.webp"]);
    assert.deepEqual(removed.tourIds,["a1"]);assert.deepEqual(removed.jobIds,["job-a"]);
    assert.equal(heartbeatJob(db,"job-a","worker",60,"matching"),false);
    assert.equal(heartbeatJob(db,"job-b","worker",60,"matching"),true);
    assert.equal(db.prepare("UPDATE tours SET payload='resurrect' WHERE id='a1'").run().changes,0);
    assert.equal(count(db,"projects"),2);assert.equal(count(db,"tours"),2);
    assert.equal(count(db,"leads"),2);assert.equal(count(db,"scene_originals"),1);
    assert.equal(db.prepare("SELECT file FROM assets WHERE id='shared-b'").get()!.file,"shared.webp");
    assert.throws(()=>removeTour(db,"a1",3),error=>error instanceof ManagementError&&error.status===404);
  }finally{db.close();}
});

test("project deletion cascades only that project, including optional branding and integration credentials",()=>{
  const db=database();try{
    db.exec(`CREATE TABLE project_brand_assets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),bytes BLOB);
      CREATE TABLE project_branding(project_id TEXT PRIMARY KEY REFERENCES projects(id),logo_asset_id TEXT REFERENCES project_brand_assets(id));
      CREATE TABLE integration_keys(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id));
      INSERT INTO project_brand_assets VALUES('logo-a','a',X'01'),('logo-b','b',X'02');
      INSERT INTO project_branding VALUES('a','logo-a'),('b','logo-b');
      INSERT INTO integration_keys VALUES('key-a','a'),('key-b','b');`);
    job(db,"job-a","a1");job(db,"job-a2","a2");job(db,"job-b","b1");
    const removed=removeProject(db,"a","Project A");
    assert.deepEqual(removed.files.sort(),["a.original.jpg","a.webp","a2.webp"]);
    assert.deepEqual(removed.tourIds,["a1","a2"]);assert.deepEqual(removed.jobIds,["job-a","job-a2"]);
    assert.equal(readProject(db,"a"),null);assert.ok(readProject(db,"b"));
    for(const table of ["projects","tours","leads","scene_originals","project_brand_assets","project_branding","integration_keys","processing_jobs"])assert.equal(count(db,table),1,table);
    assert.equal(db.prepare("SELECT id FROM integration_keys").get()!.id,"key-b");
    assert.equal(heartbeatJob(db,"job-a","worker",80,"writing"),false);
    assert.equal(heartbeatJob(db,"job-b","worker",80,"writing"),true);
  }finally{db.close();}
});

test("deleting a project works before optional feature tables have ever been created",()=>{
  const db=database();try{
    const removed=removeProject(db,"a","Project A");
    assert.equal(removed.jobIds.length,0);assert.equal(count(db,"tours"),1);
  }finally{db.close();}
});

test("an unexpected dependent row rolls the entire deletion back including worker cancellation",()=>{
  const db=database();try{
    job(db,"job-a","a1");
    db.exec("CREATE TABLE external_dependency(project_id TEXT REFERENCES projects(id)); INSERT INTO external_dependency VALUES('a');");
    assert.throws(()=>removeProject(db,"a","Project A"),/FOREIGN KEY/);
    assert.equal(count(db,"tours"),3);assert.equal(count(db,"assets"),5);assert.equal(count(db,"leads"),3);
    assert.equal(heartbeatJob(db,"job-a","worker",20,"matching"),true);assert.ok(readProject(db,"a"));
  }finally{db.close();}
});
