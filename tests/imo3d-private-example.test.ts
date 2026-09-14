import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdirSync,readFileSync,unlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {privateExamplePreview,readPrivateExample} from "../src/lib/imo3d/private-example";
import {syntheticTour} from "./fixtures/imo3d-synthetic-tour";

function withFixture(content:string,action:(file:string)=>void){
  const directory=path.join(process.cwd(),"work","imo3d-private-example-tests");mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${randomUUID()}.json`),previous=process.env;
  writeFileSync(file,content,{flag:"wx"});
  try{process.env={...previous,NODE_ENV:"development",IMO3D_EXAMPLE_FILE:file};delete process.env.VERCEL;action(file);}
  finally{process.env=previous;unlinkSync(file);}
}

test("optional private example is loaded on explicit local use without changing its bytes",()=>{
  const input=JSON.stringify(syntheticTour());
  withFixture(input,file=>{assert.deepEqual(readPrivateExample(),syntheticTour());assert.equal(readFileSync(file,"utf8"),input);});
});

test("production and hosted environments cannot expose an optional local example",()=>{
  withFixture(JSON.stringify(syntheticTour()),()=>{
    process.env={...process.env,NODE_ENV:"production"};assert.equal(readPrivateExample(),null);assert.equal(privateExamplePreview(),null);
    process.env={...process.env,NODE_ENV:"development",VERCEL:"1"};assert.equal(readPrivateExample(),null);assert.equal(privateExamplePreview(),null);
  });
});

test("a missing configured fixture does not fall back to another apartment",()=>{
  withFixture(JSON.stringify(syntheticTour()),file=>{process.env.IMO3D_EXAMPLE_FILE=`${file}.missing`;assert.equal(readPrivateExample(),null);assert.equal(privateExamplePreview(),null);});
});

test("invalid optional input is unavailable rather than crashing startup",()=>{
  for(const content of ["not JSON",JSON.stringify({id:"invalid"}),JSON.stringify({...syntheticTour(),scenes:[{...syntheticTour().scenes[0],image:"https://outside.invalid/a.jpg"}]})])withFixture(content,()=>assert.equal(readPrivateExample(),null));
});

test("local preview exposes only the minimal sample identity and thumbnail",()=>{
  const tour=syntheticTour();
  withFixture(JSON.stringify(tour),()=>assert.deepEqual(privateExamplePreview(),{id:tour.id,title:tour.title,thumbnail:tour.scenes[0].preview}));
});
