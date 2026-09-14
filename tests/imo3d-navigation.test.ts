import assert from "node:assert/strict";
import test from "node:test";

import {cursorDirection,heldHeading,isMovementCode,manualArrivalYaw,navigationLink,navigationTransition,pickNavigationDirection,pointerDestination} from "../src/lib/imo3d/navigation";
import type {Scene} from "../src/lib/imo3d/model";
import {angleDifference,pickDirection,radians} from "../src/lib/imo3d/spatial";

const scene=(id:string,x:number,z:number,links:string[]=[]):Scene=>({id,name:id,sourceName:id,room:id,floor:0,yaw:0,position:{x,y:1.6,z},image:"/example.webp",preview:"/example.webp",thumbnail:"/example.webp",width:2048,height:1024,links} as Scene);
test("physical WASD, arrows and diagonals follow the current view",()=>{
  assert.equal(isMovementCode("KeyW"),true);assert.equal(isMovementCode("ض"),false);
  assert.equal(heldHeading(new Set(["KeyW"]),Math.PI/2),Math.PI/2);
  assert.equal(heldHeading(new Set(["ArrowLeft"]),Math.PI/2),0);
  assert.equal(heldHeading(new Set(["KeyW","KeyD"]),0),Math.PI/4);
  assert.equal(heldHeading(new Set(["KeyW","KeyS"]),0),null);
  assert.equal(heldHeading(new Set(),0),null);
});
test("pointer destination prioritizes links and rejects backward or upward ceiling clicks",()=>{
  const a=scene("a",0,0,["b"]),b=scene("b",0,-1,["a"]),wall=scene("behind-wall",0,-.5);
  assert.equal(pointerDestination([a,b,wall],"a",0,-.5)?.id,"b");
  assert.equal(pointerDestination([a,b,wall],"a",Math.PI,0),null);
  assert.equal(pointerDestination([a,b,wall],"a",0,1.2),null);
  assert.equal(pointerDestination([a,{...b,links:[]},wall],"a",0,-.5)?.id,"behind-wall");
});
test("cursor direction wraps at north without a reversed arrow",()=>{
  assert.equal(cursorDirection(0,0),"forward");assert.equal(cursorDirection(0,-1),"left");assert.equal(cursorDirection(0,1),"right");
  assert.equal(cursorDirection(Math.PI-.05,-Math.PI+.05),"forward");
});
test("synthetic eastward camera bearings map to the right panorama quarter",()=>{
  const a=scene("bearing-a",0,0),b=scene("bearing-b",2,0);
  const heading=Math.atan2(b.position!.x-a.position!.x,-(b.position!.z-a.position!.z));
  const u=.5+angleDifference(heading,radians(a.yaw))/(2*Math.PI);
  assert.ok(Math.abs(u-.75)<1e-8);
  assert.ok(Math.abs(angleDifference(heading,Math.PI/2))<1e-8);
});

test("manual bearings navigate unpositioned captures and override misleading coordinates",()=>{
  const a:Scene={...scene("a",0,0,["b"]),position:null,manualLinks:[{targetId:"b",yaw:90}]};
  const b:Scene={...scene("b",0,0,["a"]),position:null,manualLinks:[{targetId:"a",yaw:210}]};
  assert.equal(pickDirection([a,b],"a",Math.PI/2)?.id,"b");
  assert.equal(pointerDestination([a,b],"a",Math.PI/2,-.4)?.id,"b");
  assert.equal(pickDirection([a,b],"a",0),null);
  assert.equal(pickDirection([{...a,position:{x:0,y:1.6,z:0}},{...b,position:{x:0,y:1.6,z:-2}}],"a",Math.PI/2)?.id,"b");
  assert.equal(pickDirection([a,{...b,blockedLinks:["a"]}],"a",Math.PI/2),null);
  assert.equal(pickDirection([a,{...b,floor:1}],"a",Math.PI/2),null);
});

test("manual arrival matches reciprocal doorways and preserves the view's offset",()=>{
  const a:Scene={...scene("a",0,0,["b"]),manualLinks:[{targetId:"b",yaw:90}]};
  const b:Scene={...scene("b",0,0,["a"]),manualLinks:[{targetId:"a",yaw:210}]};
  assert.ok(Math.abs(angleDifference(manualArrivalYaw(a,b,radians(90))!,radians(30)))<1e-8);
  assert.ok(Math.abs(angleDifference(manualArrivalYaw(a,b,radians(105))!,radians(45)))<1e-8);
  // A shared calibrated compass needs no additional rotation on arrival.
  assert.ok(Math.abs(angleDifference(manualArrivalYaw(a,{...b,manualLinks:[{targetId:"a",yaw:270}]},radians(104))!,radians(104)))<1e-8);
  assert.equal(manualArrivalYaw(a,{...b,manualLinks:[]},0),undefined);
  assert.equal(manualArrivalYaw({...a,blockedLinks:["b"]},b,0),undefined);
  assert.equal(manualArrivalYaw(a,{...b,floor:1},0),undefined);
});

