import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {EventEmitter} from "node:events";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
import {PassThrough} from "node:stream";
import {runRoomAnalysis,validateRoomAnalysisResults,validRoomProfile,validateDisplayDepthResults,validRoomDisplayDepth} from "../src/lib/imo3d/room-analysis";

const profile=()=>({floorBoundaryRadians:Array(1024).fill(.5),ceilingBoundaryRadians:Array(1024).fill(-.4),cornerProbabilities:Array(1024).fill(.1)});
test("room boundary profiles require a complete finite angular envelope",()=>{
  assert.equal(validRoomProfile(profile()),true);
  assert.equal(validRoomProfile({...profile(),cornerProbabilities:undefined}),true);
  const bad=profile();bad.floorBoundaryRadians[15]=Number.NaN;assert.equal(validRoomProfile(bad),false);
  assert.equal(validRoomProfile({...profile(),floorBoundaryRadians:Array(1023).fill(.5)}),false);
  assert.equal(validRoomProfile({...profile(),floorBoundaryRadians:Array(10_000).fill(.5)}),false);
  assert.equal(validRoomProfile(null),false);
});
test("inverted, out-of-range, and fabricated floor/ceiling profiles are rejected",()=>{
  for(const value of [-.2,0,Math.PI/2,Infinity]){const p=profile();p.floorBoundaryRadians[9]=value;assert.equal(validRoomProfile(p),false);}
  for(const value of [.2,0,-Math.PI/2,NaN]){const p=profile();p.ceilingBoundaryRadians[9]=value;assert.equal(validRoomProfile(p),false);}
  const p=profile();p.cornerProbabilities[4]=1.01;assert.equal(validRoomProfile(p),false);
  assert.equal(validRoomProfile({floorBoundaryRadians:{length:1024},ceilingBoundaryRadians:Array(1024).fill(-.5)}),false);
});

const observation=(sceneId="photo",id="observation-"+sceneId)=>({id,sceneId,kind:"kitchen",confidence:.86,evidence:["Stove and kitchen cabinets"],model:"local-test"});
const displayDepth=(sceneId="photo")=>({sceneId,width:128,height:64,values:Array(8192).fill(2),confidence:.75,coverage:1,source:"monocular-multiview-floor-aligned",units:"camera_height",purpose:"display_only",metric:false});
test("display depth accepts only bounded nonmetric current-scene arrays and strips private diagnostics",()=>{
  const output={version:"photo-depth-overlap-v2-128",scenes:[{...displayDepth(),confidenceValues:Array(8192).fill(.8),privatePath:"hidden"},displayDepth("other"),displayDepth()]};
  const result=validateDisplayDepthResults(["photo"],output);
  assert.deepEqual(Object.keys(result.displayDepths!),["photo"]);assert.deepEqual(result.warnings,[]);
  assert.equal("privatePath" in result.displayDepths!.photo,false);assert.equal("confidenceValues" in result.displayDepths!.photo,false);
  for(const change of [{metric:true},{units:"metric"},{purpose:"measurement"},{width:256},{height:128},{confidence:NaN},{confidence:.2},{coverage:.1},{coverage:.9},{values:Array(8192).fill(Infinity)},{values:Array(8192).fill(21)},{values:Array(8191).fill(2)}])assert.equal(validRoomDisplayDepth({...displayDepth(),...change}),false);
  assert.equal(validateDisplayDepthResults(["photo"],{version:"old-version",scenes:[displayDepth()]}).displayDepths,undefined);
});
test("partial or malformed model envelopes are bounded to current scene IDs without granting metric scale",()=>{
  const accepted=validateRoomAnalysisResults(["photo"],{version:1,scale:"camera_height",profiles:{photo:profile(),foreign:profile()}},{inference:"local_cpu",observations:[observation("foreign"),observation(),observation("photo","duplicate")]});
  assert.deepEqual(Object.keys(accepted.profiles),["photo"]);assert.equal(accepted.observations.length,1);assert.deepEqual(accepted.warnings,[]);
  for(const scale of ["metric","relative",undefined])assert.equal(Object.keys(validateRoomAnalysisResults(["photo"],{version:1,scale,profiles:{photo:profile()}},null).profiles).length,0);
  for(const invalid of [null,[],"invalid",{inference:"local_cpu",observations:{}},{inference:"remote",observations:[observation()]}]){
    const result=validateRoomAnalysisResults(["photo"],invalid,invalid);assert.deepEqual(result.profiles,{});assert.deepEqual(result.observations,[]);assert.ok(result.warnings.length>=2);
  }
  const duplicate=validateRoomAnalysisResults(["one","two"],null,{inference:"local_cpu",observations:[observation("one","duplicate"),observation("two","duplicate")]});
  assert.equal(duplicate.observations.length,1);
});

