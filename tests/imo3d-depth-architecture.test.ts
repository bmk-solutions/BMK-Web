import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {EventEmitter} from "node:events";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
import {PassThrough} from "node:stream";
import {applyDepthArchitecture,depthArchitectureSource,runDepthArchitecture} from "../src/lib/imo3d/depth-architecture.ts";
import type {DepthArchitectureResult,DepthArchitectureScene} from "../src/lib/imo3d/depth-architecture.ts";
import type {Plan,PlanRoom} from "../src/lib/imo3d/model.ts";

const rectangle=(x=0,z=0,width=4,height=4)=>[{x,z},{x:x+width,z},{x:x+width,z:z+height},{x,z:z+height}];
const room=():PlanRoom=>({id:"dining",name:"Dining",finish:"wood",outline:rectangle(),openings:[0],doorwayCandidates:[{edge:0,offset:.5,width:.2,confidence:.8,verified:false,pairedRoomId:"hall"}]});
const scenes=():DepthArchitectureScene[]=>[{id:"a",componentId:"main",floor:0,position:{x:1,y:0,z:1},yaw:0},{id:"b",componentId:"main",floor:0,position:{x:2,y:0,z:2},yaw:0}];
const plan=():Plan=>({floor:0,label:"Ground",kind:"estimated",bounds:{minX:0,minZ:0,maxX:4,maxZ:4},walls:[],generatedRooms:[room()],generatedFrom:{method:"image-boundaries",confidence:.6,sceneIds:["a","b"],scale:"camera_height"}});
const area=(outline:{x:number;z:number}[])=>outline.reduce((sum,a,i)=>{const b=outline[(i+1)%outline.length];return sum+a.x*b.z-b.x*a.z;},0)/2;
function proposal(prior=room(),outline=rectangle(0,0,4.1,4.1)){
  return{...structuredClone(prior),outline,refinement:{source:"image_outline_refined_by_multiview_depth",units:"camera_height",verified:false,previousOutline:structuredClone(prior.outline),maxCornerShift:Math.max(...outline.map((p,i)=>Math.hypot(p.x-prior.outline[i].x,p.z-prior.outline[i].z))),areaRatio:area(outline)/area(prior.outline),cameraContainmentPreserved:true,doorEdgeIndicesPreserved:true,unchangedEdgeLines:[0,3],supportedEdgeChanges:[1,2].map(edge=>({edge,wallId:`wall-${edge}`,coverage:.8,beforeResidual:.08,afterResidual:.01,supportPoints:120,supportCameras:["a","b"]}))}};
}
function output(proposed:unknown=proposal()):DepthArchitectureResult{return{version:1,source:depthArchitectureSource,units:"camera_height",groups:[{planIndex:0,floor:0,componentId:"main",scenes:scenes(),status:"estimated",proposedRooms:[proposed],proposalRejections:[]}],warnings:[],outputPaths:[]};}

test("depth architecture admits bounded image-room corrections and preserves exact aperture metadata",()=>{
  const original=plan(),snapshot=structuredClone(original),p=proposal();
  const updated=applyDepthArchitecture([original],scenes(),output({...p,name:"Untrusted rename",finish:"stone"}))[0];
  assert.notEqual(updated,original);assert.deepEqual(original,snapshot);
  assert.deepEqual(updated.generatedRooms?.[0].outline,p.outline);
  assert.equal(updated.generatedRooms?.[0].name,original.generatedRooms?.[0].name);
  assert.deepEqual(updated.generatedRooms?.[0].openings,room().openings);
  assert.deepEqual(updated.generatedRooms?.[0].doorwayCandidates,room().doorwayCandidates);
  assert.ok(updated.walls.length>4);assert.equal(updated.bounds.maxX,4.6);
  assert.equal(updated.generatedFrom?.method,"image-boundaries+multiview-depth-refinement");
  assert.equal(applyDepthArchitecture([updated],scenes(),output())[0],updated,"stale previous outline must not replay");
});

test("depth application rejects malformed evidence, unsupported lines, excessive shifts and altered doors",()=>{
  const invalid=[
    {...proposal(),id:"foreign"},
    {...proposal(),outline:rectangle(0,0,4.3,4.3)},
    {...proposal(),outline:[...proposal().outline,{x:0,z:1}]},
    {...proposal(),openings:[]},
    {...proposal(),doorwayCandidates:[{...room().doorwayCandidates![0],width:.3}]},
    {...proposal(),refinement:{...proposal().refinement,previousOutline:rectangle(0,0,3.9,4)}},
    {...proposal(),refinement:{...proposal().refinement,maxCornerShift:NaN}},
    {...proposal(),refinement:{...proposal().refinement,areaRatio:Infinity}},
    {...proposal(),refinement:{...proposal().refinement,supportedEdgeChanges:[proposal().refinement.supportedEdgeChanges[0]]}},
    {...proposal(),refinement:{...proposal().refinement,supportedEdgeChanges:proposal().refinement.supportedEdgeChanges.map(edge=>({...edge,supportCameras:["a","foreign"]}))}},
    proposal(room(),[{x:.02,z:0},{x:4.1,z:0},{x:4.1,z:4.1},{x:0,z:4.1}]),
    {...proposal(),floor:1}, {...proposal(),componentId:"foreign"},
  ];
  for(const candidate of invalid){const original=plan();assert.equal(applyDepthArchitecture([original],scenes(),output(candidate))[0],original);}
});