test("an unplaced synthetic starting pair remains navigable using a visual bearing",()=>{
  // Read-only fixture: the first pair has83 inliers, 0.041° residual and no
  // shared map position. Keeping that map position null must not disable S.
  const yaw=12,heading=yaw+175;
  const a:Scene={...scene("start",0,0,["next"]),position:null,yaw,visualLinks:[{targetId:"next",yaw:heading}]};
  const b:Scene={...scene("next",0,0,["start"]),position:null,yaw:28,visualLinks:[{targetId:"start",yaw:heading+180}]};
  assert.equal(pickNavigationDirection([a,b],a.id,heldHeading(new Set(["KeyS"]),radians(yaw))!)?.id,b.id);
  assert.equal(pickNavigationDirection([a,b],a.id,heldHeading(new Set(["KeyW"]),radians(yaw))!),null);
  assert.equal(pointerDestination([a,b],a.id,radians(heading),-.4)?.id,b.id);
  const transition=navigationTransition(a,b,radians(yaw),"images");
  assert.equal(transition.animation,"visual");assert.ok(transition.bearings);
  assert.ok(Math.abs(angleDifference(transition.arrivalYaw!,radians(yaw)))<1e-8);
  assert.equal(a.position,null);assert.equal(b.position,null);
});

test("manual then visual pair bearings override distorted diagram directions",()=>{
  const a:Scene={...scene("a",0,0,["b"]),visualLinks:[{targetId:"b",yaw:90}]};
  const b:Scene={...scene("b",0,-100,["a"]),visualLinks:[{targetId:"a",yaw:270}]};
  assert.equal(pickNavigationDirection([a,b],"a",Math.PI/2)?.id,"b");
  assert.equal(pickNavigationDirection([a,b],"a",0),null);
  const manualA={...a,manualLinks:[{targetId:"b",yaw:0}]},manualB={...b,manualLinks:[{targetId:"a",yaw:180}]};
  assert.equal(navigationLink(manualA,manualB)?.kind,"manual");
  assert.equal(pickNavigationDirection([manualA,manualB],"a",0)?.id,"b");
  assert.equal(pickNavigationDirection([manualA,manualB],"a",Math.PI/2),null);
});

test("directional movement follows the aimed corridor instead of a closer side room or a skipped intermediate capture",()=>{
  const a=scene("a",0,0,["far","side"]),far=scene("far",0,-30,["a"]),side=scene("side",Math.sin(radians(50))*.2,-Math.cos(radians(50))*.2,["a"]);
  assert.equal(pickNavigationDirection([a,far,side],"a",0)?.id,"far");
  const near=scene("near",0,-1,["a"]);
  assert.equal(pickNavigationDirection([{...a,links:["far","near"]},far,near],"a",0)?.id,"near");
});

test("visual metadata never navigates blocked, one-way, cross-floor or absent graph edges",()=>{
  const a:Scene={...scene("a",0,0,["b"]),position:null,visualLinks:[{targetId:"b",yaw:0}]};
  const b:Scene={...scene("b",0,0,["a"]),position:null,visualLinks:[{targetId:"a",yaw:180}]};
  for(const target of [{...b,links:[]},{...b,floor:1},{...b,blockedLinks:["a"]},{...b,visualLinks:[]}]) {
    assert.equal(pickNavigationDirection([a,target],"a",0),null);
    assert.equal(navigationTransition(a,target,0,"images").animation,"handover");
  }
});

test("explicit floorplan and room selection goes directly to its target without directional walking",()=>{
  const a:Scene={...scene("a",0,0,["b"]),visualLinks:[{targetId:"b",yaw:90}]};
  const b:Scene={...scene("b",2,0,["a"]),visualLinks:[{targetId:"a",yaw:180}]};
  for(const target of [b,scene("distant",100,30,[]),{...b,floor:1}]){
    assert.deepEqual(navigationTransition(a,target,1.2,"images","direct"),{animation:"handover",arrivalYaw:1.2});
  }
  assert.equal(navigationTransition(a,b,1.2,"images","step").animation,"visual");
});


test("missing directional links fall back to the closest nearby forward same-floor capture",()=>{
  const a=scene('a',0,0,['side']),side=scene('side',1,0,['a']),near=scene('near',.1,-1),far=scene('far',0,-2),back=scene('back',0,.5),upstairs={...scene('upstairs',0,-.1),floor:1};
  assert.equal(pickNavigationDirection([a,side,near,far,back,upstairs],'a',0)?.id,'near');
  assert.deepEqual(a.links,['side']);
  assert.equal(pointerDestination([a,near],'a',0,NaN),null);
});
test("directional fallback respects blocks, missing coordinates, bearing overrides and local distance",()=>{
  const a=scene('a',0,0),close=scene('close',1,0),distant=scene('distant',0,-20),back=scene('back',0,1);
  assert.equal(pickNavigationDirection([a,close,distant,back],'a',0),null);
  for(const target of [{...scene('b',0,-1),blockedLinks:['a']},{...scene('b',0,-1),position:null},scene('b',0,0),{...scene('b',0,-1),visualLinks:[{targetId:'a',yaw:180}]}])assert.equal(pickNavigationDirection([a,target],'a',0),null);
  assert.equal(pickNavigationDirection([{...a,blockedLinks:['b']},scene('b',0,-1)],'a',0),null);
});
test("reciprocal geometric corridor wins over a closer unlinked fallback",()=>{
  const a=scene('a',0,0,['linked']),linked=scene('linked',.1,-2,['a']),fallback=scene('fallback',0,-.2);
  assert.equal(pickNavigationDirection([a,linked,fallback],'a',0)?.id,'linked');
});
