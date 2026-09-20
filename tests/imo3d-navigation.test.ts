import assert from "node:assert/strict";
import test from "node:test";

import {cursorDirection,heldHeading,isMovementCode,manualArrivalYaw,navigationLink,navigationPrefetch,navigationTransition,pickNavigationDirection,pointerDestination} from "../src/lib/imo3d/navigation";
import type {Scene} from "../src/lib/imo3d/model";
import {angleDifference,pickDirection,radians} from "../src/lib/imo3d/spatial";

const scene=(id:string,x:number,z:number,links:string[]=[]):Scene=>({id,name:id,sourceName:id,room:id,floor:0,yaw:0,position:{x,y:1.6,z},image:"/example.webp",preview:"/example.webp",thumbnail:"/example.webp",width:2048,height:1024,links} as Scene);
test("prefetch follows look and pointer intent while excluding blocked and one-way links",()=>{
  const a=scene("a",0,0,["back","front","right","blocked","oneway"]);
  const front=scene("front",0,-2,["a"]),back=scene("back",0,2,["a"]),right=scene("right",2,0,["a"]);
  const blocked={...scene("blocked",0,-1,["a"]),blockedLinks:["a"]},oneway=scene("oneway",0,-.5);
  const all=[a,back,right,blocked,oneway,front];
  assert.deepEqual(navigationPrefetch(all,a,0).map(s=>s.id),["front","right","back"]);
  assert.equal(navigationPrefetch(all,a,Math.PI)[0].id,"back");
  assert.equal(navigationPrefetch(all,a,0,"right")[0].id,"right");
});
test("physical WASD, arrows and diagonals follow the current view",()=>{
  assert.equal(isMovementCode("KeyW"),true);assert.equal(isMovementCode("ض"),false);
  assert.equal(heldHeading(new Set(["KeyW"]),Math.PI/2),Math.PI/2);
  assert.equal(heldHeading(new Set(["ArrowLeft"]),Math.PI/2),0);
  assert.equal(heldHeading(new Set(["KeyW","KeyD"]),0),Math.PI/4);
  assert.equal(heldHeading(new Set(["KeyW","KeyS"]),0),null);
  assert.equal(heldHeading(new Set(),0),null);
});
test("pointer destination uses position without mandatory links and rejects backward or ceiling clicks",()=>{
  const a=scene("a",0,0,["b"]),b=scene("b",0,-1,["a"]),wall=scene("behind-wall",0,-.5);
  assert.equal(pointerDestination([a,b,wall],"a",0,-.5)?.id,"b");
  assert.equal(pointerDestination([a,b,wall],"a",Math.PI,0),null);
  assert.equal(pointerDestination([a,b,wall],"a",0,1.2),null);
  assert.equal(pointerDestination([a,{...b,links:[]},wall],"a",0,-.5)?.id,"b");
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
  for(const target of [scene("distant",100,30,[]),{...b,floor:1}]){
    assert.deepEqual(navigationTransition(a,target,1.2,"images","direct"),{animation:"handover",arrivalYaw:1.2});
  }
  assert.equal(navigationTransition(a,b,1.2,"images","step").animation,"visual");
  assert.deepEqual(navigationTransition(a,b,1.2,"images","direct"),navigationTransition(a,b,1.2,"images","step"));
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

test("metric pointer selects distant visible destination in one operation without stepping",()=>{
 const a={...scene('a',0,0,['near']),depth:{width:8,height:4,values:Array(32).fill(10)}};
 const near=scene('near',0,-2,['a']),far=scene('far',0,-8),behind=scene('behind',0,-12);
 assert.equal(pointerDestination([a,near,far,behind],'a',0,0,true)?.id,'far');
 assert.equal(pointerDestination([a,near,far,behind],'a',0,0)?.id,'behind');
 assert.equal(pointerDestination([{...a,depth:{...a.depth,values:Array(32).fill(3)}},near,far],'a',0,0,true)?.id,'near');
 assert.equal(pointerDestination([a,near,{...far,blockedLinks:['a']}],'a',0,0,true)?.id,'near');
 assert.equal(pointerDestination([a,near,{...far,floor:1}],'a',0,0,true)?.id,'near');
});

test("pointer selects a distant connected destination without walking through intermediate captures",()=>{
 const a=scene('a',0,0,['near']),near=scene('near',.5,-2,['a','far']),far=scene('far',0,-10,['near']);
 const all=[a,near,far];
 assert.equal(pointerDestination(all,'a',0,-.2)?.id,'far');
 assert.equal(pickNavigationDirection(all,'a',0)?.id,'near');
 assert.equal(pointerDestination(all,'a',Math.atan2(.5,2),-.8)?.id,'near');
 assert.notEqual(pointerDestination([...all,{...scene('isolated',0,-20),floor:1}],'a',0,-.2)?.id,'isolated');
 assert.equal(pointerDestination([a,near,{...far,blockedLinks:['a']}],'a',0,-.2)?.id,'near');
});

test("pointer screen height distinguishes near and far captures in the same direction without requiring intermediate links",()=>{
 const a=scene('a',0,0,['near']),near=scene('near',0,-1,['a']),far=scene('far',0,-8);
 assert.equal(pointerDestination([a,near,far],'a',0,-.12)?.id,'far');
 assert.equal(pointerDestination([a,near,far],'a',0,-.8)?.id,'near');
 assert.equal(pointerDestination([a,near,{...far,floor:1}],'a',0,-.12)?.id,'near');
 assert.equal(pointerDestination([a,near,{...far,blockedLinks:['a']}],'a',0,-.12)?.id,'near');
});


test("distant image captures with supported depth use direct parallax preserving view heading",()=>{
 const depth={source:"da3-base-pose-conditioned-multiview",purpose:"display_only",units:"camera_height",width:8,height:4,confidence:.9,coverage:1,values:Array(32).fill(2)} as const;
 const a={id:"a",floor:0,links:[],yaw:0,position:{x:0,y:0,z:0},displayDepth:depth} as unknown as Scene;
 const b={...a,id:"b",position:{x:0,y:0,z:-10}};
 const result=navigationTransition(a,b,1.2,"images","direct");
 assert.equal(result.animation,"visual");assert.equal(result.arrivalYaw,1.2);
 assert.deepEqual(result.bearings,{fromYaw:0,toYaw:Math.PI});
 assert.equal(navigationTransition(a,b,1.2,"images","step").animation,"handover");
 assert.equal(navigationTransition(a,{...b,displayDepth:undefined},1.2,"images","direct").animation,"handover");
 assert.equal(navigationTransition(a,{...b,blockedLinks:["a"]},1.2,"images","direct").animation,"handover");
 assert.equal(navigationTransition(a,{...b,floor:1},1.2,"images","direct").animation,"handover");
});


test("wall click chooses nearest capture in current room, never a closer kitchen behind wall",()=>{
 const a={...scene("a",0,0),room:"master"},near={...scene("near",0,-2),room:"master"},kitchen={...scene("kitchen",0,-3),room:"kitchen"};
 assert.equal(pointerDestination([a,near,kitchen],a.id,0,0,false,{kind:"wall",point:{x:0,y:1,z:-3}})?.id,"near");
 assert.equal(pointerDestination([a,kitchen],a.id,0,0,false,{kind:"wall",point:{x:0,y:1,z:-3}}),null);
});
test("current capture remains selected when closest to clicked wall",()=>{
 const a={...scene("a",0,0),room:"master"},far={...scene("far",0,-4),room:"master"};
 assert.equal(pointerDestination([a,far],a.id,0,0,false,{kind:"wall",point:{x:0,y:1,z:-.2}}),null);
});
test("cross-room floor movement requires an aimed reciprocal visual doorway connection",()=>{
 const a={...scene("a",0,0,["b"]),room:"master",visualLinks:[{targetId:"b",yaw:0}]};
 const b={...scene("b",0,-3,["a"]),room:"corridor",visualLinks:[{targetId:"a",yaw:180}]};
 assert.equal(pointerDestination([a,b],a.id,0,-.4,false,{kind:"floor"})?.id,"b");
 assert.equal(pointerDestination([a,b],a.id,radians(25),-.4,false,{kind:"floor"}),null);
 assert.equal(pointerDestination([a,b],a.id,0,-.4,false,{kind:"unknown"}),null);
 assert.equal(pointerDestination([a,{...b,visualLinks:[]}],a.id,0,-.4,false,{kind:"floor"}),null);
});
test("distinct semantic rooms cannot merge just because they share a bedroom label",()=>{
 const a={...scene("a",0,0),room:"bedroom",roomSemantic:{groupId:"room1"}} as Scene;
 const b={...scene("b",0,-1),room:"bedroom",roomSemantic:{groupId:"room2"}} as Scene;
 assert.equal(pointerDestination([a,b],a.id,0,0,false,{kind:"wall",point:{x:0,y:0,z:-1}}),null);
});
