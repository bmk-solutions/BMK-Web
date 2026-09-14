import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import type {PlanRoom,Tour} from "../src/lib/imo3d/model";
import {apartmentWalls,planFromRooms,roomWalls,validateRoom} from "../src/lib/imo3d/boundary-shapes";
import {applySceneFloorAssignments,saveTourMetadata,tourMetadataSchema} from "../src/lib/imo3d/floor-assignment";
import {AuthoredPlanCalibrationError,mergeTourSpatial} from "../src/lib/imo3d/tour-merge";
import {boundarySchema,saveFloorBoundaries} from "../src/lib/imo3d/floor-boundaries";
import {claimJob,enqueueJob,imageFingerprint,latestJob} from "../src/lib/imo3d/processing-jobs";
import {initialRoomSemantic} from "../src/lib/imo3d/room-semantics";
import {buildFloorPlan3D} from "../src/components/imo3d/floorplan3d-geometry";
import {planHasMetricScale} from "../src/lib/imo3d/measurement";
const room=(id="77fbf542-2b74-4a8b-8514-25af7cf081fc",width=4):PlanRoom=>({id,name:"المطبخ",outline:[{x:0,z:0},{x:width,z:0},{x:width,z:3},{x:0,z:3}],finish:"tile",openings:[1]});
const makeTour=(id:string):Tour=>({id,projectId:"project-"+id,title:id,revision:1,published:false,createdAt:"2026-01-01",updatedAt:"2026-01-01",scenes:[{id:"scene-"+id,name:"المطبخ",room:"المطبخ",sourceName:"source.jpg",image:"/api/imo3d/assets/a",preview:"/api/imo3d/assets/b",thumbnail:"/api/imo3d/assets/c",floor:0,position:{x:1,y:1.6,z:1},yaw:0,links:[]}],plans:[],quality:{positioned:1,depthScenes:0,components:1,warnings:[]},unit:{code:"",area:null,price:null,bedrooms:null,bathrooms:null}});
test("apartment boundary polygons reject crossings, zero area and invalid openings",()=>{
  assert.doesNotThrow(()=>validateRoom(room()));
  assert.throws(()=>validateRoom({...room(),outline:[{x:0,z:0},{x:3,z:3},{x:3,z:0},{x:0,z:3}]}));
  assert.throws(()=>validateRoom({...room(),outline:[{x:0,z:0},{x:1,z:0},{x:2,z:0}]}));
  assert.throws(()=>validateRoom({...room(),openings:[8]}));
  assert.equal(boundarySchema.safeParse({revision:1,floor:0,rooms:[{...room(),outline:[{x:Infinity,z:0}]}]}).success,false);
});
test("room openings leave real gaps; 2D and 3D share saved vertices without changing relative scale",()=>{
  const value=room(),walls=roomWalls(value);assert.equal(walls.length,5);
  assert.ok(walls.filter(wall=>wall.a.x===4&&wall.b.x===4).every(wall=>Math.min(wall.a.z,wall.b.z)>=1.86-1e-10||Math.max(wall.a.z,wall.b.z)<=1.14+1e-10));
  const plan=planFromRooms(undefined,[value],0),layout=buildFloorPlan3D(plan,makeTour("a").scenes);
  assert.equal(planHasMetricScale(plan,undefined,true),false);assert.equal(layout.metric,false);
  assert.equal(layout.floorRooms?.[0].outline.length,4);assert.equal(layout.walls.length,5);
  assert.deepEqual(layout.floorRooms?.[0].outline.map(p=>({x:p.x+layout.origin.x,z:p.z+layout.origin.z})),value.outline);
});

