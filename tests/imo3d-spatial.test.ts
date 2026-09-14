import test from "node:test";
import assert from "node:assert/strict";
import {autoConnect,connectedComponents,derivePlans,distance,monthlyPayment,pickDirection,quality,sampleDepth,shortestPath,surfacePoint} from "../src/lib/imo3d/spatial";
import {cameraBundleSchema,depthSchema,sceneSchema,type Depth,type Scene} from "../src/lib/imo3d/model";

const depth=(value:number):Depth=>({width:360,height:180,values:Array(360*180).fill(value)});
function scene(id:string,x=0,z=0):Scene{return {id,name:id,room:id,floor:0,position:{x,y:1.6,z},yaw:0,image:"/imo3d/example/test.webp",preview:"/imo3d/example/test.webp",thumbnail:"/imo3d/example/test.webp",sourceName:`${id}.jpg`,links:[]};}

test("links are reciprocal when both depth maps show a clear corridor",()=>{
  const a={...scene("a"),depth:depth(8)},b={...scene("b",0,-2),depth:depth(8)};
  const result=autoConnect([a,b]);assert.deepEqual(result.map(s=>s.links),[["b"],["a"]]);assert.equal(connectedComponents(result),1);
});
test("does not connect through a wall or across different floors",()=>{
  const a={...scene("a"),depth:depth(1)},b={...scene("b",0,-2),depth:depth(8)};
  assert.deepEqual(autoConnect([a,b]).map(s=>s.links),[[],[]]);
  assert.deepEqual(autoConnect([{...a,depth:depth(8)},{...b,floor:1}]).map(s=>s.links),[[],[]]);
});
test("positions without depth do not silently produce wall-safe links",()=>{
  const result=autoConnect([scene("a"),scene("b",0,-1)]);assert.equal(connectedComponents(result),2);assert.equal(result[0].links.length,0);
});
test("direction selection respects view heading and cannot select an unlinked scene",()=>{
  const a={...scene("a"),links:["north","east"]},north=scene("north",0,-2),east=scene("east",2,0),behind=scene("behind",0,1);
  assert.equal(pickDirection([a,north,east,behind],"a",0)?.id,"north");assert.equal(pickDirection([a,north,east,behind],"a",Math.PI/2)?.id,"east");assert.equal(pickDirection([a,north,east,behind],"a",Math.PI),null);
});
test("pathfinding takes measured distance, not array order",()=>{
  const a={...scene("a"),links:["far","near"]},far={...scene("far",10,0),links:["end"]},near={...scene("near",1,0),links:["end"]},end=scene("end",2,0);
  assert.deepEqual(shortestPath([a,far,near,end],"a","end"),["a","near","end"]);assert.deepEqual(shortestPath([a,end],"a","end"),[]);
});
test("panorama wrap and pitch stay inside the depth buffer",()=>{
  const d=depth(3);assert.equal(sampleDepth(d,-Math.PI,0),3);assert.equal(sampleDepth(d,Math.PI,0),3);assert.equal(sampleDepth(d,8*Math.PI,-Math.PI/2),3);
});
test("metric point reconstruction includes camera position and yaw",()=>{
  const s={...scene("a",80,20),depth:depth(2),yaw:90};const p=surfacePoint(s,Math.PI/2,0)!;
  assert.ok(Math.abs(p.x-82)<1e-10);assert.equal(p.y,1.6);assert.ok(Math.abs(p.z-20)<1e-10);
  assert.equal(surfacePoint(scene("no-depth"),0,0),null);assert.equal(surfacePoint({...s,depth:depth(0)},0,0),null);
});
test("floor plan bounds follow the building, not the world origin",()=>{
  const plans=derivePlans([scene("a",80,20),scene("b",83,25)]);assert.equal(plans[0].kind,"path");assert.equal(plans[0].bounds.minX,79.5);assert.equal(plans[0].bounds.maxX,83.5);assert.equal(plans[0].walls.length,0);
});
test("depth-derived floor plan is distinguished from a calibrated source plan",()=>{
  const plans=derivePlans([{...scene("a"),depth:depth(3)}]);assert.equal(plans[0].kind,"depth");assert.equal(plans[0].walls.length,360);assert.ok(plans[0].bounds.maxX>3);
});
test("unpositioned panoramas do not generate an architectural plan",()=>{
  const s={...scene("a"),position:null};assert.equal(derivePlans([s])[0].kind,"missing");assert.equal(quality([s]).positioned,0);assert.ok(quality([s]).warnings.length>=2);
});
test("rejects malformed depth and path traversal",()=>{
  assert.equal(depthSchema.safeParse({width:8,height:4,values:[1]}).success,false);
  assert.equal(sceneSchema.safeParse({...scene("a"),image:"/api/imo3d/assets/../../secret"}).success,false);
  assert.equal(sceneSchema.safeParse({...scene("a"),image:"https://outside.example/image.jpg"}).success,false);
  assert.equal(cameraBundleSchema.safeParse({version:1,units:"feet",cameras:[]}).success,false);
});
test("distance and loan calculations handle zero interest",()=>{
  assert.equal(distance({x:0,y:0,z:0},{x:3,y:4,z:0}),5);
  assert.equal(monthlyPayment(120000,0,0,10),1000);assert.ok(Math.abs(monthlyPayment(780000,20,6,20)-4470.53)<1);
});
