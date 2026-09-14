import test from "node:test";
import assert from "node:assert/strict";
import {syntheticTour} from "./fixtures/imo3d-synthetic-tour";
import * as THREE from "three";
import type {Plan,Scene} from "../src/lib/imo3d/model";
import {buildFloorPlan3D,floorPlan3DDisplay,floorPlan3DFitDistance} from "../src/components/imo3d/floorplan3d-geometry";
import {initialRoomSemantic} from "../src/lib/imo3d/room-semantics";

const scene=(id:string,x:number,z:number,links:string[]=[]):Scene=>({id,name:id,room:id,sourceName:id,image:"/imo3d/example/a.webp",preview:"/imo3d/example/a.webp",thumbnail:"/imo3d/example/a.webp",position:{x,y:1.6,z},yaw:0,floor:0,links});
const plan:Plan={floor:0,label:"Floor",kind:"geometry",bounds:{minX:0,minZ:0,maxX:10,maxZ:10},walls:[{a:{x:80,z:4},b:{x:84,z:4}},{a:{x:84,z:4},b:{x:84,z:8}}]};
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test("3D room labels open an observed interior capture rather than the first doorway photograph",()=>{
  const semantic={...initialRoomSemantic("bed"),kind:"bedroom" as const};
  const doorway={...scene("door",1,1),room:"غرفة النوم",roomSemantic:{...semantic,observedKind:"corridor" as const,observedConfidence:.9}};
  const interior={...scene("bed",2,2),room:"غرفة النوم",roomSemantic:{...semantic,observedKind:"bedroom" as const,observedConfidence:.9}};
  const unplaced={...interior,id:"unplaced",position:null,roomSemantic:{...interior.roomSemantic,observedConfidence:1}};
  const outline=[{x:0,z:0},{x:3,z:0},{x:3,z:3},{x:0,z:3}];
  const result=buildFloorPlan3D({...plan,kind:"estimated",generatedRooms:[{id:semantic.groupId,name:"غرفة النوم",outline,finish:"stone",openings:[]}]},[doorway,interior,unplaced],"relative");
  assert.equal(result.rooms[0].sceneId,"bed");assert.equal(result.rooms[0].positioned,true);
});

test("synthetic 3D geometry remains in world coordinates rather than drawing pixels",()=>{
  const example=syntheticTour(),result=buildFloorPlan3D(example.plans[0],example.scenes,"metric");
  assert.equal(result.cameras.length,6);assert.equal(result.walls.length,4);assert.equal(result.estimatedSurfaces.length,0);
  close(result.width,8);close(result.depth,6);close(result.origin.x,4);close(result.origin.z,3);
  for(const point of result.cameras){const source=example.scenes.find(scene=>scene.id===point.id)!;close(point.point.x+result.origin.x,source.position!.x);close(point.point.z+result.origin.z,source.position!.z);}
  for(const wall of result.walls)assert.ok(example.plans[0].walls.some(source=>Math.abs(source.a.x-(wall.a.x+result.origin.x))<1e-8&&Math.abs(source.a.z-(wall.a.z+result.origin.z))<1e-8&&Math.abs(source.b.x-(wall.b.x+result.origin.x))<1e-8&&Math.abs(source.b.z-(wall.b.z+result.origin.z))<1e-8));
});

test("unknown or estimated geometry never becomes a confirmed architectural shell",()=>{
  const unpositioned={...scene("manual",0,0),position:null,manualLinks:[{targetId:"other",yaw:20}],links:["other"]};
  const empty=buildFloorPlan3D({...plan,kind:"path",walls:[]},[unpositioned]);
  assert.equal(empty.walls.length,0);assert.equal(empty.cameras.length,0);assert.equal(empty.links.length,0);assert.equal(empty.rooms[0].positioned,false);
  const estimated=buildFloorPlan3D({...plan,kind:"estimated",estimatedSurfaces:[{a:{x:81,z:5},b:{x:82,z:6},confidence:.5,supportPoints:15,kind:"vertical_surface",classification:"unverified"}]},[scene("a",81,5)],"relative");
  assert.equal(estimated.walls.length,0);assert.equal(estimated.estimatedSurfaces.length,3);assert.ok(estimated.estimatedSurfaces.every(surface=>surface.estimated));assert.equal(estimated.metric,false);
});