test("inferred door aperture retains its observed offset across both shared walls",()=>{
  const first={...room(),openings:[],doorwayCandidates:[{edge:1,offset:.25,width:.2,confidence:.8,verified:false as const,pairedRoomId:"room-neighbor"}]};
  const neighbor:PlanRoom={...room("room-neighbor"),openings:[],outline:[{x:4,z:0},{x:7,z:0},{x:7,z:3},{x:4,z:3}]};
  validateRoom(first);const walls=apartmentWalls([first,neighbor]);
  for(const wall of walls.filter(w=>w.a.x===4&&w.b.x===4))assert.ok(Math.max(wall.a.z,wall.b.z)<=.45+1e-8||Math.min(wall.a.z,wall.b.z)>=1.05-1e-8);
  const parsed=boundarySchema.parse({revision:1,floor:0,rooms:[first]});assert.deepEqual(parsed.rooms[0].doorwayCandidates,first.doorwayCandidates);
  assert.throws(()=>validateRoom({...first,doorwayCandidates:[{...first.doorwayCandidates[0],edge:5}]}));
  assert.throws(()=>validateRoom({...first,doorwayCandidates:[{...first.doorwayCandidates[0],offset:.95,width:.2}]}));
  assert.equal(boundarySchema.safeParse({revision:1,floor:0,rooms:[{...first,doorwayCandidates:[{...first.doorwayCandidates[0],verified:true}]}]}).success,false);
});
test("editing generated outlines retains semantic IDs and cannot promote their estimated scale",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("generated-edit"),generated=room("room-77fbf542-2b74-4a8b-8514-25af7cf081fc@floor0-split");
    original.plans=[{floor:0,label:"Ground",kind:"geometry",bounds:{minX:0,maxX:4,minZ:0,maxZ:3},walls:roomWalls(generated),generatedRooms:[generated],generatedFrom:{method:"camera-height-layout",confidence:.7,sceneIds:[original.scenes[0].id],scale:"camera_height"}}];
    database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(original.id,original.projectId,1,0,JSON.stringify(original));
    const input=boundarySchema.parse({revision:1,floor:0,rooms:[{...generated,name:"المطبخ المعدل"}]}),saved=saveFloorBoundaries(database,original.id,input);
    assert.equal(saved.plans[0].authoredRooms?.[0].id,generated.id);
    assert.equal(saved.plans[0].authoredRooms?.[0].name,"المطبخ المعدل");
    assert.equal(saved.plans[0].authoredScale,"relative");assert.equal(saved.plans[0].generatedRooms,undefined);
    assert.deepEqual(saved.scenes,original.scenes);
    for(const id of ["", "../room", "room/other", "room\nother", "a".repeat(161)])assert.equal(boundarySchema.safeParse({...input,rooms:[{...generated,id}]}).success,false);
  }finally{database.close();}
});

test("group and boundary renames synchronize both directions without touching unrelated floors, rooms or photos",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("name-sync"),groupId="room-primary";
    original.scenes[0].roomSemantic={...initialRoomSemantic("primary"),kind:"kitchen"};
    original.scenes.push({...original.scenes[0],id:"second-view"},{...original.scenes[0],id:"unrelated-room",name:"اسم خاص",room:"اسم خاص",roomSemantic:{...initialRoomSemantic("unrelated"),nameSource:"user"}},{...original.scenes[0],id:"upper-view",floor:1,roomSemantic:initialRoomSemantic("upper")});
    const kitchen=room(groupId),manual=room("manual-boundary");manual.name="اسم رسم مستقل";
    original.plans=[{floor:0,label:"Ground",kind:"estimated",bounds:{minX:0,maxX:4,minZ:0,maxZ:3},walls:roomWalls(kitchen),generatedRooms:[kitchen,manual],generatedFrom:{method:"camera-height-layout",confidence:.7,sceneIds:original.scenes.slice(0,2).map(scene=>scene.id),scale:"camera_height"}},planFromRooms(undefined,[{...room(groupId),name:"غرفة دور آخر"}],1)];
    const foreign={...original,id:"foreign-tour",projectId:"foreign-project"};
    for(const tour of [original,foreign])database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(tour.id,tour.projectId,tour.revision,0,JSON.stringify(tour));
    const hash=imageFingerprint(original.scenes);enqueueJob(database,original.id,hash);claimJob(database,"fixture-worker");
    const longName="م".repeat(100),named=saveTourMetadata(database,original.id,tourMetadataSchema.parse({revision:1,roomRenames:[{groupId,name:longName}]}));
    assert.equal(named.plans[0].generatedRooms?.[0].name,longName);assert.equal(named.plans[0].generatedRooms?.[1].name,manual.name);assert.equal(latestJob(database,original.id)?.status,"running");
    assert.deepEqual(named.plans[1],original.plans[1]);
    const boundary=saveFloorBoundaries(database,original.id,boundarySchema.parse({revision:2,floor:0,rooms:named.plans[0].generatedRooms!.map(room=>room.id===groupId?{...room,name:"مطبخ العائلة"}:room)}));
    assert.equal(boundary.plans[0].authoredRooms?.[0].name,"مطبخ العائلة");assert.equal(boundary.plans[0].authoredScale,"relative");
    assert.ok(boundary.scenes.slice(0,2).every(scene=>scene.room==="مطبخ العائلة"&&scene.name==="مطبخ العائلة"&&scene.roomSemantic?.nameSource==="user"));
    assert.deepEqual(boundary.scenes.slice(2),original.scenes.slice(2));assert.deepEqual(boundary.plans[1],original.plans[1]);assert.equal(imageFingerprint(boundary.scenes),hash);assert.equal(latestJob(database,original.id)?.status,"cancelled");
    const renamedAgain=saveTourMetadata(database,original.id,{revision:3,roomRenames:[{groupId,name:"المطبخ الجديد"}]});assert.equal(renamedAgain.plans[0].authoredRooms?.[0].name,"المطبخ الجديد");
    assert.deepEqual(renamedAgain.plans[0].authoredRooms?.[0].outline,kitchen.outline);assert.deepEqual(renamedAgain.plans[0].walls,boundary.plans[0].walls);
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(foreign.id)?.payload,JSON.stringify(foreign));
    for(let index=0;index<original.scenes.length;index++){const source=original.scenes[index],saved=renamedAgain.scenes[index];assert.equal(saved.sourceName,source.sourceName);assert.equal(saved.image,source.image);assert.equal(saved.preview,source.preview);assert.equal(saved.thumbnail,source.thumbnail);assert.deepEqual(saved.position,source.position);}
  }finally{database.close();}
});

