import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat,mkdir,readFile,realpath,stat,writeFile} from "node:fs/promises";
import path from "node:path";
import {displayDepthSchema,type DisplayDepth,type Point} from "./model.ts";
import type {RoomProfile} from "./room-analysis";
import {readJointGeometryEvidence,type JointGeometryEvidence} from "./joint-geometry-evidence.ts";

export const jointDepthSource="da3-base-pose-conditioned-multiview" as const;
export type JointDepthScene={id:string;path:string;position:Point;yaw:number;componentId:string;floor:number};
export type JointPoint=Point&{r:number;g:number;b:number;confidence:number;sceneIds:string[];normal?:Point;floorConfidence?:number};
export type JointDepthResult={displayDepths:Record<string,DisplayDepth>;pointSamples:JointPoint[];warnings:string[];outputPath?:string;geometryEvidence?:JointGeometryEvidence};
type Options={scenes:JointDepthScene[];links:{from:string;to:string}[];roomProfiles?:Record<string,RoomProfile>;outputDir:string;assetRoots:string[];retainGeometryEvidence?:boolean;signal?:AbortSignal;timeoutMs?:number;onProgress?:(value:{completed:number;total:number})=>void};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
const coordinate=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1000;

/** Multi-camera rendering evidence stays separate from metric depth and authored walls. */
export function validateJointDepthResults(scenes:readonly Pick<JointDepthScene,"id"|"componentId"|"floor">[],output:unknown):JointDepthResult{
  const empty=():JointDepthResult=>({displayDepths:{},pointSamples:[],warnings:["تعذّر دمج العمق بين الصور محليًا؛ حُفظت نتائج التحليل المتاحة."]});
  if(!record(output)||output.version!==1||output.source!==jointDepthSource||output.units!=="camera_height"||output.purpose!=="display_only"||output.metric===true||!record(output.depths))return empty();
  const ids=new Map(scenes.map(scene=>[scene.id,scene])),depths=new Map<string,DisplayDepth>();
  for(const [id,raw] of Object.entries(output.depths)){
    if(!ids.has(id)||!record(raw)||raw.source!==jointDepthSource||raw.metric===true||raw.width!==128||raw.height!==64)continue;
    const result=displayDepthSchema.safeParse(raw);
    if(result.success&&result.data.confidence>=.45&&result.data.coverage>=.35)depths.set(id,result.data);
  }
  const pointSamples:JointPoint[]=[];
  if(Array.isArray(output.pointSamples)&&output.pointSamples.length<=150_000)for(const raw of output.pointSamples){
    if(!record(raw)||![raw.x,raw.y,raw.z].every(coordinate)||![raw.r,raw.g,raw.b].every(v=>typeof v==="number"&&Number.isInteger(v)&&v>=0&&v<=255)||typeof raw.confidence!=="number"||!Number.isFinite(raw.confidence)||raw.confidence<.45||raw.confidence>1||!Array.isArray(raw.sceneIds)||raw.sceneIds.length<2||raw.sceneIds.length>12)continue;
    if(!raw.sceneIds.every(id=>typeof id==="string"&&ids.has(id))||new Set(raw.sceneIds).size!==raw.sceneIds.length)continue;
    const members=(raw.sceneIds as string[]).map(id=>ids.get(id)!);
    if(members.some(member=>member.componentId!==members[0].componentId||member.floor!==members[0].floor))continue;
    const normal=record(raw.normal)&&[raw.normal.x,raw.normal.y,raw.normal.z].every(v=>coordinate(v)&&Math.abs(v)<=1.001)&&Math.abs(Math.hypot(raw.normal.x as number,raw.normal.y as number,raw.normal.z as number)-1)<.02?{x:raw.normal.x as number,y:raw.normal.y as number,z:raw.normal.z as number}:undefined;
    const floorConfidence=typeof raw.floorConfidence==="number"&&Number.isFinite(raw.floorConfidence)&&raw.floorConfidence>=0&&raw.floorConfidence<=1?raw.floorConfidence:undefined;
    pointSamples.push({x:raw.x as number,y:raw.y as number,z:raw.z as number,r:raw.r as number,g:raw.g as number,b:raw.b as number,confidence:raw.confidence,sceneIds:[...raw.sceneIds] as string[],...(normal?{normal}:{}),...(floorConfidence!==undefined?{floorConfidence}:{})});
  }
  const warnings=depths.size<ids.size?[`عمق متوافق بين الصور: ${depths.size} من ${ids.size} لقطة؛ الأجزاء غير المتحققة لا تُستكمل تلقائيًا.`]:[];
  if(Array.isArray(output.warnings)&&output.warnings.length)warnings.push("لم تكتمل مطابقة بعض مجموعات الصور؛ رُسمت الأسطح التي اجتازت التحقق فقط.");
  return{displayDepths:Object.fromEntries(depths),pointSamples,warnings};
}

