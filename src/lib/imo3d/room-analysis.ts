import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat,mkdir,readFile,realpath,stat,writeFile} from "node:fs/promises";
import path from "node:path";
import {roomObservationSchema,roomSuiteObservationSchema,type RoomObservation,type RoomSuiteObservation} from "./room-semantics.ts";

export type RoomProfile={floorBoundaryRadians:number[];ceilingBoundaryRadians:number[];cornerProbabilities?:number[]};
export type RoomDisplayDepth={width:number;height:number;values:number[];confidence:number;coverage:number;source:"monocular-multiview-floor-aligned";units:"camera_height";purpose:"display_only"};
export type RoomAnalysisResult={profiles:Record<string,RoomProfile>;observations:RoomObservation[];suiteObservations?:RoomSuiteObservation[];displayDepths?:Record<string,RoomDisplayDepth>;warnings:string[]};
export type RoomAnalysisProgress={stage:"boundaries"|"room_recognition"|"photo_depth";completed:number;total:number};
type Options={scenes:{id:string;path:string}[];outputDir:string;assetRoots:string[];signal?:AbortSignal;timeoutMs?:number;onProgress?:(progress:RoomAnalysisProgress)=>void};

export function validRoomProfile(value:unknown):value is RoomProfile{
  if(!value||typeof value!=="object")return false;
  const p=value as RoomProfile,n=p.floorBoundaryRadians?.length;
  if(!Number.isInteger(n)||n<64||n>4096||!Array.isArray(p.floorBoundaryRadians)||!Array.isArray(p.ceilingBoundaryRadians)||p.ceilingBoundaryRadians.length!==n)return false;
  if(!p.floorBoundaryRadians.every((v,i)=>Number.isFinite(v)&&v>0&&v<Math.PI/2&&Number.isFinite(p.ceilingBoundaryRadians[i])&&p.ceilingBoundaryRadians[i]<0&&p.ceilingBoundaryRadians[i]>-Math.PI/2))return false;
  return p.cornerProbabilities===undefined||Array.isArray(p.cornerProbabilities)&&p.cornerProbabilities.length===n&&p.cornerProbabilities.every(v=>Number.isFinite(v)&&v>=0&&v<=1);
}

function within(root:string,file:string){const relative=path.relative(root,file);return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);}

async function run(python:string,script:string,input:string,output:string,stage:RoomAnalysisProgress["stage"],options:Options){
  if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(python,[path.join(process.cwd(),"scripts",script),"--input",input,"--output",output],{
      cwd:process.cwd(),windowsHide:true,stdio:["ignore","pipe","pipe"],
      env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",HF_HUB_DISABLE_TELEMETRY:"1",IMO3D_ANALYSIS_CACHE_DIR:path.join(options.outputDir,"analysis-cache")},
    });
    let buffer="",stderr="",failure:Error|undefined,settled=false,completed=-1;
    const abort=()=>{failure=new DOMException("Room analysis cancelled","AbortError");child.kill();};
    const timeout=setTimeout(()=>{failure=new Error("انتهت مهلة تحليل حدود الغرف وأسمائها.");child.kill();},options.timeoutMs??20*60_000);
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timeout);options.signal?.removeEventListener("abort",abort);if(error)reject(error);else resolve();};
    options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
    child.stdout.setEncoding("utf8");child.stdout.on("data",(chunk:string)=>{
      buffer+=chunk;if(buffer.length>256_000){failure=new Error("Invalid room analysis output");child.kill();return;}
      let end:number;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
        const value=JSON.parse(line);if(!options.signal?.aborted&&value?.event==="progress"&&value.stage===stage&&Number.isInteger(value.completed)&&Number.isInteger(value.total)&&value.completed>completed&&value.completed>=0&&value.completed<=value.total&&value.total===options.scenes.length){completed=value.completed;options.onProgress?.({stage,completed,total:value.total});}
      }catch{/* Ignore non-protocol library logs. */}}
    });
    child.stderr.setEncoding("utf8");child.stderr.on("data",(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
    child.once("error",error=>finish(error));child.once("close",code=>finish(failure??(code===0||code===2?undefined:new Error(stderr.includes("ModuleNotFoundError")?"بيئة نماذج تحليل الغرف غير مكتملة.":"تعذّر تشغيل نموذج تحليل الغرف المحلي."))));
  });
  if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  const target=await realpath(output),root=await realpath(path.dirname(output)),info=await lstat(output);
  if(info.isSymbolicLink()||path.relative(target,path.resolve(output))!==""||!within(root,target)||!info.isFile()||info.size>64*1024*1024)throw new Error("Invalid room analysis output file");
  return JSON.parse(await readFile(output,"utf8"));
}

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function validRoomDisplayDepth(value:unknown):value is RoomDisplayDepth{
  if(!record(value)||value.width!==128||value.height!==64||value.source!=="monocular-multiview-floor-aligned"||value.units!=="camera_height"||value.purpose!=="display_only"||value.metric===true)return false;
  if(typeof value.confidence!=="number"||!Number.isFinite(value.confidence)||value.confidence<.25||value.confidence>1||typeof value.coverage!=="number"||!Number.isFinite(value.coverage)||value.coverage<.35||value.coverage>1)return false;
  if(!Array.isArray(value.values)||value.values.length!==8192||!value.values.every(item=>typeof item==="number"&&Number.isFinite(item)&&item>=0&&item<=20))return false;
  return Math.abs(value.values.filter(item=>item>0).length/8192-value.coverage)<1/8192;
}