test("a geometry-only save preserves authored names and refreshes generated labels without claiming naming ownership",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    for(const authored of [true,false]){
      const original=makeTour("geometry-name-"+authored),groupId="room-primary";original.scenes[0]={...original.scenes[0],room:"المطبخ المقترح",name:"المطبخ المقترح",roomSemantic:initialRoomSemantic("primary")};
      original.plans=[planFromRooms(undefined,[room(groupId)],0)];
      if(!authored){original.plans[0].generatedRooms=original.plans[0].authoredRooms;delete original.plans[0].authoredRooms;original.plans[0].generatedFrom={method:"layout",confidence:.7,sceneIds:[original.scenes[0].id],scale:"camera_height"};}
      database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(original.id,original.projectId,1,0,JSON.stringify(original));
      const saved=saveFloorBoundaries(database,original.id,{revision:1,floor:0,rooms:[room(groupId,5)]});
      assert.deepEqual(saved.scenes,original.scenes);assert.equal(saved.scenes[0].roomSemantic?.nameSource,"automatic");assert.equal(saved.plans[0].authoredRooms?.[0].name,authored?"المطبخ":"المطبخ المقترح");assert.equal(saved.plans[0].bounds.maxX,5);
    }
  }finally{database.close();}
});

test("boundary cancellation failure rolls synchronized semantic names and outlines back together",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("name-rollback"),groupId="room-primary";original.scenes[0].roomSemantic=initialRoomSemantic("primary");original.plans=[planFromRooms(undefined,[room(groupId)],0)];
    database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(original.id,original.projectId,1,0,JSON.stringify(original));enqueueJob(database,original.id,"fixture");
    database.exec("CREATE TRIGGER fail_name_cancellation BEFORE UPDATE ON processing_jobs BEGIN SELECT RAISE(ABORT,'cancel failed'); END");
    assert.throws(()=>saveFloorBoundaries(database,original.id,{revision:1,floor:0,rooms:[{...room(groupId,5),name:"اسم لم يُحفظ"}]}),/cancel failed/);
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload,JSON.stringify(original));assert.equal(database.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision,1);
  }finally{database.close();}
});
test("each apartment retains distinct boundaries; revisions and cancellation are atomic and scoped",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  for(const id of ["a","b"]){const value=makeTour(id);database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(id,value.projectId,1,0,JSON.stringify(value));enqueueJob(database,id,id);}
  const bBefore=database.prepare("SELECT payload FROM tours WHERE id='b'").get()?.payload;
  const a=saveFloorBoundaries(database,"a",{revision:1,floor:0,rooms:[room()]});
  assert.equal(a.plans[0].bounds.maxX,4);assert.equal(latestJob(database,"a")?.status,"cancelled");assert.equal(latestJob(database,"b")?.status,"queued");
  assert.equal(database.prepare("SELECT payload FROM tours WHERE id='b'").get()?.payload,bBefore);
  const b=saveFloorBoundaries(database,"b",{revision:1,floor:0,rooms:[room(undefined,8)]});assert.equal(b.plans[0].bounds.maxX,8);
  assert.throws(()=>saveFloorBoundaries(database,"a",{revision:1,floor:0,rooms:[room(undefined,9)]}),/تغيرت/);
  assert.equal(JSON.parse(String(database.prepare("SELECT payload FROM tours WHERE id='a'").get()?.payload)).plans[0].bounds.maxX,4);
  assert.throws(()=>saveFloorBoundaries(database,"a",{revision:2,floor:1,rooms:[room()]}),/الدور/);
  database.close();
});