/** Local model paths and photos are never resolved by the web request or a cloud API. */
export async function runJointDepth(options:Options):Promise<JointDepthResult>{
  if(options.signal?.aborted)throw new DOMException("Joint depth cancelled","AbortError");
  if(options.scenes.length<2||options.scenes.length>300||new Set(options.scenes.map(s=>s.id)).size!==options.scenes.length)throw new Error("قائمة الصور غير صالحة لدمج العمق.");
  const roots=await Promise.all(options.assetRoots.map(root=>realpath(root)));
  const scenes=await Promise.all(options.scenes.map(async scene=>{
    if(!/^[\w-]{1,80}$/.test(scene.id)||!scene.componentId||scene.componentId.length>160||!Number.isInteger(scene.floor)||scene.floor< -10||scene.floor>200||!scene.position||![scene.position.x,scene.position.y,scene.position.z].every(coordinate)||!Number.isFinite(scene.yaw))throw new Error("مواضع التصوير غير صالحة لدمج العمق.");
    const file=await realpath(scene.path);if(!roots.some(root=>within(root,file))||!(await stat(file)).isFile())throw new Error("ملف دمج العمق خارج مجلد الصور المعتمد.");
    return{...scene,path:file};
  }));
  const byId=new Map(scenes.map(scene=>[scene.id,scene]));
  const links=options.links.filter(link=>{const a=byId.get(link.from),b=byId.get(link.to);return a&&b&&a.id!==b.id&&a.componentId===b.componentId&&a.floor===b.floor;});
  if(!links.length)return validateJointDepthResults(scenes,undefined);
  let local:{python?:string}={};try{local=JSON.parse(await readFile(process.getBuiltinModule("node:path").join(process.cwd(),"work/reconstruction-runtime.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const python=process.env.IMO3D_PYTHON||local.python;if(!python)throw new Error("محرك العمق المحلي غير مهيأ.");
  const attempt=path.join(options.outputDir,"joint-depth-"+randomUUID());await mkdir(attempt,{recursive:true});
  const input=path.join(attempt,"joint-depth-input.json"),output=path.join(attempt,"joint-depth.json");
  await writeFile(input,JSON.stringify({version:1,scenes,links,roomProfiles:options.roomProfiles,retainGeometryEvidence:options.retainGeometryEvidence===true}),"utf8");
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(python,[path.join(process.cwd(),"scripts/imo3d-joint-depth.py"),"--input",input,"--output",output],{cwd:process.cwd(),windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",HF_HUB_DISABLE_TELEMETRY:"1",IMO3D_ANALYSIS_CACHE_DIR:path.join(options.outputDir,"analysis-cache")}});
    let buffer="",stderr="",failure:Error|undefined,settled=false,completed=-1;
    const abort=()=>{failure=new DOMException("Joint depth cancelled","AbortError");child.kill();};
    const timer=setTimeout(()=>{failure=new Error("انتهت مهلة دمج العمق المحلي.");child.kill();},options.timeoutMs??30*60_000);
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",abort);if(error)reject(error);else resolve();};
    options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
    child.stdout.setEncoding("utf8");child.stdout.on("data",(chunk:string)=>{
      buffer+=chunk;if(buffer.length>256_000){failure=new Error("Invalid joint depth progress");child.kill();return;}
      let end:number;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(!options.signal?.aborted&&value.event==="progress"&&value.stage==="joint_depth"&&Number.isInteger(value.completed)&&value.completed>=0&&value.completed>completed&&value.completed<=scenes.length&&value.total===scenes.length){completed=value.completed;options.onProgress?.({completed,total:value.total});}}catch{/* Model library logs are not protocol messages. */}}
    });
    child.stderr.setEncoding("utf8");child.stderr.on("data",(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
    child.once("error",error=>finish(error));child.once("close",code=>finish(failure??(code===0?undefined:new Error(stderr.includes("ModuleNotFoundError")?"بيئة نموذج العمق المحلي غير مكتملة.":"تعذّر دمج العمق بين الصور محليًا."))));
  });
  if(options.signal?.aborted)throw new DOMException("Joint depth cancelled","AbortError");
  const info=await lstat(output),resolved=await realpath(output),root=await realpath(attempt);
  if(info.isSymbolicLink()||!info.isFile()||info.size>64*1024*1024||path.relative(resolved,path.resolve(output))!==""||!within(root,resolved))throw new Error("Invalid joint depth output file");
  const raw:unknown=JSON.parse(await readFile(output,"utf8")),result=validateJointDepthResults(scenes,raw);
  if(options.retainGeometryEvidence){
    try{
      result.geometryEvidence=await readJointGeometryEvidence(attempt,scenes,record(raw)?raw.geometryEvidence:undefined,options.signal);
      if(result.geometryEvidence.status!=="complete")result.warnings.push("لم تكتمل بيانات العمق التفصيلية لإعادة البناء؛ لم يُعتمد مخطط بديل.");
    }catch(error){if(options.signal?.aborted)throw error;result.warnings.push("تعذر التحقق من بيانات العمق التفصيلية؛ حُفظت نتائج العرض المتاحة دون اعتماد مخطط بديل.");}
  }
  return{...result,outputPath:output};
}