test("segments are deduplicated without extending openings or modifying their source",()=>{
  const original=structuredClone(plan),duplicate={...plan,walls:[...plan.walls,{a:plan.walls[0].b,b:plan.walls[0].a},{a:{x:82,z:6},b:{x:82,z:6}},{a:{x:NaN,z:0},b:{x:1,z:1}}]};
  const result=buildFloorPlan3D(duplicate,[]);
  assert.equal(result.walls.length,2);assert.deepEqual(plan,original);
  close(result.walls[0].length,4);close(result.walls[1].length,4);close(Math.abs(Math.cos(result.walls[0].angle)),1);close(result.walls[1].angle,-Math.PI/2);
});

test("camera paths require reciprocal same-floor unblocked links and room labels use real captures",()=>{
  const a={...scene("a",80,4,["b","c","d"]),room:"Room",manualLinks:[{targetId:"b",yaw:90}]};
  const b={...scene("b",81,4,["a"]),room:"Room"};
  const c={...scene("c",82,4,["a"]),blockedLinks:["a"]},d={...scene("d",0,0,["a"]),floor:1};
  const result=buildFloorPlan3D(plan,[a,b,c,d]);
  assert.equal(result.cameras.length,3);assert.equal(result.links.length,1);assert.equal(result.links[0].manual,true);
  assert.equal(result.links[0].from,"a");assert.equal(result.links[0].to,"b");
  assert.ok([a.id,b.id].includes(result.rooms.find(room=>room.name==="Room")!.sceneId));
  assert.equal(result.rooms.some(room=>room.sceneId===d.id),false);
});

test("3D room destinations retain semantic identities when their displayed names match",()=>{
  const a={...scene("a",1,1),room:"غرفة النوم",roomSemantic:initialRoomSemantic("first")};
  const b={...scene("b",2,1),room:"غرفة النوم",roomSemantic:initialRoomSemantic("second")};
  const c={...scene("c",3,1),room:"غرفة النوم",roomSemantic:initialRoomSemantic("first")};
  const layout=buildFloorPlan3D(plan,[a,b,c]);
  assert.equal(layout.rooms.length,2);assert.equal(new Set(layout.rooms.map(room=>room.id)).size,2);
  assert.equal(layout.rooms.find(room=>room.id.includes("second"))?.sceneId,"b");
});

test("dense depth contours have a bounded rendering budget while retaining true segment endpoints",()=>{
  const walls=Array.from({length:20000},(_,index)=>({a:{x:index*.01,z:0},b:{x:index*.01,z:1}}));
  const result=buildFloorPlan3D({...plan,kind:"depth",walls},[]);
  assert.equal(result.truncated,true);assert.equal(result.walls.length,6000);
  for(const wall of result.walls){close(wall.length,1);close(wall.a.x,wall.b.x);}
});

test("presentation heights remain illustrative and portrait view fits the full plan",()=>{
  const metric=buildFloorPlan3D(plan,[scene("a",82,5)],"metric"),relative=buildFloorPlan3D(plan,[scene("a",82,5)],"relative");
  close(floorPlan3DDisplay(metric).height,1.05);close(floorPlan3DDisplay(metric,false).height,2.45);
  assert.equal(relative.metric,false);assert.notEqual(floorPlan3DDisplay(relative).height,1.05);
  assert.ok(floorPlan3DFitDistance(8,12,2.45,.55)>floorPlan3DFitDistance(8,12,2.45,1.8));
  for(const aspect of [0,.4,1,3])assert.ok(Number.isFinite(floorPlan3DFitDistance(0,0,0,aspect)));
});

test("tight camera framing preserves all box corners in landscape, portrait and top views",()=>{
  const width=8,depth=12,height=1.05;
  for(const aspect of [592/460,390/360,.5,2.2])for(const top of [false,true]){
    const camera=new THREE.PerspectiveCamera(42,aspect,.01,1000),target=new THREE.Vector3(0,height*.12,0);
    const direction=top?new THREE.Vector3(0,1,.001):new THREE.Vector3(.85,1.1,1.05).normalize();
    camera.position.copy(target).addScaledVector(direction,floorPlan3DFitDistance(width,depth,height,aspect,42,top));camera.lookAt(target);camera.updateMatrixWorld();
    for(const x of [-width/2,width/2])for(const y of [0,height])for(const z of [-depth/2,depth/2]){
      const point=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(point.x)<.94&&Math.abs(point.y)<.94,`cropped corner for aspect ${aspect}, top ${top}`);
    }
  }
  const oldSphereDistance=Math.hypot(width,depth,height)/2/Math.sin(21*Math.PI/180)*1.13;
  assert.ok(floorPlan3DFitDistance(width,depth,height,592/460)<oldSphereDistance*.9);
});
