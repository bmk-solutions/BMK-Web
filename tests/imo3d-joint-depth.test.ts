import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {EventEmitter} from "node:events";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
import {PassThrough} from "node:stream";
import {jointDepthSource,runJointDepth,validateJointDepthResults} from "../src/lib/imo3d/joint-depth";
import {supportedDisplayDepth} from "../src/lib/imo3d/display-depth";

const scenes=[{id:"a",componentId:"main",floor:0},{id:"b",componentId:"main",floor:0},{id:"separate",componentId:"other",floor:0},{id:"upstairs",componentId:"main",floor:1}];
const depth=()=>({width:128,height:64,values:Array(8192).fill(2),confidence:.8,coverage:1,source:jointDepthSource,units:"camera_height",purpose:"display_only"});
const point=()=>({x:1,y:0,z:2,r:255,g:120,b:50,confidence:.8,sceneIds:["a","b"]});
const output=()=>({version:1,source:jointDepthSource,units:"camera_height",purpose:"display_only",depths:{a:depth()},pointSamples:[point()]});

test("joint output admits only current nonmetric depths and multiview same-component evidence",()=>{
  const accepted=validateJointDepthResults(scenes,{...output(),geometryEvidence:{manifestPath:"private/geometry/manifest.json"},depths:{a:{...depth(),privatePath:"secret"},foreign:depth()}});
  assert.equal("geometryEvidence" in accepted,false);
  assert.deepEqual(Object.keys(accepted.displayDepths),["a"]);assert.equal("privatePath" in accepted.displayDepths.a,false);assert.deepEqual(accepted.pointSamples,[point()]);
  for(const change of [{metric:true},{source:"cloud"},{units:"meters"},{purpose:"measurement"},{version:2}])assert.deepEqual(validateJointDepthResults(scenes,{...output(),...change}).displayDepths,{});
  for(const change of [{sceneIds:["a","foreign"]},{sceneIds:["a","a"]},{sceneIds:["a"]},{sceneIds:["a","separate"]},{sceneIds:["a","upstairs"]},{x:Infinity},{z:1001},{r:256},{g:.5},{confidence:NaN},{confidence:.4}])assert.equal(validateJointDepthResults(scenes,{...output(),pointSamples:[{...point(),...change}]}).pointSamples.length,0);
  const metadata={...point(),normal:{x:0,y:1,z:0},floorConfidence:.9};assert.deepEqual(validateJointDepthResults(scenes,{...output(),pointSamples:[metadata]}).pointSamples,[metadata]);
  assert.deepEqual(validateJointDepthResults(scenes,{...output(),pointSamples:[{...metadata,normal:{x:10,y:0,z:0},floorConfidence:NaN}]}).pointSamples,[point()]);
});

test("joint depth bounds, unsupported coverage and oversized point arrays cannot enter scene data",()=>{
  for(const change of [{width:256},{height:128},{values:Array(8192).fill(0),coverage:0},{values:Array(8192).fill(21)},{values:Array(8191).fill(2)},{coverage:.9},{confidence:.44},{metric:true}])assert.deepEqual(validateJointDepthResults(scenes,{...output(),depths:{a:{...depth(),...change}}}).displayDepths,{});
  assert.equal(validateJointDepthResults(scenes,{...output(),pointSamples:Array(150001).fill(point())}).pointSamples.length,0);
});

test("a near-camera fragment never replaces a broad fallback that the transition engine can use",()=>{
  const values=[...Array(6100).fill(2),...Array(100).fill(.15),...Array(1992).fill(0)];
  const result=validateJointDepthResults(scenes,{...output(),depths:{a:{...depth(),values,coverage:6200/8192}}});
  assert.ok(result.displayDepths.a);assert.equal(supportedDisplayDepth(result.displayDepths.a),undefined);
  const valid=validateJointDepthResults(scenes,output()).displayDepths.a;assert.equal(supportedDisplayDepth(valid),valid);
});

