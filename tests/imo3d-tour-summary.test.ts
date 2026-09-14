import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import type { Scene, Tour } from "../src/lib/imo3d/model";
import { db, getTour, newProject, newTour, saveTour, tours, toursSummary } from "../src/lib/imo3d/store";

const workspace=path.resolve("work/imo3d-tour-summary-tests");
mkdirSync(workspace,{recursive:true});
const directory=mkdtempSync(path.join(workspace,"database-"));
process.env.IMO3D_DATA_DIR=directory;
after(()=>{
  db().close();
  for(const suffix of ["","-wal","-shm"])rmSync(path.join(directory,`imo3d.sqlite${suffix}`),{force:true});
  rmdirSync(directory);
});

function populatedTour(projectId:string):Tour {
  const empty=newTour(projectId,"شقة بعمق كثيف"),scene:Scene={
    id:`scene-${empty.id}`,name:"غرفة",room:"المطبخ",floor:2,image:"/api/imo3d/assets/full-image",
    preview:"/api/imo3d/assets/preview",thumbnail:"/api/imo3d/assets/thumbnail",sourceName:"panorama.jpg",
    position:{x:3,y:1.6,z:4},yaw:72,links:[],manualLinks:[],blockedLinks:[],
    depth:{width:512,height:512,values:Array(512*512).fill(8.125)},
    displayDepth:{width:128,height:64,values:Array(8192).fill(2.125),confidence:.8,coverage:1,source:"monocular-multiview-floor-aligned",units:"camera_height",purpose:"display_only"},
  };
  return saveTour({...empty,published:true,scenes:[scene],initialView:{yaw:11,pitch:4},spatialSource:"calibrated",spatialScale:"metric",
    plans:[{floor:2,label:"الدور الثاني",kind:"depth",bounds:{minX:0,minZ:0,maxX:5,maxZ:6},walls:[{a:{x:0,z:0},b:{x:5,z:0}}]}],
    unit:{code:"A2",area:90,price:500000,bedrooms:2,bathrooms:1},quality:{positioned:1,depthScenes:1,components:1,warnings:["مراجعة"]}},empty.revision);
}
const withoutDepth=(value:Tour)=>({...value,scenes:value.scenes.map(scene=>{const copy={...scene};delete copy.depth;delete copy.displayDepth;return copy;})});

test("SQL summaries preserve list metadata, exclude both depth arrays, and retain full tour data",()=>{
  const project=newProject("ملخصات",""),full=populatedTour(project.id),empty=newTour(project.id,"جولة فارغة");
  const rawBefore=String(db().prepare("SELECT payload FROM tours WHERE id=?").get(full.id)!.payload);
  const summaries=toursSummary(project.id);
  assert.deepEqual(summaries,[withoutDepth(full),withoutDepth(empty)]);
  assert.equal(JSON.stringify(summaries).includes('"depth":'),false);
  assert.equal(JSON.stringify(summaries).includes('"displayDepth":'),false);
  assert.ok(JSON.stringify(summaries).length<rawBefore.length/100);
  assert.deepEqual(getTour(full.id),full);
  assert.deepEqual(tours(project.id),[full,empty]);
  assert.equal(db().prepare("SELECT payload FROM tours WHERE id=?").get(full.id)!.payload,rawBefore);
});

test("only summaries cross JSON.parse and project scope excludes foreign payloads before decoding",()=>{
  const selected=newProject("المسموح",""),foreign=newProject("خارج النطاق",""),full=populatedTour(selected.id);
  // A foreign legacy/corrupt row must not even enter SQLite JSON extraction.
  db().prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run("foreign-invalid",foreign.id,1,0,"not-json");
  const originalParse=JSON.parse,decoded:string[]=[];
  JSON.parse=function(text:string,reviver?:Parameters<typeof JSON.parse>[1]){
    decoded.push(text);assert.ok(text.length<10000);assert.equal(text.includes('"depth":'),false);assert.equal(text.includes('"displayDepth":'),false);
    return originalParse(text,reviver);
  };
  try {assert.deepEqual(toursSummary(selected.id),[withoutDepth(full)]);}
  finally {JSON.parse=originalParse;db().prepare("DELETE FROM tours WHERE id=?").run("foreign-invalid");}
  assert.equal(decoded.length,1);
  assert.deepEqual(toursSummary(""),[]);
  assert.deepEqual(toursSummary("unknown-project"),[]);
});

test("unscoped summary listing retains every valid project and ordinary scope is exact",()=>{
  const a=newProject("أ",""),b=newProject("ب",""),first=newTour(a.id,"أول"),second=newTour(b.id,"ثانٍ");
  assert.deepEqual(toursSummary(a.id),[first]);
  assert.deepEqual(toursSummary(b.id),[second]);
  assert.deepEqual(toursSummary(),tours().map(withoutDepth));
});
