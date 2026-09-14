import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type {SurfaceModel} from "../src/lib/imo3d/model";
import {decodeSurfaceModel,encodeSurfaceModel} from "../src/lib/imo3d/surface-model";
import {loadPhotographicSamples,PhotographicFloorModel} from "../src/components/imo3d/PhotographicFloorModel";

const point=(x=4,y=1,z=5)=>({x,y,z,r:210,g:105,b:40,confidence:.7,sceneIds:["a","b"],normal:{x:0,y:1,z:0}});
const model=(changes:Partial<SurfaceModel>={}):SurfaceModel=>({url:"/api/imo3d/assets/photographic",pointCount:1,floorHeight:1,source:"da3-base-pose-conditioned-multiview",units:"camera_height",cameras:[],...changes});
const responseFetch=(response:Response)=>(async()=>response) as typeof fetch;
const bytes=()=>encodeSurfaceModel([point()],1).slice();

test("photographic asset loader reconstructs chunked bytes and matches the current floor metadata",async()=>{
  const content=bytes();let request:RequestInit|undefined,url:RequestInfo|URL|undefined;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(content.slice(0,7));controller.enqueue(content.slice(7,20));controller.enqueue(content.slice(20));controller.close();}});
  const response=new Response(body),loaded=await loadPhotographicSamples(model(),new AbortController().signal,(async(input,init)=>{url=input;request=init;return response;}) as typeof fetch);
  assert.equal(loaded.count,1);assert.deepEqual([...loaded.colors],[210,105,40]);assert.deepEqual([...loaded.positions],[4,1,5]);
  assert.equal(url,"/api/imo3d/assets/photographic");assert.equal(request?.credentials,"same-origin");assert.equal(request?.redirect,"error");assert.equal(response.body?.locked,false);
});

test("external URLs, excessive point metadata and already-aborted requests never fetch",async()=>{
  let calls=0;const fetcher=(async()=>{calls++;return new Response();}) as typeof fetch;
  for(const changes of [{url:"https://external.invalid/model"},{url:"/api/imo3d/assets/../private"},{pointCount:150001},{pointCount:0},{floorHeight:NaN}])await assert.rejects(loadPhotographicSamples(model(changes),new AbortController().signal,fetcher));
  const controller=new AbortController();controller.abort();await assert.rejects(loadPhotographicSamples(model(),controller.signal,fetcher),{name:"AbortError"});assert.equal(calls,0);
});

test("oversized declared or streamed bodies are cancelled before any GPU model is created",async()=>{
  let cancelled=0;
  const declared=new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{"content-length":"3000017"}});
  await assert.rejects(loadPhotographicSamples(model(),new AbortController().signal,responseFetch(declared)));assert.equal(cancelled,1);
  const streamed=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(37));},cancel(){cancelled++;}}));
  await assert.rejects(loadPhotographicSamples(model(),new AbortController().signal,responseFetch(streamed)));assert.equal(cancelled,2);assert.equal(streamed.body?.locked,false);
});

test("truncated files, wrong floor registration, HTTP errors and redirects fail closed",async()=>{
  for(const response of [new Response(bytes().slice(0,30)),new Response(bytes()),new Response(bytes(),{status:403})]){
    await assert.rejects(loadPhotographicSamples(model({floorHeight:2}),new AbortController().signal,responseFetch(response)));assert.equal(response.body?.locked,false);
  }
  const redirected=new Response(bytes());Object.defineProperty(redirected,"redirected",{value:true});
  await assert.rejects(loadPhotographicSamples(model(),new AbortController().signal,responseFetch(redirected)));
});

test("closing a view interrupts a stalled response stream and releases its reader",{timeout:1000},async()=>{
  let cancelled=0;const controller=new AbortController(),response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled++;}}));
  const pending=loadPhotographicSamples(model(),controller.signal,responseFetch(response));
  await Promise.resolve();await Promise.resolve();controller.abort();
  await assert.rejects(pending,{name:"AbortError"});assert.equal(cancelled,1);assert.equal(response.body?.locked,false);
});

test("photographic geometry uses one disconnected two-triangle quad per observed sample and grounds the source floor",()=>{
  const decoded=decodeSurfaceModel(encodeSurfaceModel([point(),point(4,3,5)],1).buffer as ArrayBuffer),photo=new PhotographicFloorModel(decoded,{x:3,z:4});
  assert.deepEqual([...photo.positions],[1,0,1,1,2,1]);assert.deepEqual([...decoded.positions],[4,1,5,4,3,5]);
  assert.equal(photo.mesh.geometry.index?.count,6);assert.equal(photo.mesh.geometry.getAttribute("position").count,4);assert.equal(photo.mesh.geometry.instanceCount,2);
  assert.equal(photo.mesh.geometry.getAttribute("sampleColor").normalized,true);assert.ok(photo.mesh.geometry.getAttribute("sampleColor").array instanceof Uint8Array);
  assert.ok(photo.visibleBounds().max.y<1.3);photo.setLowWalls(false);assert.ok(photo.visibleBounds().max.y>2);
  photo.dispose();
});

test("ray picking respects supported disc footprints, normals and the visible cutaway",()=>{
  const decoded=decodeSurfaceModel(encodeSurfaceModel([point(),{...point(4,2,6),normal:{x:0,y:0,z:1}},point(4,3,5)],1).buffer as ArrayBuffer),photo=new PhotographicFloorModel(decoded,{x:3,z:4});
  const floor=new THREE.Ray(new THREE.Vector3(1,1,1),new THREE.Vector3(0,-1,0));assert.deepEqual(photo.pick(floor)?.toArray(),[1,0,1]);
  assert.equal(photo.pick(new THREE.Ray(new THREE.Vector3(1.03,1,1),new THREE.Vector3(0,-1,0))),null);
  const wall=new THREE.Ray(new THREE.Vector3(1,1,3),new THREE.Vector3(0,0,-1));assert.deepEqual(photo.pick(wall)?.toArray(),[1,1,2]);
  const top=new THREE.Ray(new THREE.Vector3(1,4,1),new THREE.Vector3(0,-1,0));assert.deepEqual(photo.pick(top)?.toArray(),[1,0,1]);photo.setLowWalls(false);assert.deepEqual(photo.pick(top)?.toArray(),[1,2,1]);
  photo.mesh.visible=false;assert.equal(photo.pick(floor),null);photo.dispose();
});

test("disposing a photographic model detaches and releases its GPU resources exactly once",()=>{
  const photo=new PhotographicFloorModel(decodeSurfaceModel(bytes().buffer as ArrayBuffer),{x:3,z:4}),world=new THREE.Scene();world.add(photo.mesh);
  let geometry=0,material=0;photo.mesh.geometry.addEventListener("dispose",()=>geometry++);photo.mesh.material.addEventListener("dispose",()=>material++);
  photo.dispose();photo.dispose();assert.equal(geometry,1);assert.equal(material,1);assert.equal(world.children.length,0);assert.equal(photo.pick(new THREE.Ray()),null);
});
