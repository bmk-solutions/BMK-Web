import {createHash} from "node:crypto";
import {lstat,open,readFile,realpath} from "node:fs/promises";

const path:typeof import("node:path")=process.getBuiltinModule("node:path");
export const jointGeometrySource="da3-validated-perspective-v1" as const;
export const maxJointGeometryFileBytes=32*1024*1024,maxJointGeometryBytes=1024*1024*1024;
const archivePattern=/^[0-9a-f]{64}-pitch-(?:neg30|pos30)\.npz$/;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const integer=(value:unknown,min:number,max:number):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const failure=()=>new Error("Invalid private joint geometry evidence");

export type JointGeometryEvidence={
  manifestPath:string;status:"complete"|"partial"|"unavailable";
  batchCount:number;viewCount:number;totalBytes:number;
};
type EvidenceScene={id:string;componentId:string;floor:number};

async function regularFile(file:string,maxBytes:number){
  const info=await lstat(file);
  if(info.isSymbolicLink()||!info.isFile()||info.size<1||info.size>maxBytes||path.relative(await realpath(file),file)!=="")throw failure();
  return info;
}

/** Private reconstruction input, never a tour asset, metric depth or acceptance decision. */
export async function readJointGeometryEvidence(attemptDirectory:string,scenes:readonly EvidenceScene[],summary:unknown,signal?:AbortSignal):Promise<JointGeometryEvidence>{
  const abort=()=>{if(signal?.aborted)throw new DOMException("Joint geometry cancelled","AbortError");};abort();
  if(!record(summary)||summary.version!==1||summary.source!==jointGeometrySource||summary.manifest!=="joint-geometry/manifest.json"||!["complete","partial","unavailable"].includes(String(summary.status)))throw failure();
  const attempt=await realpath(attemptDirectory),directory=path.join(attempt,"joint-geometry"),directoryInfo=await lstat(directory);
  if(directoryInfo.isSymbolicLink()||!directoryInfo.isDirectory()||path.relative(await realpath(directory),directory)!=="")throw failure();
  const manifestPath=path.join(directory,"manifest.json");await regularFile(manifestPath,512*1024);
  const manifest:unknown=JSON.parse(await readFile(manifestPath,"utf8"));abort();
  if(!record(manifest)||manifest.version!==1||manifest.source!==jointGeometrySource||manifest.status!==summary.status||
    !Array.isArray(manifest.files)||manifest.files.length>128||!integer(manifest.batchCount,0,128)||manifest.batchCount!==manifest.files.length||
    !integer(manifest.viewCount,0,1536)||!integer(manifest.totalBytes,0,maxJointGeometryBytes)||
    ["batchCount","viewCount","totalBytes"].some(key=>manifest[key]!==summary[key])||
    manifest.status==="complete"&&!manifest.files.length||manifest.status==="unavailable"&&manifest.files.length)throw failure();
  const byId=new Map(scenes.map(scene=>[scene.id,scene])),seen=new Set<string>();let totalBytes=0,viewCount=0;
  for(const entry of manifest.files){
    abort();
    if(!record(entry)||typeof entry.file!=="string"||!archivePattern.test(entry.file)||seen.has(entry.file)||
      !integer(entry.byteLength,1,maxJointGeometryFileBytes)||typeof entry.sha256!=="string"||!/^[a-f0-9]{64}$/.test(entry.sha256)||
      !integer(entry.viewCount,1,12)||!Array.isArray(entry.sceneIds)||entry.sceneIds.length<2||entry.sceneIds.length>3||
      new Set(entry.sceneIds).size!==entry.sceneIds.length||entry.viewCount<entry.sceneIds.length||
      !entry.sceneIds.every(id=>{if(typeof id!=="string")return false;const scene=byId.get(id);return scene&&scene.floor===entry.floor&&scene.componentId===entry.componentId;}))throw failure();
    seen.add(entry.file);totalBytes+=entry.byteLength;viewCount+=entry.viewCount;
    if(totalBytes>maxJointGeometryBytes||totalBytes>manifest.totalBytes)throw failure();
    const file=path.join(directory,entry.file),before=await regularFile(file,maxJointGeometryFileBytes);if(before.size!==entry.byteLength)throw failure();
    const handle=await open(file,"r"),hash=createHash("sha256");let bytes=0;
    try{
      const buffer=Buffer.alloc(1024*1024);
      for(;;){abort();const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>entry.byteLength)throw failure();hash.update(buffer.subarray(0,bytesRead));}
    }finally{await handle.close();}
    const after=await regularFile(file,maxJointGeometryFileBytes);
    if(bytes!==entry.byteLength||before.size!==after.size||before.mtimeMs!==after.mtimeMs||hash.digest("hex")!==entry.sha256)throw failure();
  }
  if(manifest.status==="complete")for(const name of seen){const other=name.includes("-pitch-neg30.")?name.replace("-pitch-neg30.","-pitch-pos30."):name.replace("-pitch-pos30.","-pitch-neg30.");if(!seen.has(other))throw failure();}
  if(totalBytes!==manifest.totalBytes||viewCount!==manifest.viewCount)throw failure();
  return{manifestPath,status:manifest.status as JointGeometryEvidence["status"],batchCount:manifest.batchCount,viewCount,totalBytes};
}
