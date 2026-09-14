import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type {Plan,PlanRoom,Scene} from "../src/lib/imo3d/model";
import {pointInRoom} from "../src/lib/imo3d/boundary-shapes";
import {canExportFloorPlanSvg,floorPlanExportFilename,renderFloorPlanSvg} from "../src/lib/imo3d/floorplan-export";

const room=(id="a",x=0):PlanRoom=>({id,name:"غرفة نوم",outline:[{x,z:0},{x:x+4,z:0},{x:x+4,z:3},{x,z:3}],finish:"wood",openings:[]});
const plan=(rooms:PlanRoom[]=[room()]):Plan=>({floor:0,label:"الطابق الأرضي",kind:"estimated",bounds:{minX:-999,minZ:-999,maxX:999,maxZ:999},walls:[],generatedRooms:rooms,generatedFrom:{method:"image-layout",confidence:.7,sceneIds:[],scale:"camera_height"}});
const render=(source:Plan)=>renderFloorPlanSvg({tourTitle:"شقة الحمراء",plan:source,scenes:[]});

test("a rejected floor plan cannot be exported as an accepted drawing",()=>{
  const source={...plan(),reviewStatus:"rejected" as const};
  assert.equal(canExportFloorPlanSvg(source),false);assert.throws(()=>render(source),/قيد المراجعة/);
});

