import test from "node:test";
import assert from "node:assert/strict";
import {floorPlanSvgToPng} from "../src/components/imo3d/floorplan-download";

async function browserFixture(mode:"loaded"|"failed"|"waiting"|"no-canvas",run:(state:{revoked:string[];draws:number;allocated:number[];canvas:{width:number;height:number}|null})=>Promise<void>){
  const saved=["window","document","Image"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const),originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  const state={revoked:[] as string[],draws:0,allocated:[] as number[],canvas:null as {width:number;height:number}|null};
  class FixtureImage{
    naturalWidth=2200;naturalHeight=1300;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    set src(value:string){if(value)queueMicrotask(()=>{if(mode==="loaded"||mode==="no-canvas")this.onload?.();else if(mode==="failed")this.onerror?.();});}
  }
  Object.defineProperty(globalThis,"Image",{configurable:true,value:FixtureImage});
  Object.defineProperty(globalThis,"window",{configurable:true,value:{setTimeout,clearTimeout}});
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:(tag:string)=>{
    assert.equal(tag,"canvas");
    const canvas={width:0,height:0,getContext:()=>mode==="no-canvas"?null:{fillStyle:"",fillRect:()=>{},drawImage:()=>{state.draws++;state.allocated=[canvas.width,canvas.height];}},toBlob:(callback:(blob:Blob)=>void)=>queueMicrotask(()=>callback(new Blob(["PNG"],{type:"image/png"})))};
    state.canvas=canvas;return canvas;
  }}});
  URL.createObjectURL=()=>"blob:local-floor-plan";URL.revokeObjectURL=url=>state.revoked.push(url);
  try{await run(state);}finally{
    URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;
    for(const[key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
}

test("PNG export stays bounded, releases its SVG URL and clears the canvas after encoding",async()=>browserFixture("loaded",async state=>{
  const blob=await floorPlanSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="1300"/>');
  assert.equal(blob.type,"image/png");assert.equal(state.draws,1);assert.deepEqual(state.allocated,[4096,2420]);assert.deepEqual(state.revoked,["blob:local-floor-plan"]);assert.deepEqual([state.canvas?.width,state.canvas?.height],[0,0]);
}));
test("closing the map while PNG is decoding aborts and releases the source URL without a canvas",async()=>browserFixture("waiting",async state=>{
  const abort=new AbortController(),promise=floorPlanSvgToPng("<svg/>",abort.signal);abort.abort();
  await assert.rejects(promise,{name:"AbortError"});assert.equal(state.canvas,null);assert.deepEqual(state.revoked,["blob:local-floor-plan"]);
}));
test("invalid SVG reports a recoverable error and releases its URL",async()=>browserFixture("failed",async state=>{
  await assert.rejects(floorPlanSvgToPng("invalid"),/SVG/);assert.equal(state.draws,0);assert.deepEqual(state.revoked,["blob:local-floor-plan"]);
}));
test("unavailable canvas preserves SVG fallback and releases allocated resources",async()=>browserFixture("no-canvas",async state=>{
  await assert.rejects(floorPlanSvgToPng("<svg/>"),/SVG/);assert.equal(state.draws,0);assert.deepEqual(state.revoked,["blob:local-floor-plan"]);assert.deepEqual([state.canvas?.width,state.canvas?.height],[0,0]);
}));
