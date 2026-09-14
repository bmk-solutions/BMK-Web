import test from "node:test";
import assert from "node:assert/strict";
import type {Plan,PlanRoom} from "../src/lib/imo3d/model";
import {floorPlanDoorways} from "../src/components/imo3d/floorplan-doorways";
const room=(id="room-a",x=0):PlanRoom=>({id,name:id,outline:[{x,z:0},{x:x+4,z:0},{x:x+4,z:3},{x,z:3}],finish:"tile",openings:[]});
const plan=(rooms:PlanRoom[],authored=false):Plan=>({floor:0,label:"Floor",kind:"estimated",bounds:{minX:0,maxX:8,minZ:0,maxZ:3},walls:[],...(authored?{authoredRooms:rooms}:{generatedRooms:rooms,generatedFrom:{method:"image-layout",confidence:.7,sceneIds:[],scale:"camera_height" as const}})});
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test("door symbols preserve the observed offset and merge the reciprocal shared aperture once",()=>{
  const first={...room(),doorwayCandidates:[{edge:1,offset:.25,width:.2,confidence:.8,verified:false as const,pairedRoomId:"room-b"}]};
  const second={...room("room-b",4),doorwayCandidates:[{edge:3,offset:.75,width:.2,confidence:.75,verified:false as const,pairedRoomId:"room-a"}]};
  const source=plan([first,second]),before=structuredClone(source),doors=floorPlanDoorways(source);
  assert.equal(doors.length,1);close(doors[0].a.x,4);close(doors[0].b.x,4);close(doors[0].a.z,.45);close(doors[0].b.z,1.05);close(doors[0].length,.6);
  assert.equal(doors[0].source,"estimated");assert.equal(doors[0].confidence,.75);assert.deepEqual(new Set(doors[0].roomIds),new Set(["room-a","room-b"]));assert.deepEqual(source,before);
});
test("neighbouring rooms and unresolved wall-plane gaps do not invent connecting doors",()=>{
  assert.equal(floorPlanDoorways(plan([room(),room("room-b",4)])).length,0);
  const first={...room(),doorwayCandidates:[{edge:1,offset:.5,width:.2,confidence:.8,verified:false as const,pairedRoomId:"room-b"}]};
  const second={...room("room-b",4.2),doorwayCandidates:[{edge:3,offset:.5,width:.2,confidence:.8,verified:false as const,pairedRoomId:"room-a"}]};
  const doors=floorPlanDoorways(plan([first,second]));assert.equal(doors.length,2);assert.ok(doors.every(door=>Math.abs(door.a.x-door.b.x)<1e-8));
});
test("manual intervals keep their declared location while estimated extensions stay unverified",()=>{
  const manual={...room(),openings:[1]},base=floorPlanDoorways(plan([manual],true))[0];
  close(base.a.z,1.14);close(base.b.z,1.86);assert.equal(base.source,"manual");
  const candidate=(offset:number,width:number)=>({edge:1,offset,width,confidence:.6,verified:false as const,pairedRoomId:"room-b"});
  const covered=floorPlanDoorways(plan([{...manual,doorwayCandidates:[candidate(.5,.1)]}],true));assert.equal(covered.length,1);assert.equal(covered[0].source,"manual");
  const extended=floorPlanDoorways(plan([{...manual,doorwayCandidates:[candidate(.35,.4)]}],true));assert.equal(extended.length,1);close(extended[0].a.z,.45);close(extended[0].b.z,1.86);assert.equal(extended[0].source,"estimated");
  assert.equal(floorPlanDoorways(plan([manual]))[0].source,"estimated");
});
test("malformed aperture evidence cannot produce off-wall symbols",()=>{
  const invalid={...room(),openings:[-1,9],doorwayCandidates:[{edge:1,offset:.99,width:.2,confidence:.8,verified:false as const,pairedRoomId:"room-b"},{edge:1,offset:.5,width:NaN,confidence:.8,verified:false as const,pairedRoomId:"room-b"}]};
  assert.deepEqual(floorPlanDoorways(plan([invalid])),[]);
});