function fixture(){
  const previous=process.env.IMO3D_PYTHON;process.env.IMO3D_PYTHON=process.execPath;
  const root=path.resolve("work");mkdirSync(root,{recursive:true});const directory=mkdtempSync(path.join(root,"joint-depth-test-")),assets=path.join(directory,"assets");mkdirSync(assets);
  const photos=["a","b"].map((id,index)=>{const file=path.join(assets,id+".jpg");writeFileSync(file,"original "+id);return{id,path:file,position:{x:index,y:0,z:0},yaw:0,componentId:"main",floor:0};});
  return{directory,photos,options:{scenes:photos,links:[{from:"a",to:"b"}],outputDir:path.join(directory,"output"),assetRoots:[assets]},close(){if(previous===undefined)delete process.env.IMO3D_PYTHON;else process.env.IMO3D_PYTHON=previous;assert.ok(directory.startsWith(root+path.sep));rmSync(directory,{recursive:true,force:true});}};
}
function modelProcess(onKill=()=>{}){const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean};child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{onKill();setImmediate(()=>child.emit("close",null));return true;};return child;}

test("joint model is offline, isolates retries, strips unsupported links, and accepts only monotonic progress",async context=>{
  const f=fixture(),attempts:string[]=[],progress:number[]=[];try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[],options:childProcess.SpawnOptions)=>{
      assert.equal(options.windowsHide,true);assert.equal(options.env?.HF_HUB_OFFLINE,"1");assert.equal(options.env?.TRANSFORMERS_OFFLINE,"1");
      const input=JSON.parse(readFileSync(args[2],"utf8"));assert.deepEqual(input.links,[{from:"a",to:"b"}]);attempts.push(path.dirname(args[4]));
      const child=modelProcess();setImmediate(()=>{for(const completed of [0,1,0,3,2,2])child.stdout.write(JSON.stringify({event:"progress",stage:"joint_depth",completed,total:2})+"\n");writeFileSync(args[4],JSON.stringify(output()));child.emit("close",0);});return child;
    }) as unknown as typeof childProcess.spawn);
    const first=await runJointDepth({...f.options,links:[...f.options.links,{from:"a",to:"foreign"}],onProgress:p=>progress.push(p.completed)});await runJointDepth(f.options);
    assert.deepEqual(progress,[0,1,2]);assert.equal(new Set(attempts).size,2);assert.equal(first.pointSamples.length,1);assert.equal(readFileSync(f.photos[0].path,"utf8"),"original a");
  }finally{f.close();}
});

test("joint cancellation kills the model and never accepts late partial output",async context=>{
  const f=fixture(),controller=new AbortController();let killed=0;try{
    context.mock.method(childProcess,"spawn",(()=>{const child=modelProcess(()=>killed++);setImmediate(()=>controller.abort());return child;}) as unknown as typeof childProcess.spawn);
    await assert.rejects(runJointDepth({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(killed,1);
    await assert.rejects(runJointDepth({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(killed,1);
  }finally{f.close();}
});

test("requesting retained evidence cannot mistake a legacy display-only result for full geometry",async context=>{
  const f=fixture();try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{
      assert.equal(JSON.parse(readFileSync(args[2],"utf8")).retainGeometryEvidence,true);
      const child=modelProcess();setImmediate(()=>{writeFileSync(args[4],JSON.stringify(output()));child.emit("close",0);});return child;
    }) as unknown as typeof childProcess.spawn);
    const result=await runJointDepth({...f.options,retainGeometryEvidence:true});
    assert.equal(result.geometryEvidence,undefined);assert.equal(result.pointSamples.length,1);
    assert.ok(result.warnings.some(warning=>warning.includes("العمق التفصيلية")));
  }finally{f.close();}
});

test("joint supervisor refuses missing retry outputs and foreign asset roots",async context=>{
  const f=fixture();try{
    context.mock.method(childProcess,"spawn",(()=>{const child=modelProcess();setImmediate(()=>child.emit("close",0));return child;}) as unknown as typeof childProcess.spawn);
    await assert.rejects(runJointDepth(f.options));
    const unrelated=path.join(f.directory,"unrelated");mkdirSync(unrelated);
    await assert.rejects(runJointDepth({...f.options,assetRoots:[unrelated]}),/خارج/);
  }finally{f.close();}
});
