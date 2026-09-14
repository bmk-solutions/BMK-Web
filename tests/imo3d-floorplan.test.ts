import test from "node:test";
import assert from "node:assert/strict";
import {syntheticPlanPoint,syntheticTour} from "./fixtures/imo3d-synthetic-tour";
import type {Plan,Scene} from "../src/lib/imo3d/model";
import {floorPlanPoints,floorPlanProjection,floorPlanRoomLabels,floorPlanRooms,floorPlanViewport,nearestPlanLocation} from "../src/components/imo3d/floorplan-geometry";
import {roomChoices} from "../src/components/imo3d/room-labels";
import {initialRoomSemantic} from "../src/lib/imo3d/room-semantics";

const example=syntheticTour();
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} ≠ ${expected}`);

test("clicking between capture markers chooses the nearest available point on this floor",()=>{
  const base=example.scenes[0],plan:Plan={floor:0,label:"map",kind:"path",walls:[],bounds:{minX:10,minZ:20,maxX:20,maxZ:30}};
  const scenes:Scene[]=[{...base,id:"left",position:{x:12,y:1,z:23},floor:0},{...base,id:"right",position:{x:18,y:1,z:23},floor:0},{...base,id:"other-floor",position:{x:15.9,y:1,z:23},floor:1},{...base,id:"unplaced",position:null,floor:0}];
  const points=floorPlanPoints(plan,scenes).map(item=>({id:item.scene.id,point:item.point}));
  assert.equal(nearestPlanLocation(points,{x:5.9,y:3}),"right");
  assert.equal(nearestPlanLocation(points,{x:2.1,y:9}),"left");
  assert.equal(nearestPlanLocation([],{x:2,y:3}),null);
  assert.equal(nearestPlanLocation(points,{x:NaN,y:3}),null);
});

test("nearest click uses registered drawing pixels rather than untransformed camera coordinates",()=>{
  const points=floorPlanPoints(example.plans[0],example.scenes).map(item=>({id:item.scene.id,point:item.point}));
  for(const point of points)assert.equal(nearestPlanLocation(points,point.point),point.id);
});

test("equal user names keep separate semantic rooms while legacy room grouping is preserved",()=>{
  const base=example.scenes[0],plan:Plan={floor:0,label:"map",kind:"path",walls:[],bounds:{minX:0,minZ:0,maxX:10,maxZ:10}};
  const semantic=(id:string)=>({...initialRoomSemantic(id),nameSource:"user" as const});
  const scenes:Scene[]=[
    {...base,id:"a",floor:0,room:"غرفة النوم",position:{x:1,y:1,z:1},roomSemantic:semantic("first")},
    {...base,id:"b",floor:0,room:"غرفة النوم",position:{x:2,y:1,z:1},roomSemantic:semantic("first")},
    {...base,id:"c",floor:0,room:"غرفة النوم",position:{x:7,y:1,z:1},roomSemantic:semantic("second")},
    {...base,id:"d",floor:0,room:"غرفة النوم",position:{x:8,y:1,z:1},roomSemantic:undefined},
    {...base,id:"e",floor:0,room:"غرفة النوم",position:{x:9,y:1,z:1},roomSemantic:undefined},
    {...base,id:"upper",floor:1,room:"غرفة النوم",position:{x:1,y:1,z:1},roomSemantic:semantic("first")},
  ];
  const choices=roomChoices(scenes,0),rooms=floorPlanRooms(floorPlanPoints(plan,scenes));
  assert.equal(choices.length,3);assert.deepEqual(choices.map(choice=>choice.count),[2,1,2]);
  assert.equal(new Set(choices.map(choice=>choice.id)).size,3);
  assert.equal(rooms.length,3);assert.equal(new Set(rooms.map(room=>room.id)).size,3);
  assert.ok(rooms.every(room=>room.scene.floor===0));
  assert.ok(choices.every(choice=>choice.scene.id!=="upper"));
});

test("rendering shell walls project onto the synthetic registered drawing",()=>{
  const plan=example.plans[0],projection=floorPlanProjection(plan,example.scenes)!;
  for(const wall of plan.walls){
    const a=projection.project({...wall.a,y:0}),b=projection.project({...wall.b,y:0});
    const expectedA=syntheticPlanPoint(wall.a),expectedB=syntheticPlanPoint(wall.b);
    near(a.x,expectedA.x);near(a.y,expectedA.y);near(b.x,expectedB.x);near(b.y,expectedB.y);
  }
});

test("calibrated floor-plan marker agrees with every camera and keeps the correct heading sign",()=>{
  const plan=example.plans[0],projection=floorPlanProjection(plan,example.scenes);
  assert.ok(projection);
  for(const scene of example.scenes){
    const actual=projection.project(scene.position!),expected=plan.scenePoints![scene.id];
    near(actual.x,expected.x);near(actual.y,expected.y);
  }
  near(projection.heading(0),30);near(projection.heading(Math.PI/2),120);
  const [first,second]=example.scenes;
  const actual=projection.project({x:(first.position!.x+second.position!.x)/2,y:1.6,z:(first.position!.z+second.position!.z)/2});
  near(actual.x,(plan.scenePoints![first.id].x+plan.scenePoints![second.id].x)/2);
  near(actual.y,(plan.scenePoints![first.id].y+plan.scenePoints![second.id].y)/2);
});

test("unknown source maps preserve the full canvas and all synthetic wall endpoints",()=>{
  const plan=example.plans[0],viewport=floorPlanViewport(plan);
  assert.ok(viewport.x<=0&&viewport.y<=0&&viewport.width>=plan.width!&&viewport.height>=plan.height!);
  for(const wall of plan.walls)for(const endpoint of [wall.a,wall.b]){
    const point=syntheticPlanPoint(endpoint);
    assert.ok(point.x>=viewport.x&&point.x<=viewport.x+viewport.width);
    assert.ok(point.y>=viewport.y&&point.y<=viewport.y+viewport.height);
  }
});

test("unregistered source drawings never place world coordinates directly into pixel space",()=>{
  const plan={...example.plans[0],scenePoints:undefined};
  assert.deepEqual(floorPlanPoints(plan,example.scenes),[]);
  assert.equal(floorPlanProjection(plan,example.scenes),null);
});

test("degenerate or inconsistent calibration cannot animate an invented map position",()=>{
  const plan=example.plans[0];
  assert.equal(floorPlanProjection(plan,example.scenes.slice(0,2)),null);
  const shifted={...plan,scenePoints:{...plan.scenePoints,[example.scenes[0].id]:{x:10000,y:10000}}};
  assert.equal(floorPlanProjection(shifted,example.scenes),null);
});

test("heading projection supports drawings whose vertical axis is flipped",()=>{
  const scenes=example.scenes.slice(0,3).map((scene,index)=>({...scene,position:{x:index===1?1:0,y:1.6,z:index===2?1:0}})) as Scene[];
  const plan:Plan={floor:0,label:"test",kind:"geometry",image:"/api/imo3d/assets/test.svg",walls:[],width:100,height:100,bounds:{minX:0,minZ:0,maxX:100,maxZ:100},scenePoints:Object.fromEntries(scenes.map(scene=>[scene.id,{x:50+scene.position!.x*10,y:50-scene.position!.z*10}]))};
  const projection=floorPlanProjection(plan,scenes);assert.ok(projection);
  near(Math.abs(projection.heading(0)),180);near(projection.heading(Math.PI/2),90);
});

test("room labels use existing capture locations and respect the chosen floor",()=>{
  const points=floorPlanPoints(example.plans[0],example.scenes),rooms=floorPlanRooms(points);
  assert.equal(rooms.length,new Set(example.scenes.map(scene=>scene.room)).size);
  for(const room of rooms)assert.ok(points.some(point=>point.scene.id===room.scene.id&&point.scene.room===room.name&&point.point===room.point));
  assert.deepEqual(floorPlanPoints({...example.plans[0],floor:12},example.scenes),[]);
});

test("the apartment room labels stay separated and inside the measured drawing",()=>{
  const plan=example.plans[0],viewport=floorPlanViewport(plan),rooms=floorPlanRooms(floorPlanPoints(plan,example.scenes));
  for(const compact of [false,true]){
    const labels=floorPlanRoomLabels(rooms.filter(room=>!compact||!/حمام|ممر|المدخل/.test(room.name)),viewport.height/(compact?280:500),viewport);
    for(const [index,label] of labels.entries()){
      assert.ok(label.label.x-label.width/2>=viewport.x&&label.label.x+label.width/2<=viewport.x+viewport.width);
      assert.ok(label.label.y-label.height/2>=viewport.y&&label.label.y+label.height/2<=viewport.y+viewport.height);
      for(const other of labels.slice(index+1))assert.ok(Math.abs(label.label.x-other.label.x)>=(label.width+other.width)/2||Math.abs(label.label.y-other.label.y)>=(label.height+other.height)/2,`${label.name} overlaps ${other.name}`);
    }
  }
});