test("depth application isolates floors, components, authored rooms and changed camera snapshots",()=>{
  const original=plan();
  for(const mutate of [
    (o:DepthArchitectureResult)=>{o.groups[0].floor=1;},
    (o:DepthArchitectureResult)=>{o.groups[0].componentId="other";},
    (o:DepthArchitectureResult)=>{o.groups[0].scenes[0].position.x+=.01;},
    (o:DepthArchitectureResult)=>{o.groups[0].proposedRooms.push(proposal());},
  ]){const raw=output();mutate(raw);assert.equal(applyDepthArchitecture([original],scenes(),raw)[0],original);}
  for(const authoredRooms of [[],[room()]]){const authored={...plan(),authoredRooms};assert.equal(applyDepthArchitecture([authored],scenes(),output())[0],authored);}
  const upstairs={...plan(),floor:1};const result=applyDepthArchitecture([original,upstairs],scenes(),output());assert.equal(result[1],upstairs);
});

test("depth application recomputes camera containment and added neighbor overlap",()=>{
  const original=plan(),nearEdge={id:"edge",componentId:"main",floor:0,position:{x:3.95,y:0,z:2}};
  assert.equal(applyDepthArchitecture([original],[...scenes(),nearEdge],output(proposal(room(),rectangle(0,0,3.9,3.9))))[0],original);
  const neighbor={...room(),id:"neighbor",outline:rectangle(4,0),openings:[],doorwayCandidates:[]};
  const adjacent={...plan(),generatedRooms:[room(),neighbor]};
  const forged={...proposal(),refinement:{...proposal().refinement,estimatedNewOverlap:0}};
  assert.equal(applyDepthArchitecture([adjacent],scenes(),output(forged))[0],adjacent,"recompute overlap rather than trust the claimed zero");
});

function fixture(){
  const previous=process.env.IMO3D_PYTHON;process.env.IMO3D_PYTHON=process.execPath;
  const root=path.resolve("work");mkdirSync(root,{recursive:true});const directory=mkdtempSync(path.join(root,"depth-architecture-test-"));
  return{directory,options:{points:Array.from({length:100},()=>({x:1,y:1,z:1,r:1,g:2,b:3,confidence:.8,sceneIds:["a","b"]})),scenes:scenes(),plans:[plan()],outputDir:directory},close(){if(previous===undefined)delete process.env.IMO3D_PYTHON;else process.env.IMO3D_PYTHON=previous;assert.ok(path.resolve(directory).startsWith(root+path.sep));rmSync(directory,{recursive:true,force:true});}};
}
function modelProcess(onKill=()=>{}){const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean};child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{onKill();setImmediate(()=>child.emit("close",null));return true;};return child;}

test("depth supervisor isolates floor frames, strips image paths, runs offline and gives retries unique directories",async context=>{
  const f=fixture(),attempts:string[]=[];try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[],options:childProcess.SpawnOptions)=>{
      assert.equal(options.windowsHide,true);assert.equal(options.env?.HF_HUB_OFFLINE,"1");assert.equal(options.env?.TRANSFORMERS_OFFLINE,"1");
      const input=JSON.parse(readFileSync(args[2],"utf8"));
      assert.equal(new Set(input.scenes.map((s:DepthArchitectureScene)=>s.floor)).size,1);assert.equal(input.pointSamples.length,100);assert.equal(input.scenes.some((s:Record<string,unknown>)=>"path" in s),false);assert.equal(input.priorRooms.length,1);
      attempts.push(path.dirname(args[4]));assert.match(path.basename(attempts.at(-1)!),/^depth-architecture-[\da-f-]+$/);
      const child=modelProcess();setImmediate(()=>{writeFileSync(args[4],JSON.stringify({version:1,units:"camera_height",status:"partial",proposedRooms:[]}));child.emit("close",0);});return child;
    }) as unknown as typeof childProcess.spawn);
    const options={...f.options,scenes:[...scenes().map(s=>({...s,path:"private-do-not-pass.jpg"})),...scenes().map(s=>({...s,id:s.id+"-up",floor:1}))],points:[...f.options.points,...f.options.points.map(p=>({...p,sceneIds:["a-up","b-up"]}))],plans:[plan(),{...plan(),floor:1,generatedFrom:{...plan().generatedFrom!,sceneIds:["a-up","b-up"]}}]};
    const result=await runDepthArchitecture(options);assert.equal(result.groups.length,2);assert.deepEqual(result.groups.map(g=>g.floor),[0,1]);await runDepthArchitecture(options);assert.equal(new Set(attempts).size,4);
  }finally{f.close();}
});

test("depth cancellation kills the child and rejects late partial results and pre-aborted retries",async context=>{
  const f=fixture(),controller=new AbortController();let killed=0;try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{const child=modelProcess(()=>killed++);setImmediate(()=>{writeFileSync(args[4],JSON.stringify({version:1,units:"camera_height",status:"estimated",proposedRooms:[proposal()]}));controller.abort();});return child;}) as unknown as typeof childProcess.spawn);
    await assert.rejects(runDepthArchitecture({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(killed,1);
    await assert.rejects(runDepthArchitecture({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(killed,1);
  }finally{f.close();}
});

test("depth supervisor refuses oversized arrays and oversized or missing output files",async context=>{
  const f=fixture();let calls=0;try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{calls++;const child=modelProcess();setImmediate(()=>{if(calls===1)writeFileSync(args[4],Buffer.alloc(8*1024*1024+1,32));child.emit("close",0);});return child;}) as unknown as typeof childProcess.spawn);
    await assert.rejects(runDepthArchitecture({...f.options,points:Array(150001).fill(f.options.points[0])}),/غير صالحة/);assert.equal(calls,0);
    await assert.rejects(runDepthArchitecture(f.options),/output file/);
    await assert.rejects(runDepthArchitecture(f.options),{code:"ENOENT"});assert.equal(calls,2);
  }finally{f.close();}
});
