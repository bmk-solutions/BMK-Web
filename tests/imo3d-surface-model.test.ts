import test from "node:test";
import assert from "node:assert/strict";
import type {Plan,Scene,SurfaceModel} from "../src/lib/imo3d/model";
import {currentSurfaceModel,decodeSurfaceModel,encodeSurfaceModel,surfaceModelFloorHeight} from "../src/lib/imo3d/surface-model";
import {removeTourScene} from "../src/lib/imo3d/scene-removal";
import type {Tour} from "../src/lib/imo3d/model";

const sample=()=>({x:1.5,y:-1.03,z:2.5,r:255,g:110,b:30,confidence:.8,sceneIds:["a","b"],normal:{x:0,y:1,z:0},floorConfidence:.9});
const scene=(id:string,x:number):Scene=>({id,name:id,room:"room",floor:0,image:`/api/imo3d/assets/${id}`,preview:`/api/imo3d/assets/${id}`,thumbnail:`/api/imo3d/assets/${id}`,sourceName:id+".jpg",position:{x,y:0,z:0},yaw:0,links:[]});
const scenes=[scene("a",0),scene("b",1)];
const model=():SurfaceModel=>({url:"/api/imo3d/assets/surfaces",pointCount:5000,floorHeight:-1,source:"da3-base-pose-conditioned-multiview",units:"camera_height",cameras:scenes.map(s=>({id:s.id,image:s.image,position:s.position!,yaw:s.yaw}))});
const plan=():Plan=>({floor:0,label:"floor",kind:"estimated",bounds:{minX:0,maxX:3,minZ:0,maxZ:3},walls:[],surfaceModel:model()});

test("binary photographic surfaces preserve source colors, relative geometry and normals",()=>{
  const bytes=encodeSurfaceModel([sample()],-1.03),decoded=decodeSurfaceModel(bytes.buffer as ArrayBuffer);
  assert.equal(bytes.length,36);assert.equal(decoded.count,1);assert.ok(Math.abs(decoded.floorHeight+1.03)<1e-6);assert.deepEqual([...decoded.colors],[255,110,30]);assert.deepEqual([...decoded.normals],[0,1,0]);assert.equal(decoded.confidence[0],204);assert.ok(Math.abs(decoded.positions[1]+1.03)<1e-6);
  assert.equal(surfaceModelFloorHeight(Array(50).fill(sample()),scenes),-1.03);assert.equal(surfaceModelFloorHeight([],scenes),-1);
});

test("binary model rejects oversized, truncated, nonfinite and unsupported observations",()=>{
  assert.throws(()=>encodeSurfaceModel([],0));assert.throws(()=>encodeSurfaceModel([{...sample(),confidence:.1}],0));assert.throws(()=>encodeSurfaceModel([{...sample(),sceneIds:["a","a"]}],0));assert.throws(()=>encodeSurfaceModel([{...sample(),x:NaN}],0));
  const bytes=encodeSurfaceModel([sample()],-1);
  assert.throws(()=>decodeSurfaceModel(bytes.buffer.slice(0,-1) as ArrayBuffer));
  for(const change of [(v:DataView)=>v.setUint32(0,0,true),(v:DataView)=>v.setUint32(8,150001,true),(v:DataView)=>v.setFloat32(16,Infinity,true),(v:DataView)=>v.setUint8(31,0)]){const copy=bytes.slice();change(new DataView(copy.buffer));assert.throws(()=>decodeSurfaceModel(copy.buffer));}
});

test("renaming preserves a photographic model while moved/replaced/deleted sources invalidate it",()=>{
  const p=plan();assert.equal(currentSurfaceModel(p,scenes),p.surfaceModel);
  assert.equal(currentSurfaceModel(p,scenes.map(s=>({...s,name:"renamed",room:"new room"}))),p.surfaceModel);
  for(const changes of [{floor:1},{yaw:10},{image:"/api/imo3d/assets/new"},{position:null},{position:{x:3,y:0,z:0}}])assert.equal(currentSurfaceModel(p,[{...scenes[0],...changes},scenes[1]]),undefined);
  assert.equal(currentSurfaceModel(p,scenes.slice(0,1)),undefined);
  assert.equal(currentSurfaceModel({...p,surfaceModel:{...model(),url:"https://external.invalid/model"}},scenes),undefined);
});

test("deleting a source capture removes its photographic derivative reference",()=>{
  const tour={id:"tour",projectId:"project",title:"tour",scenes,plans:[plan()],published:false,revision:1,createdAt:"now",updatedAt:"now",quality:{positioned:2,depthScenes:0,components:1,warnings:[]},unit:{code:"",area:null,price:null,bedrooms:null,bathrooms:null}} as Tour;
  const next=removeTourScene(tour,"a")!;assert.equal(next.plans[0].surfaceModel,undefined);assert.ok(tour.plans[0].surfaceModel);
});