export function validateDisplayDepthResults(sceneIds:readonly string[],output:unknown):{displayDepths?:Record<string,RoomDisplayDepth>;warnings:string[]}{
  const ids=new Set(sceneIds),depths=new Map<string,RoomDisplayDepth>();
  if(record(output)&&output.version==="photo-depth-overlap-v2-128"&&Array.isArray(output.scenes))for(const value of output.scenes){
    const sceneId=record(value)?value.sceneId:undefined;
    if(typeof sceneId!=="string"||!ids.has(sceneId)||depths.has(sceneId)||!validRoomDisplayDepth(value))continue;
    const {width,height,values,confidence,coverage,source,units,purpose}=value;
    depths.set(sceneId,{width,height,values,confidence,coverage,source,units,purpose});
  }
  const warnings=depths.size<ids.size?[`تقدير عمق العرض متاح لـ ${depths.size} من ${ids.size} لقطة؛ تبقى الصور الأخرى متاحة دون إزاحة بصرية.`]:[];
  return{...(depths.size?{displayDepths:Object.fromEntries(depths)}:{}),warnings};
}
/** Partial model failures never grant metric scale or inject another tour's IDs. */
export function validateRoomAnalysisResults(sceneIds:readonly string[],boundaries:unknown,recognition:unknown):RoomAnalysisResult{
  const profiles=new Map<string,RoomProfile>(),observations:RoomObservation[]=[],warnings:string[]=[],ids=new Set(sceneIds);
  if(record(boundaries)&&boundaries.version===1&&boundaries.scale==="camera_height"&&record(boundaries.profiles)){
    for(const [id,value] of Object.entries(boundaries.profiles))if(ids.has(id)&&validRoomProfile(value))profiles.set(id,value);
  }else warnings.push("تعذّر استخراج حدود الغرف محليًا؛ راجع إعداد نموذج الحدود.");
  if(record(recognition)&&recognition.inference==="local_cpu"&&Array.isArray(recognition.observations)){
    const seenScenes=new Set<string>(),seenIds=new Set<string>();for(const value of recognition.observations){const parsed=roomObservationSchema.safeParse(value);if(parsed.success&&ids.has(parsed.data.sceneId)&&!seenScenes.has(parsed.data.sceneId)&&!seenIds.has(parsed.data.id)){seenScenes.add(parsed.data.sceneId);seenIds.add(parsed.data.id);observations.push(parsed.data);}}
  }else warnings.push("تعذّر التعرف على أسماء الغرف محليًا؛ راجع إعداد نموذج الرؤية.");
  if(profiles.size<ids.size)warnings.push(`حدود قابلة للتحليل: ${profiles.size} من ${ids.size} لقطة.`);
  if(observations.length<ids.size)warnings.push(`صور تم التعرف على محتواها: ${observations.length} من ${ids.size}.`);
  const suiteObservations:RoomSuiteObservation[]=[];
  if(record(recognition)&&recognition.inference==="local_cpu"&&Array.isArray(recognition.bathroomDoorways))for(const [index,raw] of recognition.bathroomDoorways.slice(0,ids.size*16).entries()){
    if(!record(raw))continue;
    // Fixture detection proposes a bathroom; it cannot certify access/privacy.
    const parsed=roomSuiteObservationSchema.safeParse({...raw,id:`bathroom-view-${raw.sceneId}-${index}`,verified:false,direct:false,doorwayVerified:false,privateToFrom:false,privacyConfidence:0});
    if(parsed.success&&ids.has(parsed.data.sceneId))suiteObservations.push(parsed.data);
  }
  return{profiles:Object.fromEntries(profiles),observations,...(suiteObservations.length?{suiteObservations}:{}),warnings};
}