test("export is a self-contained XML image with bounded raster dimensions and unchanged inputs",async()=>{
  const source=plan(),before=structuredClone(source),svg=render(source);
  assert.equal(canExportFloorPlanSvg(source),true);assert.deepEqual(source,before);
  assert.ok(!/<(?:image|script|foreignObject)\b|\bhref=|@import|url\(/i.test(svg));
  const {width,height}=await sharp(Buffer.from(svg)).metadata();assert.ok(width&&height);assert.equal(Math.max(width,height),2200);
  const pixel=await sharp(Buffer.from(svg)).extract({left:0,top:0,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[255,255,255]);
  assert.match(svg,/مقياس نسبي/);assert.match(svg,/ليس بالمتر/);assert.ok(!svg.includes("m²"));
});

test("room coordinates and asymmetric observed gaps survive export without a standard door width",()=>{
  const a={...room(),doorwayCandidates:[{edge:1,offset:.25,width:.2,confidence:.8,verified:false as const,pairedRoomId:"b"}]},b={...room("b",4),doorwayCandidates:[{edge:3,offset:.75,width:.2,confidence:.8,verified:false as const,pairedRoomId:"a"}]};
  const svg=render(plan([a,b]));
  const wallPath=svg.match(/data-layer="walls" d="([^"]+)"/)?.[1];assert.ok(wallPath);
  const sharedSegments=[...wallPath.matchAll(/M4 ([\d.]+)L4 ([\d.]+)/g)].map(match=>[Number(match[1]),Number(match[2])].sort((left,right)=>left-right));
  assert.deepEqual(sharedSegments.sort((left,right)=>left[0]-right[0]),[[0,.45],[1.05,3]]);
  assert.equal((svg.match(/data-door-source="estimated"/g)||[]).length,1);
  assert.match(svg,/لا يمثل العرض الكامل للباب/);assert.ok(!svg.includes("M4 0L4 3"));
});

test("separate observed wall planes remain separate and unobserved proximity adds no doorway",()=>{
  const a={...room(),doorwayCandidates:[{edge:1,offset:.5,width:.2,confidence:.8,verified:false as const,pairedRoomId:"b"}]},b={...room("b",4.2),doorwayCandidates:[{edge:3,offset:.5,width:.2,confidence:.8,verified:false as const,pairedRoomId:"a"}]};
  assert.equal((render(plan([a,b])).match(/data-door-source="estimated"/g)||[]).length,2);
  assert.equal((render(plan([room(),room("b",4.2)])).match(/data-door-source=/g)||[]).length,0);
});

test("authored rooms and names take priority while generated names use only same-floor room membership",()=>{
  const source=plan(),scene={floor:0,room:"اسم راجعه المستخدم",roomSemantic:{groupId:"a"}} as Scene,otherFloor={...scene,floor:1,room:"طابق آخر"};
  const svg=renderFloorPlanSvg({tourTitle:"شقة",plan:source,scenes:[otherFloor,scene]});assert.ok(svg.includes("اسم راجعه المستخدم"));assert.ok(!svg.includes("طابق آخر"));
  const authored={...source,authoredRooms:[{...room(),name:"غرفة محفوظة",openings:[1]}],authoredScale:"relative" as const};
  const saved=renderFloorPlanSvg({tourTitle:"شقة",plan:authored,scenes:[scene]});assert.ok(saved.includes("غرفة محفوظة"));assert.ok(!saved.includes("اسم راجعه المستخدم"));assert.match(saved,/data-door-source="manual"/);
});

test("concave-room label stays inside actual outline rather than its empty bounding-box center",()=>{
  const concave={...room(),outline:[{x:0,z:0},{x:5,z:0},{x:5,z:1},{x:1,z:1},{x:1,z:5},{x:0,z:5}]};
  const svg=render(plan([concave])),match=svg.match(/data-anchor-x="([^"]+)" data-anchor-z="([^"]+)"/);assert.ok(match);
  assert.ok(pointInRoom({x:Number(match[1]),z:Number(match[2])},concave.outline));assert.ok(!pointInRoom({x:2.5,z:2.5},concave.outline));
});

test("untrusted titles, labels, identifiers and branding cannot inject SVG markup",async()=>{
  const attack='</text><script>alert(1)</script><image href="https://bad.invalid/a"/>\u0001';
  const source=plan([{...room(attack),name:attack}]);
  const svg=renderFloorPlanSvg({tourTitle:attack,plan:source,scenes:[],brandingName:attack});
  assert.ok(svg.includes("&lt;script&gt;"));assert.ok(!svg.includes("<script>"));assert.ok(!svg.includes("<image"));assert.ok(!svg.includes("\u0001"));
  assert.equal((await sharp(Buffer.from(svg)).metadata()).format,"svg");
});

test("wall-only exports retain saved geometry while source images and topology cannot invent rooms",()=>{
  const source:Plan={...plan([]),kind:"geometry",generatedFrom:undefined,generatedRooms:undefined,image:"https://private.invalid/source.png",walls:[{a:{x:10,z:20},b:{x:14,z:20}},{a:{x:14,z:20},b:{x:14,z:24}}]};
  const svg=render(source);assert.match(svg,/M10 20L14 20M14 20L14 24/);assert.ok(!svg.includes("private.invalid"));assert.match(svg,/الصورة المرجعية غير مضمنة/);assert.ok(!svg.includes("إحداثيات معايرة بالمتر"));
  assert.equal(canExportFloorPlanSvg({...source,walls:[]}),false);assert.throws(()=>render({...source,walls:[]}),/لا توجد حدود/);
  assert.equal(canExportFloorPlanSvg({...source,walls:[{a:{x:NaN,z:0},b:{x:1,z:0}}]}),false);
  assert.equal(canExportFloorPlanSvg({...source,walls:[{a:{x:0,z:0},b:{x:0,z:0}}]}),false);
});

test("download names preserve Arabic and cannot create directories or Windows device filenames",()=>{
  const name=floorPlanExportFilename('../شقة:الحمراء\\CON?','طابق/1\u202e','png');
  assert.ok(name.startsWith("IMO3D-"));assert.ok(name.includes("شقة الحمراء"));assert.ok(name.endsWith(".png"));assert.ok(!/[<>:"/\\|?*\u202e]/.test(name));assert.ok(floorPlanExportFilename("","", "svg").endsWith("tour-floor.svg"));
});