function fixture(){
  const previousPython=process.env.IMO3D_PYTHON;process.env.IMO3D_PYTHON=process.execPath;
  const root=path.resolve("work");mkdirSync(root,{recursive:true});const directory=mkdtempSync(path.join(root,"room-analysis-test-")),assets=path.join(directory,"assets"),outputDir=path.join(directory,"outputs");mkdirSync(assets);mkdirSync(outputDir);
  const image=path.join(assets,"photo.jpg");writeFileSync(image,"isolated input bytes");
  return{directory,assets,image,options:{scenes:[{id:"photo",path:image}],assetRoots:[assets],outputDir},close:()=>{if(previousPython===undefined)delete process.env.IMO3D_PYTHON;else process.env.IMO3D_PYTHON=previousPython;assert.ok(directory.startsWith(root+path.sep));rmSync(directory,{recursive:true,force:true});}};
}
function modelProcess(onKill:()=>void=()=>{}){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean};child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{onKill();setImmediate(()=>child.emit("close",null));return true;};return child;
}
test("reclaimed invocations never consume stale successful files when a model exits before writing",async context=>{
  const f=fixture(),outputs:string[]=[];try{
    writeFileSync(path.join(f.options.outputDir,"room-profiles.json"),JSON.stringify({version:1,scale:"camera_height",profiles:{photo:profile()}}));
    writeFileSync(path.join(f.options.outputDir,"room-vision.json"),JSON.stringify({inference:"local_cpu",observations:[observation()]}));
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{outputs.push(args[4]);const child=modelProcess();setImmediate(()=>child.emit("close",2));return child;}) as unknown as typeof childProcess.spawn);
    for(let i=0;i<2;i++){const result=await runRoomAnalysis(f.options);assert.deepEqual(result.profiles,{});assert.deepEqual(result.observations,[]);assert.ok(result.warnings.length>=2);}
    assert.equal(new Set(outputs.map(file=>path.dirname(file))).size,2);
    assert.equal(readFileSync(f.image,"utf8"),"isolated input bytes");
  }finally{f.close();}
});
test("wrapper accepts current output and only reports monotonically advancing protocol progress",async context=>{
  const f=fixture(),progress:{stage:string;completed:number}[]=[];try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{
      const child=modelProcess(),stage=args[0].includes("horizon")?"boundaries":args[0].includes("photo-depth")?"photo_depth":"room_recognition";
      setImmediate(()=>{for(const value of [{stage,completed:1,total:1},{event:"progress",stage,completed:0,total:2},{event:"progress",stage,completed:0,total:1},{event:"progress",stage,completed:1,total:1},{event:"progress",stage,completed:0,total:1},{event:"progress",stage,completed:1,total:1}])child.stdout.write(JSON.stringify(value)+"\n");
        writeFileSync(args[4],JSON.stringify(stage==="boundaries"?{version:1,scale:"camera_height",profiles:{photo:profile()}}:stage==="photo_depth"?{version:"photo-depth-overlap-v2-128",scenes:[displayDepth()]}:{inference:"local_cpu",observations:[observation()]}));child.emit("close",0);});return child;
    }) as unknown as typeof childProcess.spawn);
    const result=await runRoomAnalysis({...f.options,onProgress:value=>progress.push(value)});assert.equal(result.observations.length,1);assert.equal(Object.keys(result.profiles).length,1);
    assert.equal(result.displayDepths?.photo.values.length,8192);
    for(const stage of ["boundaries","room_recognition","photo_depth"])assert.deepEqual(progress.filter(item=>item.stage===stage).map(item=>item.completed),[0,1]);
  }finally{f.close();}
});
test("abort terminates both local model processes and returns no partial successful result",async context=>{
  const f=fixture(),controller=new AbortController();let spawned=0,killed=0;try{
    context.mock.method(childProcess,"spawn",(()=>{const child=modelProcess(()=>killed++);if(++spawned===2)setImmediate(()=>controller.abort());return child;}) as unknown as typeof childProcess.spawn);
    await assert.rejects(runRoomAnalysis({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(spawned,2);assert.equal(killed,2);
    await assert.rejects(runRoomAnalysis({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(spawned,2);
  }finally{f.close();}
});
test("input directories and files outside approved assets are rejected before any model starts",async context=>{
  const f=fixture();let spawned=0;try{
    context.mock.method(childProcess,"spawn",(()=>{spawned++;return modelProcess();}) as unknown as typeof childProcess.spawn);
    const outside=path.join(f.directory,"outside.jpg");writeFileSync(outside,"outside");
    for(const file of [outside,f.assets])await assert.rejects(runRoomAnalysis({...f.options,scenes:[{id:"photo",path:file}]}),/خارج/);
    assert.equal(spawned,0);assert.equal(readFileSync(outside,"utf8"),"outside");
  }finally{f.close();}
});

test("photo depth waits for current boundaries and its failure cannot discard successful room analysis",async context=>{
  const f=fixture(),started:string[]=[];let boundariesReady=false;try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{
      const child=modelProcess(),stage=args[0].includes("horizon")?"boundaries":args[0].includes("photo-depth")?"photo_depth":"recognition";started.push(stage);
      if(stage==="photo_depth"){
        assert.ok(boundariesReady);const request=JSON.parse(readFileSync(args[2],"utf8"));assert.equal(request.roomProfiles.photo.floorBoundaryRadians.length,1024);
        setImmediate(()=>child.emit("close",2));
      }else setImmediate(()=>{writeFileSync(args[4],JSON.stringify(stage==="boundaries"?{version:1,scale:"camera_height",profiles:{photo:profile()}}:{inference:"local_cpu",observations:[observation()]}));if(stage==="boundaries")boundariesReady=true;child.emit("close",0);});
      return child;
    }) as unknown as typeof childProcess.spawn);
    const result=await runRoomAnalysis(f.options);
    assert.deepEqual(started,["boundaries","recognition","photo_depth","photo_depth"]);assert.equal(Object.keys(result.profiles).length,1);assert.equal(result.observations.length,1);assert.equal(result.displayDepths,undefined);assert.ok(result.warnings.some(value=>value.includes("عمق العرض")));
  }finally{f.close();}
});

test("abort while depth and recognition run terminates both without consuming previous output",async context=>{
  const f=fixture(),controller=new AbortController();let killed=0;try{
    context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{
      const child=modelProcess(()=>killed++);
      if(args[0].includes("horizon"))setImmediate(()=>{writeFileSync(args[4],JSON.stringify({version:1,scale:"camera_height",profiles:{photo:profile()}}));child.emit("close",0);});
      else if(args[0].includes("photo-depth"))setImmediate(()=>controller.abort());
      return child;
    }) as unknown as typeof childProcess.spawn);
    await assert.rejects(runRoomAnalysis({...f.options,signal:controller.signal}),{name:"AbortError"});assert.equal(killed,2);
  }finally{f.close();}
});

test("failed depth retries once after recognition and uses a new output file",async context=>{
 const f=fixture();let attempts=0,recognitionDone=false;const depthOutputs:string[]=[];
 try{
  context.mock.method(childProcess,"spawn",((_python:string,args:readonly string[])=>{
   const child=modelProcess(),isDepth=args[0].includes("photo-depth"),isBoundary=args[0].includes("horizon");
   if(isDepth){attempts++;depthOutputs.push(args[4]);}
   setImmediate(()=>{
    if(isDepth&&attempts===1){child.emit("close",2);return;}
    if(isDepth)assert.equal(recognitionDone,true);
    if(!isDepth&&!isBoundary)recognitionDone=true;
    writeFileSync(args[4],JSON.stringify(isBoundary?{version:1,scale:"camera_height",profiles:{photo:profile()}}:isDepth?{version:"photo-depth-overlap-v2-128",scenes:[displayDepth()]}:{inference:"local_cpu",observations:[observation()]}));child.emit("close",0);
   });return child;
  }) as unknown as typeof childProcess.spawn);
  const result=await runRoomAnalysis(f.options);assert.equal(attempts,2);assert.equal(new Set(depthOutputs).size,2);assert.ok(result.displayDepths?.photo);
 }finally{f.close();}
});