/** Offline photo analysis; every path is resolved inside the tour's private assets. */
export async function runRoomAnalysis(options:Options):Promise<RoomAnalysisResult>{
  if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  if(!options.scenes.length||options.scenes.length>300||new Set(options.scenes.map(s=>s.id)).size!==options.scenes.length)throw new Error("قائمة الصور غير صالحة للتحليل.");
  const roots=await Promise.all(options.assetRoots.map(root=>realpath(root)));
  const scenes=await Promise.all(options.scenes.map(async scene=>{const file=await realpath(scene.path);if(!/^[\w-]{1,80}$/.test(scene.id)||!roots.some(root=>within(root,file))||!(await stat(file)).isFile())throw new Error("ملف التحليل خارج مجلد الصور المعتمد.");return{id:scene.id,path:file};}));
  // Runtime files are machine configuration, not bundled website assets.
  const runtimePath=process.getBuiltinModule("node:path").join(process.cwd(),"work","reconstruction-runtime.json");
  let local:{python?:string}={};try{local=JSON.parse(await readFile(runtimePath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const python=process.env.IMO3D_PYTHON||local.python;
  if(!python)throw new Error("محرك تحليل الغرف المحلي غير مهيأ.");
  if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  // Reclaimed leases may reuse the job directory. Only this invocation's files
  // can be consumed, even if an earlier process finished late or left a result.
  const attemptDir=path.join(options.outputDir,"room-analysis-"+randomUUID());
  await mkdir(attemptDir,{recursive:true});const input=path.join(attemptDir,"room-analysis-input.json");await writeFile(input,JSON.stringify({scenes}),"utf8");
  const boundaries=run(python,"imo3d-horizon-layout.py",input,path.join(attemptDir,"room-profiles.json"),"boundaries",options);
  const recognition=run(python,"imo3d-room-vision.py",input,path.join(attemptDir,"room-vision.json"),"room_recognition",options);
  const analyzeDepth=async(value:unknown,filename="photo-depth.json")=>{
    if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
    const profiles:Record<string,RoomProfile>=Object.create(null);
    if(record(value)&&value.version===1&&value.scale==="camera_height"&&record(value.profiles))for(const scene of scenes){const profile=value.profiles[scene.id];if(validRoomProfile(profile))profiles[scene.id]=profile;}
    const supported=scenes.filter(scene=>profiles[scene.id]);if(!supported.length)return undefined;
    const depthInput=path.join(attemptDir,"photo-depth-input.json");await writeFile(depthInput,JSON.stringify({scenes:supported,roomProfiles:profiles}),"utf8");
    return run(python,"imo3d-photo-depth.py",depthInput,path.join(attemptDir,filename),"photo_depth",{...options,scenes:supported});
  };
  const displayDepth=boundaries.then(value=>analyzeDepth(value));
  const results=await Promise.allSettled([boundaries,recognition,displayDepth]);
  if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  // Retry once with the other local models unloaded, using a fresh output file.
  if(results[2].status==="rejected"&&results[0].status==="fulfilled"){
    try{results[2]={status:"fulfilled",value:await analyzeDepth(results[0].value,"photo-depth-retry.json")};}catch{/* Preserve the original failure and the other successful analyses. */}
    if(options.signal?.aborted)throw new DOMException("Room analysis cancelled","AbortError");
  }
  const ids=scenes.map(scene=>scene.id),result=validateRoomAnalysisResults(ids,results[0].status==="fulfilled"?results[0].value:undefined,results[1].status==="fulfilled"?results[1].value:undefined);
  const depth=validateDisplayDepthResults(ids,results[2].status==="fulfilled"?results[2].value:undefined);
  return{...result,...(depth.displayDepths?{displayDepths:depth.displayDepths}:{}),warnings:[...result.warnings,...depth.warnings]};
}
