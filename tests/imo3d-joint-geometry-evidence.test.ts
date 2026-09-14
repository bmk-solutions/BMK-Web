import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,writeFile,symlink,rm} from "node:fs/promises";
import path from "node:path";
import {readJointGeometryEvidence,jointGeometrySource,maxJointGeometryBytes} from "../src/lib/imo3d/joint-geometry-evidence";

const scenes=[{id:"a",componentId:"main",floor:0},{id:"b",componentId:"main",floor:0}];
async function fixture(){
  const work=path.resolve("work"),root=path.join(work,"geometry-evidence-test-"+randomUUID()),directory=path.join(root,"joint-geometry");await mkdir(directory,{recursive:true});
  const bytes=Buffer.from("synthetic local evidence; no photo data"),hash=createHash("sha256").update(bytes).digest("hex");
  const files=["neg30","pos30"].map(pitch=>({file:`${"a".repeat(64)}-pitch-${pitch}.npz`,byteLength:bytes.length,sha256:hash,viewCount:8,sceneIds:["a","b"],componentId:"main",floor:0}));
  for(const entry of files)await writeFile(path.join(directory,entry.file),bytes);
  const manifest={version:1,source:jointGeometrySource,status:"complete",files,batchCount:2,viewCount:16,totalBytes:bytes.length*2,warnings:[]};
  const summary={version:1,source:jointGeometrySource,status:"complete",manifest:"joint-geometry/manifest.json",batchCount:2,viewCount:16,totalBytes:bytes.length*2,warnings:[]};
  const save=()=>writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest));await save();
  return{root,directory,manifest,summary,save,async close(){assert.ok(root.startsWith(work+path.sep));await rm(root,{recursive:true,force:true});}};
}

test("organized evidence remains a private path and exact file hashes and physical frames are verified",async()=>{
  const f=await fixture();try{
    const result=await readJointGeometryEvidence(f.root,scenes,f.summary);
    assert.equal(result.status,"complete");assert.equal(result.batchCount,2);assert.equal(result.viewCount,16);
    assert.equal(result.manifestPath,path.join(f.directory,"manifest.json"));assert.equal("files" in result,false);
    await assert.rejects(readJointGeometryEvidence(f.root,[scenes[0],{...scenes[1],floor:1}],f.summary),/Invalid/);
    await writeFile(path.join(f.directory,f.manifest.files[0].file),Buffer.alloc(f.manifest.files[0].byteLength,7));
    await assert.rejects(readJointGeometryEvidence(f.root,scenes,f.summary),/Invalid/);
  }finally{await f.close();}
});

test("legacy summaries, traversal, duplicate evidence and incorrect totals are rejected",async()=>{
  const f=await fixture();try{
    for(const summary of [undefined,{}, {...f.summary,manifest:"../manifest.json"},{...f.summary,totalBytes:maxJointGeometryBytes+1},{...f.summary,batchCount:1}])await assert.rejects(readJointGeometryEvidence(f.root,scenes,summary),/Invalid/);
    const saved=structuredClone(f.manifest);
    for(const change of [()=>{f.manifest.files[0].file="../other.npz";},()=>{f.manifest.files[1].file=f.manifest.files[0].file;},()=>{f.manifest.files[0].sha256="b".repeat(64);},()=>{f.manifest.files[0].sceneIds=["a","a"];},()=>{f.manifest.files[0].componentId="other";}]){
      Object.assign(f.manifest,structuredClone(saved));change();await f.save();await assert.rejects(readJointGeometryEvidence(f.root,scenes,f.summary),/Invalid/);
    }
  }finally{await f.close();}
});

test("a single pitch can be partial evidence but cannot be labelled complete",async()=>{
  const f=await fixture();try{
    f.manifest.files.pop();f.manifest.batchCount=1;f.manifest.viewCount=8;f.manifest.totalBytes/=2;
    Object.assign(f.summary,{batchCount:1,viewCount:8,totalBytes:f.manifest.totalBytes});await f.save();
    await assert.rejects(readJointGeometryEvidence(f.root,scenes,f.summary),/Invalid/);
    f.manifest.status="partial";f.summary.status="partial";await f.save();
    assert.equal((await readJointGeometryEvidence(f.root,scenes,f.summary)).status,"partial");
  }finally{await f.close();}
});

test("geometry evidence never follows a directory junction and cancellation stops validation",async()=>{
  const f=await fixture();try{
    const linked=path.join(f.root,"linked-attempt");await mkdir(linked);
    await symlink(f.directory,path.join(linked,"joint-geometry"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(readJointGeometryEvidence(linked,scenes,f.summary),/Invalid/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(readJointGeometryEvidence(f.root,scenes,f.summary,controller.signal),{name:"AbortError"});
  }finally{await f.close();}
});
