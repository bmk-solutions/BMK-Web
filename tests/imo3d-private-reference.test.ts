import test from "node:test";
import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import type {Scene,Tour} from "../src/lib/imo3d/model";
import {angleDifference,radians} from "../src/lib/imo3d/spatial";
import {floorPlanProjection,floorPlanViewport} from "../src/components/imo3d/floorplan-geometry";
import {buildFloorPlan3D} from "../src/components/imo3d/floorplan3d-geometry";

const fixtureFile=process.env.IMO3D_TEST_PRIVATE_EXAMPLE_FILE??"src/lib/imo3d/example.json";
const drawingFile=process.env.IMO3D_TEST_PRIVATE_DRAWING_FILE??"public/imo3d/example/plan-f0.svg";
const enabled=process.env.IMO3D_SKIP_PRIVATE_FIXTURES!=="1";
const example=enabled&&existsSync(fixtureFile)?JSON.parse(readFileSync(fixtureFile,"utf8")) as Tour:null;
const skip=example?false:"Private reference fixture is unavailable; synthetic geometry tests remain active.";
const drawingSkip=example&&existsSync(drawingFile)?false:"Private reference drawing is unavailable; synthetic geometry tests remain active.";
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test("private reference: camera bearing agrees with the observed kitchen passage",{skip},()=>{
  const tour=example!;
  const a=tour.scenes.find((scene:Scene)=>scene.sourceName==="Enscape scene 11")!;
  const b=tour.scenes.find((scene:Scene)=>scene.sourceName==="Enscape scene 12")!;
  const heading=Math.atan2(b.position!.x-a.position!.x,-(b.position!.z-a.position!.z));
  const u=.5+angleDifference(heading,radians(a.yaw))/(2*Math.PI);
  assert.ok(u>.70&&u<.80,`passage must be at u near .76; got ${u}`);
  assert.ok(Math.abs(angleDifference(radians(tour.initialView!.yaw),heading))<.15);
});

test("private reference: rendering shell walls reproduce the supplied drawing",{skip:drawingSkip},()=>{
  const plan=example!.plans[0],projection=floorPlanProjection(plan,example!.scenes)!;
  const lines=[...readFileSync(drawingFile,"utf8").matchAll(/<line\b[^>]*>/g)];
  assert.equal(plan.walls.length,lines.length);
  lines.forEach(([line],index)=>{
    const values=Object.fromEntries([...line.matchAll(/(x1|x2|y1|y2)="([^"]+)"/g)].map(([,key,value])=>[key,Number(value)]));
    const a=projection.project({...plan.walls[index].a,y:0}),b=projection.project({...plan.walls[index].b,y:0});
    near(a.x,values.x1);near(a.y,values.y1);near(b.x,values.x2);near(b.y,values.y2);
  });
});

test("private reference: source crop retains every measured wall",{skip:drawingSkip},()=>{
  const plan=example!.plans[0],viewport=floorPlanViewport(plan);
  const lines=[...readFileSync(drawingFile,"utf8").matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g)];
  assert.equal(lines.length,485);
  for(const line of lines){
    for(const x of [Number(line[1]),Number(line[3])])assert.ok(x>viewport.x&&x<viewport.x+viewport.width);
    for(const y of [Number(line[2]),Number(line[4])])assert.ok(y>viewport.y&&y<viewport.y+viewport.height);
  }
  assert.ok(viewport.width<473&&viewport.height<583);
});

test("private reference: all calibrated cameras retain their drawing coordinates",{skip},()=>{
  const plan=example!.plans[0],projection=floorPlanProjection(plan,example!.scenes);assert.ok(projection);
  for(const scene of example!.scenes){const actual=projection.project(scene.position!),expected=plan.scenePoints![scene.id];near(actual.x,expected.x);near(actual.y,expected.y);}
  near(projection.heading(0),30);near(projection.heading(Math.PI/2),120);
});

test("private reference: the 3D sample retains calibrated world coordinates",{skip},()=>{
  const tour=example!,result=buildFloorPlan3D(tour.plans[0],tour.scenes,"metric");
  assert.equal(result.cameras.length,35);assert.ok(result.walls.length>400);assert.equal(result.estimatedSurfaces.length,0);
  assert.ok(result.width<30&&result.depth<30);assert.ok(result.origin.x>70&&result.origin.x<90);
  for(const point of result.cameras){const source=tour.scenes.find(scene=>scene.id===point.id)!;near(point.point.x+result.origin.x,source.position!.x);near(point.point.z+result.origin.z,source.position!.z);}
  for(const wall of result.walls)assert.ok(tour.plans[0].walls.some(source=>Math.abs(source.a.x-(wall.a.x+result.origin.x))<1e-8&&Math.abs(source.a.z-(wall.a.z+result.origin.z))<1e-8&&Math.abs(source.b.x-(wall.b.x+result.origin.x))<1e-8&&Math.abs(source.b.z-(wall.b.z+result.origin.z))<1e-8));
});