test("a door on either side of a shared wall stays open for both rooms",()=>{
  const first=room(),second:PlanRoom={...room("77fbf542-2b74-4a8b-8514-25af7cf081fd"),outline:[{x:4,z:0},{x:8,z:0},{x:8,z:3},{x:4,z:3}],openings:[]};
  const before=structuredClone([first,second]),walls=apartmentWalls([first,second]);
  const shared=walls.filter(wall=>wall.a.x===4&&wall.b.x===4);
  assert.equal(shared.length,2);
  assert.ok(shared.every(wall=>Math.min(wall.a.z,wall.b.z)>=1.86-1e-10||Math.max(wall.a.z,wall.b.z)<=1.14+1e-10));
  assert.deepEqual([first,second],before);
  const reversed=apartmentWalls([{...first,openings:[]},{...second,openings:[3]}]);
  assert.equal(reversed.filter(wall=>wall.a.x===4&&wall.b.x===4).length,2);
  assert.ok(reversed.filter(wall=>wall.a.x===4&&wall.b.x===4).every(wall=>Math.min(wall.a.z,wall.b.z)>=1.86-1e-10||Math.max(wall.a.z,wall.b.z)<=1.14+1e-10));
});

test("different room edge lengths and rotated shared walls cannot refill a doorway",()=>{
  const first=room(),second:PlanRoom={...room("77fbf542-2b74-4a8b-8514-25af7cf081fd"),outline:[{x:4,z:.5},{x:8,z:.5},{x:8,z:2.5},{x:4,z:2.5}],openings:[]};
  const rotate=(p:{x:number;z:number})=>({x:(p.x-p.z)/Math.SQRT2+10,z:(p.x+p.z)/Math.SQRT2-7});
  const unrotate=(p:{x:number;z:number})=>({x:((p.x-10)+(p.z+7))/Math.SQRT2,z:((p.z+7)-(p.x-10))/Math.SQRT2});
  const walls=apartmentWalls([first,second].map(room=>({...room,outline:room.outline.map(rotate)}))).map(wall=>({a:unrotate(wall.a),b:unrotate(wall.b)}));
  const shared=walls.filter(wall=>Math.abs(wall.a.x-4)<1e-8&&Math.abs(wall.b.x-4)<1e-8);
  assert.ok(shared.length>=2);
  assert.ok(shared.every(wall=>Math.min(wall.a.z,wall.b.z)>=1.86-1e-8||Math.max(wall.a.z,wall.b.z)<=1.14+1e-8));
});

test("manual floor save keeps other floors and camera evidence intact and never promotes relative coordinates",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("relative");original.spatialSource="images";original.spatialScale="relative";
    const upper={...original.scenes[0],id:"upper",floor:1,position:null};original.scenes.push(upper);
    const previous=planFromRooms(undefined,[room()],0);previous.authoredScale="metric";
    original.plans=[previous,planFromRooms(undefined,[room(undefined,9)],1)];
    database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(original.id,original.projectId,1,0,JSON.stringify(original));
    const saved=saveFloorBoundaries(database,original.id,{revision:1,floor:0,rooms:[room(undefined,5)]});
    assert.deepEqual(saved.scenes,original.scenes);
    assert.deepEqual(saved.plans[1],original.plans[1]);
    assert.equal(saved.spatialScale,"relative");assert.equal(saved.spatialSource,"images");
    assert.equal(saved.plans[0].authoredScale,"relative");
    assert.equal(planHasMetricScale(saved.plans[0],saved.spatialScale,true),false);
    assert.equal(buildFloorPlan3D(saved.plans[0],saved.scenes,saved.spatialScale).metric,false);
  }finally{database.close();}
});

