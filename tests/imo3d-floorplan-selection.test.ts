import test from "node:test";
import assert from "node:assert/strict";
import {roomContainsPlanPoint,selectFloorPlanCapture,type PlanSelectionCapture,type PlanSelectionRoom} from "../src/components/imo3d/floorplan-selection";

const room=(id:string,left:number,right:number):PlanSelectionRoom=>({id,outline:[{x:left,z:-1},{x:right,z:-1},{x:right,z:1},{x:left,z:1}]});
const capture=(id:string,roomId:string|undefined,x:number,z=0):PlanSelectionCapture=>({id,roomId,point:{x,z}});

test("a click inside the bathroom opens its own capture even when a bedroom camera is closer",()=>{
  const rooms=[room("bathroom",-2,0),room("bedroom",0,2)];
  const captures=[capture("bath", "bathroom",-1.8),capture("bed", "bedroom",.01)];
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:-.02,z:0}),"bath");
  // A large invisible neighboring marker must not override an unambiguous room.
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:-.02,z:0},{hitCaptureId:"bed"}),"bath");
});

test("the nearest photograph within the selected physical room is used",()=>{
  const captures=[capture("left","one",-1.7),capture("right","one",-.4),capture("neighbor","two",.01)];
  assert.equal(selectFloorPlanCapture(captures,[room("one",-2,0)],{x:-.1,z:0}),"right");
  assert.equal(selectFloorPlanCapture(captures,[room("one",-2,0)],{x:-1.4,z:0}),"left");
});

test("concave room cutouts remain outside the room",()=>{
  const shape:PlanSelectionRoom={id:"L",outline:[{x:0,z:0},{x:3,z:0},{x:3,z:1},{x:1,z:1},{x:1,z:3},{x:0,z:3}]};
  const captures=[capture("inside","L",.2,2.5),capture("cutout","other",1.05,2.5)];
  assert.equal(roomContainsPlanPoint({x:.9,z:2.5},shape.outline),true);
  assert.equal(roomContainsPlanPoint({x:2,z:2},shape.outline),false);
  assert.equal(selectFloorPlanCapture(captures,[shape],{x:.9,z:2.5}),"inside");
  assert.equal(selectFloorPlanCapture(captures,[shape],{x:2,z:2}),"cutout");
});

test("explicit polygon and capture hits disambiguate a shared boundary",()=>{
  const rooms=[room("left",-2,0),room("right",0,2)],captures=[capture("a","left",-1),capture("b","right",1)];
  assert.ok(rooms.every(value=>roomContainsPlanPoint({x:0,z:0},value.outline)));
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{roomId:"right"}),"b");
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{hitCaptureId:"b"}),"b");
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{roomId:"left",hitCaptureId:"b"}),"a");
});

test("overlapping outlines honor the 2D room hit or actual 3D capture hit",()=>{
  const rooms=[room("first",-2,1),room("second",-1,2)],captures=[capture("a","first",-1.5),capture("b","second",.1)];
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{roomId:"first"}),"a");
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{hitCaptureId:"b"}),"b");
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:0,z:0},{hitCaptureId:"a"}),"a");
});

test("an authored room without semantic grouping uses photographs inside its outline",()=>{
  const rooms=[room("authored",-2,0)],captures=[capture("inside",undefined,-1),capture("near-outside",undefined,.01)];
  assert.equal(selectFloorPlanCapture(captures,rooms,{x:-.05,z:0}),"inside");
});

test("a known unplaced photograph still opens its room instead of a neighboring scene",()=>{
  const captures:PlanSelectionCapture[]=[{id:"unplaced",roomId:"one",point:null},capture("other","two",.1)];
  assert.equal(selectFloorPlanCapture(captures,[room("one",-2,0)],{x:-.1,z:0}),"unplaced");
});

test("empty room and outside-map clicks retain bounded nearest-location fallback",()=>{
  const captures=[capture("left","other",-3),capture("right","other",3)];
  assert.equal(selectFloorPlanCapture(captures,[room("empty",-1,1)],{x:.4,z:0}),"right");
  assert.equal(selectFloorPlanCapture(captures,[room("empty",-1,1)],{x:-100,z:0}),"left");
  assert.equal(selectFloorPlanCapture(captures,[],{x:100,z:0},{hitCaptureId:"left"}),"left");
  assert.equal(selectFloorPlanCapture([],[],{x:0,z:0}),null);
});

test("direct room selection has no maximum distance or required intermediate captures",()=>{
  const captures=[capture("remote","far",1000),capture("near","other",0)];
  assert.equal(selectFloorPlanCapture(captures,[room("far",999,1001)],{x:1000,z:0},{roomId:"far"}),"remote");
});

test("invalid targets and coordinates never enter nearest-distance arithmetic",()=>{
  const captures=[capture("invalid","other",NaN),capture("good","other",2)];
  assert.equal(selectFloorPlanCapture(captures,[],{x:NaN,z:0}),null);
  assert.equal(selectFloorPlanCapture(captures,[],{x:0,z:Infinity}),null);
  assert.equal(selectFloorPlanCapture(captures,[],{x:0,z:0},{roomId:"missing",hitCaptureId:"missing"}),"good");
});