test("cancellation failure rolls boundary metadata and revision back together",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("rollback");database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(original.id,original.projectId,1,0,JSON.stringify(original));
    enqueueJob(database,original.id,"fixture");
    database.exec("CREATE TRIGGER fail_cancellation BEFORE UPDATE ON processing_jobs BEGIN SELECT RAISE(ABORT,'cancel failed'); END");
    assert.throws(()=>saveFloorBoundaries(database,original.id,{revision:1,floor:0,rooms:[room()]}),/cancel failed/);
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload,JSON.stringify(original));
    assert.equal(database.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision,1);
    assert.equal(latestJob(database,original.id)?.status,"queued");
  }finally{database.close();}
});

test("moving an unpositioned photo keeps the original floor's authored rooms without positioning it on the new floor",()=>{
  const original=makeTour("floor-change");original.scenes[0].position=null;
  original.scenes.push({...original.scenes[0],id:"stays"});
  original.plans=[planFromRooms(undefined,[room()],0)];
  const next=applySceneFloorAssignments(original,original.scenes.map(scene=>scene.id==="stays"?scene:{...scene,floor:1}));
  assert.deepEqual(next.plans.find(plan=>plan.floor===0),original.plans[0]);
  assert.equal(next.scenes.find(scene=>scene.id!=="stays")?.position,null);
  assert.equal(next.plans.find(plan=>plan.floor===1)?.authoredRooms,undefined);
});

test("clearing authored rooms restores only existing camera topology on that floor",()=>{
  const database=new DatabaseSync(":memory:");database.exec("CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  try{
    const original=makeTour("reset"),other=makeTour("unrelated");original.spatialScale="relative";
    original.scenes.push({...original.scenes[0],id:"upper",floor:1});
    original.plans=[planFromRooms(undefined,[room()],0),planFromRooms(undefined,[room(undefined,9)],1)];
    for(const tour of [original,other])database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(tour.id,tour.projectId,1,0,JSON.stringify(tour));
    enqueueJob(database,original.id,"fixture");
    const reset=saveFloorBoundaries(database,original.id,boundarySchema.parse({revision:1,floor:0,rooms:[]}));
    assert.equal(reset.plans[0].kind,"path");assert.deepEqual(reset.plans[0].walls,[]);
    assert.equal(reset.plans[0].authoredRooms,undefined);assert.equal(reset.plans[0].authoredScale,undefined);
    assert.deepEqual(reset.scenes,original.scenes);assert.deepEqual(reset.plans[1],original.plans[1]);
    assert.equal(reset.spatialScale,"relative");assert.equal(latestJob(database,original.id)?.status,"cancelled");
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(other.id)?.payload,JSON.stringify(other));
    assert.throws(()=>saveFloorBoundaries(database,original.id,{revision:1,floor:1,rooms:[]}),/تغيرت/);
    assert.throws(()=>saveFloorBoundaries(database,original.id,{revision:2,floor:0,rooms:[]}),/لا توجد حدود/);
    assert.equal(database.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision,2);
  }finally{database.close();}
});

test("camera recalibration rejects incompatible authored frames before changing input while same-frame yaw and depth remain usable",()=>{
  const original=makeTour("calibration");original.plans=[planFromRooms(undefined,[room()],0)];
  const before=structuredClone(original),camera=original.scenes[0];
  for(const next of [{...camera,position:{...camera.position!,x:10}},{...camera,floor:1},{...camera,position:null}]){
    assert.throws(()=>mergeTourSpatial(original,[next]),AuthoredPlanCalibrationError);
  }
  const updated=mergeTourSpatial(original,[{...camera,yaw:camera.yaw+35,depth:{width:8,height:4,values:Array(32).fill(3)}}]);
  assert.deepEqual(updated.plans[0],original.plans[0]);assert.equal(updated.scenes[0].yaw,35);
  const upload=mergeTourSpatial(original,[camera,{...camera,id:"new",position:null,links:[]}]);
  assert.deepEqual(upload.plans[0],original.plans[0]);
  assert.throws(()=>mergeTourSpatial(original,[camera,{...camera,id:"new",links:[]}]),AuthoredPlanCalibrationError);
  const upper={...camera,id:"upper-camera",floor:1};
  assert.throws(()=>mergeTourSpatial({...original,scenes:[camera,upper]},[camera,{...upper,floor:0}]),AuthoredPlanCalibrationError);
  assert.deepEqual(original,before);
  const cleared={...original,plans:[{floor:0,label:"Ground",kind:"path" as const,bounds:original.plans[0].bounds,walls:[]}]};
  assert.doesNotThrow(()=>mergeTourSpatial(cleared,[{...camera,position:{...camera.position!,x:10}}]));
});
