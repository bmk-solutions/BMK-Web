import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";
import {apartmentWalls,pointInRoom,validateRoom} from "./boundary-shapes.ts";
import type {JointDepthScene,JointPoint} from "./joint-depth";
import type {Plan,PlanRoom,Scene} from "./model";

export const depthArchitectureSource="image-outline-refined-by-multiview-depth" as const;
export const depthArchitectureMethodSuffix="multiview-depth-refinement";
export type DepthArchitectureScene=Pick<JointDepthScene,"id"|"position"|"componentId"|"floor">&{yaw?:number};
export type DepthArchitectureGroup={planIndex:number;floor:number;componentId:string;scenes:DepthArchitectureScene[];status:string;proposedRooms:unknown[];proposalRejections:unknown[];outputPath?:string};
export type DepthArchitectureResult={version:1;source:typeof depthArchitectureSource;units:"camera_height";groups:DepthArchitectureGroup[];warnings:string[];outputPaths:string[]};
type Options={points:readonly JointPoint[];scenes:readonly DepthArchitectureScene[];plans:readonly Plan[];outputDir:string;signal?:AbortSignal;timeoutMs?:number};
type CurrentScene=Pick<Scene,"id"|"floor"|"position">&{componentId?:string;yaw?:number};
type Point2={x:number;z:number};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const coordinate=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1000;
const point2=(value:unknown):value is Point2=>record(value)&&[value.x,value.z].every(v=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=10000);
const frameKey=(floor:number,component:string)=>JSON.stringify([floor,component]);
const abortError=()=>new DOMException("Depth architecture cancelled","AbortError");
const checkAbort=(signal?:AbortSignal)=>{if(signal?.aborted)throw abortError();};
const sameOutline=(a:unknown,b:readonly Point2[])=>Array.isArray(a)&&a.length===b.length&&a.every((p,i)=>point2(p)&&p.x===b[i].x&&p.z===b[i].z);
const signedArea=(outline:readonly Point2[])=>outline.reduce((sum,a,i)=>{const b=outline[(i+1)%outline.length];return sum+a.x*b.z-b.x*a.z;},0)/2;
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};

function validScene(value:unknown):value is DepthArchitectureScene{
  return record(value)&&typeof value.id==="string"&&/^[\w-]{1,80}$/.test(value.id)&&typeof value.componentId==="string"&&value.componentId.length>0&&value.componentId.length<=160&&typeof value.floor==="number"&&Number.isInteger(value.floor)&&value.floor>=-10&&value.floor<=200&&record(value.position)&&[value.position.x,value.position.y,value.position.z].every(coordinate)&&(value.yaw===undefined||typeof value.yaw==="number"&&Number.isFinite(value.yaw));
}

function eligiblePlan(plan:Plan,byId:ReadonlyMap<string,DepthArchitectureScene>):DepthArchitectureScene[]|undefined{
  if(plan.authoredRooms!==undefined||!plan.generatedRooms?.length||plan.generatedRooms.length>80||plan.generatedFrom?.scale!=="camera_height")return;
  const ids=plan.generatedFrom.sceneIds;
  if(!ids.length||ids.length>300||new Set(ids).size!==ids.length||ids.some(id=>!byId.has(id)))return;
  const members=ids.map(id=>byId.get(id)!);
  if(members.some(scene=>scene.floor!==plan.floor||scene.componentId!==members[0].componentId))return;
  const names=new Set<string>();
  try{for(const room of plan.generatedRooms){
    if(!room.id||names.has(room.id)||room.outline.length<3||room.outline.length>80||!room.outline.every(point2))return;
    validateRoom(room);names.add(room.id);
  }}catch{return;}
  return [...byId.values()].filter(scene=>scene.floor===plan.floor&&scene.componentId===members[0].componentId);
}

function cleanPoint(raw:JointPoint,scenes:ReadonlyMap<string,DepthArchitectureScene>):JointPoint|undefined{
  if(!record(raw)||![raw.x,raw.y,raw.z].every(coordinate)||![raw.r,raw.g,raw.b].every(v=>typeof v==="number"&&Number.isInteger(v)&&v>=0&&v<=255)||typeof raw.confidence!=="number"||!Number.isFinite(raw.confidence)||raw.confidence<.45||raw.confidence>1||!Array.isArray(raw.sceneIds)||raw.sceneIds.length<2||raw.sceneIds.length>12||new Set(raw.sceneIds).size!==raw.sceneIds.length||!raw.sceneIds.every(id=>typeof id==="string"&&scenes.has(id)))return;
  const members=raw.sceneIds.map(id=>scenes.get(id)!);
  if(members.some(scene=>scene.floor!==members[0].floor||scene.componentId!==members[0].componentId))return;
  const normal=record(raw.normal)&&[raw.normal.x,raw.normal.y,raw.normal.z].every(coordinate)&&Math.abs(Math.hypot(raw.normal.x as number,raw.normal.y as number,raw.normal.z as number)-1)<.02?{x:raw.normal.x as number,y:raw.normal.y as number,z:raw.normal.z as number}:undefined;
  const floorConfidence=typeof raw.floorConfidence==="number"&&Number.isFinite(raw.floorConfidence)&&raw.floorConfidence>=0&&raw.floorConfidence<=1?raw.floorConfidence:undefined;
  return{x:raw.x,y:raw.y,z:raw.z,r:raw.r,g:raw.g,b:raw.b,confidence:raw.confidence,sceneIds:[...raw.sceneIds],...(normal?{normal}:{}),...(floorConfidence!==undefined?{floorConfidence}:{})};
}

/** Each invocation sees one existing plan's coordinate frame and no image paths. */
export async function runDepthArchitecture(options:Options):Promise<DepthArchitectureResult>{
  checkAbort(options.signal);
  if(options.points.length>150000||options.scenes.length>300||options.plans.length>300||new Set(options.scenes.map(scene=>scene.id)).size!==options.scenes.length||!options.scenes.every(validScene))throw new Error("مدخلات هندسة العمق غير صالحة.");
  const timeout=options.timeoutMs??10*60_000;
  if(!Number.isFinite(timeout)||timeout<1||timeout>30*60_000)throw new Error("Invalid depth architecture timeout");
  const scenes=options.scenes.map(scene=>({id:scene.id,floor:scene.floor,componentId:scene.componentId,position:{...scene.position},...(scene.yaw!==undefined?{yaw:scene.yaw}:{})}));
  const byId=new Map(scenes.map(scene=>[scene.id,scene]));
  const points=options.points.map(point=>cleanPoint(point,byId)).filter((point):point is JointPoint=>!!point);
  const result:DepthArchitectureResult={version:1,source:depthArchitectureSource,units:"camera_height",groups:[],warnings:[],outputPaths:[]};
  const batches=options.plans.flatMap((plan,planIndex)=>{const members=eligiblePlan(plan,byId);return members&&members.length>=2?[{plan,planIndex,members}]:[];});
  if(!batches.length||points.length<100)return result;
  let local:{python?:string;cvPath?:string}={};
  try{local=JSON.parse(await readFile(process.getBuiltinModule("node:path").join(process.cwd(),"work/reconstruction-runtime.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const python=process.env.IMO3D_PYTHON||local.python;if(!python)throw new Error("محرك هندسة العمق المحلي غير مهيأ.");
  await mkdir(options.outputDir,{recursive:true});const outputRoot=await realpath(options.outputDir);
  for(const {plan,planIndex,members} of batches){
    checkAbort(options.signal);
    const key=frameKey(plan.floor,members[0].componentId),pointSamples=points.filter(point=>{const scene=byId.get(point.sceneIds[0])!;return frameKey(scene.floor,scene.componentId)===key;});
    if(pointSamples.length<100)continue;
    const priorRooms=plan.generatedRooms!.map(room=>({id:room.id,name:room.name,finish:room.finish,outline:room.outline.map(p=>({...p})),openings:[...room.openings],...(room.doorwayCandidates?{doorwayCandidates:structuredClone(room.doorwayCandidates)}:{}),sceneIds:members.filter(scene=>pointInRoom(scene.position,room.outline)).map(scene=>scene.id)}));
    const serialized=JSON.stringify({version:1,pointSamples,scenes:members,priorRooms});
    if(Buffer.byteLength(serialized,"utf8")>64*1024*1024)throw new Error("Depth architecture input exceeds 64 MB");
    const attempt=path.join(outputRoot,"depth-architecture-"+randomUUID());await mkdir(attempt,{mode:0o700});
    const input=path.join(attempt,"depth-architecture-input.json"),output=path.join(attempt,"depth-architecture.json");
    await writeFile(input,serialized,{encoding:"utf8",mode:0o600,flag:"wx"});checkAbort(options.signal);
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(python,[path.join(process.cwd(),"scripts/imo3d-depth-architecture.py"),"--input",input,"--output",output],{cwd:process.cwd(),windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",PYTHONDONTWRITEBYTECODE:"1",HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",HF_HUB_DISABLE_TELEMETRY:"1",...(process.env.IMO3D_CV_PATH||local.cvPath?{IMO3D_CV_PATH:process.env.IMO3D_CV_PATH||local.cvPath}:{})}});
      let failure:Error|undefined,settled=false,stdoutBytes=0,stderr="";
      const fail=(error:Error)=>{failure??=error;child.kill();};
      const abort=()=>fail(abortError());
      const timer=setTimeout(()=>fail(new Error("انتهت مهلة هندسة العمق المحلية.")),timeout);
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",abort);if(error)reject(error);else resolve();};
      options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
      child.stdout.on("data",(chunk:Buffer)=>{stdoutBytes+=chunk.length;if(stdoutBytes>256000)fail(new Error("Invalid depth architecture output stream"));});
      child.stderr.setEncoding("utf8");child.stderr.on("data",(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
      child.once("error",error=>finish(failure??error));child.once("close",code=>finish(failure??(code===0?undefined:new Error(stderr.includes("ModuleNotFoundError")?"بيئة هندسة العمق المحلية غير مكتملة.":"تعذر تحسين حدود الغرف من العمق المحلي."))));
    });
    checkAbort(options.signal);
    const info=await lstat(output),resolved=await realpath(output),root=await realpath(attempt);
    if(info.isSymbolicLink()||!info.isFile()||info.size>8*1024*1024||path.relative(resolved,path.resolve(output))!==""||!within(root,resolved))throw new Error("Invalid depth architecture output file");
    const raw:unknown=JSON.parse(await readFile(output,"utf8"));checkAbort(options.signal);
    if(!record(raw)||raw.version!==1||raw.units!=="camera_height"||raw.metric===true||!["estimated","partial","insufficient_support","unresolved_floor"].includes(raw.status as string)||raw.proposedRooms!==undefined&&(!Array.isArray(raw.proposedRooms)||raw.proposedRooms.length>80))throw new Error("Invalid depth architecture output");
    result.groups.push({planIndex,floor:plan.floor,componentId:members[0].componentId,scenes:members,status:raw.status as string,proposedRooms:Array.isArray(raw.proposedRooms)?raw.proposedRooms:[],proposalRejections:Array.isArray(raw.proposalRejections)?raw.proposalRejections.slice(0,80):[],outputPath:output});
    result.outputPaths.push(output);
    if(raw.status!=="estimated"||!Array.isArray(raw.proposedRooms)||!raw.proposedRooms.length)result.warnings.push(`لم تتوفر أدلة كافية لتحسين جميع حدود ${plan.label}؛ بقيت الحدود غير المدعومة محفوظة.`);
  }
  return result;
}

function admittedRoom(room:PlanRoom,proposal:unknown,cameras:readonly CurrentScene[],ids:ReadonlySet<string>):PlanRoom|undefined{
  if(!record(proposal)||proposal.id!==room.id||!Array.isArray(proposal.outline)||proposal.outline.length!==room.outline.length||proposal.outline.length<3||proposal.outline.length>80||!proposal.outline.every(point2)||!isDeepStrictEqual(proposal.openings,room.openings)||!isDeepStrictEqual(proposal.doorwayCandidates,room.doorwayCandidates)||!record(proposal.refinement))return;
  const refinement=proposal.refinement,outline=proposal.outline as Point2[];
  if(refinement.source!=="image_outline_refined_by_multiview_depth"||refinement.units!=="camera_height"||refinement.verified!==false||refinement.cameraContainmentPreserved!==true||refinement.doorEdgeIndicesPreserved!==true||!sameOutline(refinement.previousOutline,room.outline))return;
  const shift=Math.max(...outline.map((p,i)=>Math.hypot(p.x-room.outline[i].x,p.z-room.outline[i].z))),area=signedArea(outline),previous=signedArea(room.outline),ratio=area/previous;
  if(!Number.isFinite(shift)||shift<=1e-8||shift>.2+1e-9||!Number.isFinite(ratio)||ratio<.9||ratio>1.1||typeof refinement.maxCornerShift!=="number"||!Number.isFinite(refinement.maxCornerShift)||Math.abs(refinement.maxCornerShift-shift)>1e-6||typeof refinement.areaRatio!=="number"||!Number.isFinite(refinement.areaRatio)||Math.abs(refinement.areaRatio-ratio)>1e-6)return;
  const changes=refinement.supportedEdgeChanges,unchanged=refinement.unchangedEdgeLines;
  if(!Array.isArray(changes)||changes.length<2||changes.length>outline.length||!Array.isArray(unchanged))return;
  const edges=new Set<number>();
  for(const change of changes){
    if(!record(change)||!Number.isInteger(change.edge)||(change.edge as number)<0||(change.edge as number)>=outline.length||edges.has(change.edge as number)||typeof change.wallId!=="string"||!change.wallId||typeof change.coverage!=="number"||!Number.isFinite(change.coverage)||change.coverage<.55||change.coverage>1.00001||!Number.isInteger(change.supportPoints)||(change.supportPoints as number)<60||!Array.isArray(change.supportCameras)||change.supportCameras.length<2||new Set(change.supportCameras).size!==change.supportCameras.length||!change.supportCameras.every(id=>typeof id==="string"&&ids.has(id))||typeof change.beforeResidual!=="number"||!Number.isFinite(change.beforeResidual)||typeof change.afterResidual!=="number"||!Number.isFinite(change.afterResidual)||change.afterResidual<0||change.afterResidual>.035||change.beforeResidual<change.afterResidual+.015||change.afterResidual>change.beforeResidual*.7)return;
    edges.add(change.edge as number);
  }
  const expected=room.outline.map((_,i)=>i).filter(i=>!edges.has(i));
  if(!isDeepStrictEqual([...unchanged].sort((a,b)=>Number(a)-Number(b)),expected))return;
  const directions=[...edges].map(edge=>{const a=outline[edge],b=outline[(edge+1)%outline.length],length=Math.hypot(b.x-a.x,b.z-a.z);return{x:(b.x-a.x)/length,z:(b.z-a.z)/length};});
  if(!directions.some((a,i)=>directions.slice(i+1).some(b=>Math.abs(a.x*b.x+a.z*b.z)<.7)))return;
  for(const edge of expected){const a=room.outline[edge],b=room.outline[(edge+1)%outline.length],length=Math.hypot(b.x-a.x,b.z-a.z);if([outline[edge],outline[(edge+1)%outline.length]].some(p=>Math.abs((p.x-a.x)*(b.z-a.z)-(p.z-a.z)*(b.x-a.x))/length>1e-6))return;}
  if(cameras.some(scene=>scene.position&&pointInRoom(scene.position,room.outline)&&!pointInRoom(scene.position,outline)))return;
  const updated={...room,outline:outline.map(p=>({x:p.x,z:p.z}))};try{validateRoom(updated);}catch{return;}
  return updated;
}

// Bound the occupancy estimate to 180 x 180 samples, matching the offline geometry gate.
function addsRoomOverlap(before:PlanRoom,after:PlanRoom,neighbor:PlanRoom):boolean{
  const all=[...before.outline,...after.outline],other=neighbor.outline;
  const minX=Math.max(Math.min(...all.map(p=>p.x)),Math.min(...other.map(p=>p.x)));
  const maxX=Math.min(Math.max(...all.map(p=>p.x)),Math.max(...other.map(p=>p.x)));
  const minZ=Math.max(Math.min(...all.map(p=>p.z)),Math.min(...other.map(p=>p.z)));
  const maxZ=Math.min(Math.max(...all.map(p=>p.z)),Math.max(...other.map(p=>p.z)));
  if(maxX<=minX||maxZ<=minZ)return false;
  const step=Math.max(.02,(maxX-minX)/180,(maxZ-minZ)/180);
  const columns=Math.max(1,Math.ceil((maxX-minX)/step)),rows=Math.max(1,Math.ceil((maxZ-minZ)/step));
  const dx=(maxX-minX)/columns,dz=(maxZ-minZ)/rows;
  let increase=0;
  for(let x=0;x<columns;x++)for(let z=0;z<rows;z++){
    const point={x:minX+(x+.5)*dx,z:minZ+(z+.5)*dz};
    if(pointInRoom(point,other)&&pointInRoom(point,after.outline)&&!pointInRoom(point,before.outline))increase+=dx*dz;
    if(increase>.02+1e-9)return true;
  }
  return false;
}

/** Treat model proposals as untrusted; only bounded edits to current generated rooms survive. */
export function applyDepthArchitecture(plans:readonly Plan[],scenes:readonly CurrentScene[],output:unknown):Plan[]{
  const result=[...plans];
  if(!record(output)||output.version!==1||output.source!==depthArchitectureSource||output.units!=="camera_height"||!Array.isArray(output.groups)||output.groups.length>plans.length||new Set(scenes.map(s=>s.id)).size!==scenes.length)return result;
  const current=new Map(scenes.map(scene=>[scene.id,scene])),used=new Set<number>();
  for(const group of output.groups){
    if(!record(group)||!Number.isInteger(group.planIndex)||(group.planIndex as number)<0||(group.planIndex as number)>=plans.length||used.has(group.planIndex as number)||typeof group.componentId!=="string"||!Array.isArray(group.scenes)||group.scenes.length<2||group.scenes.length>300||!group.scenes.every(validScene)||!Array.isArray(group.proposedRooms)||group.proposedRooms.length>80||!["estimated","partial"].includes(group.status as string))continue;
    const index=group.planIndex as number,plan=plans[index],members=group.scenes as DepthArchitectureScene[];
    const ids=new Set(members.map(scene=>scene.id));
    if(ids.size!==members.length||group.floor!==plan.floor||plan.authoredRooms!==undefined||!plan.generatedRooms?.length||plan.generatedFrom?.scale!=="camera_height"||!plan.generatedFrom.sceneIds.length||!plan.generatedFrom.sceneIds.every(id=>ids.has(id)))continue;
    if(members.some(scene=>{const now=current.get(scene.id);return scene.floor!==plan.floor||scene.componentId!==group.componentId||!now||now.floor!==plan.floor||now.componentId!==undefined&&now.componentId!==group.componentId||!now.position||!["x","y","z"].every(axis=>now.position![axis as "x"|"y"|"z"]===scene.position[axis as "x"|"y"|"z"])||scene.yaw!==undefined&&now.yaw!==undefined&&scene.yaw!==now.yaw;}))continue;
    const proposals=new Map<string,unknown>(),duplicates=new Set<string>();
    for(const proposed of group.proposedRooms)if(record(proposed)&&typeof proposed.id==="string"){if(proposals.has(proposed.id))duplicates.add(proposed.id);proposals.set(proposed.id,proposed);}
    const cameras=scenes.filter(scene=>scene.floor===plan.floor&&(scene.componentId===undefined||scene.componentId===group.componentId));
    const rooms=[...plan.generatedRooms];
    for(let roomIndex=0;roomIndex<rooms.length;roomIndex++){
      const room=rooms[roomIndex],proposed=proposals.get(room.id);
      if(duplicates.has(room.id)||!record(proposed)||proposed.floor!==undefined&&proposed.floor!==plan.floor||proposed.componentId!==undefined&&proposed.componentId!==group.componentId)continue;
      const admitted=admittedRoom(room,proposed,cameras,ids);
      if(admitted&&!rooms.some((neighbor,index)=>index!==roomIndex&&addsRoomOverlap(room,admitted,neighbor)))rooms[roomIndex]=admitted;
    }
    if(rooms.every((room,i)=>room===plan.generatedRooms![i]))continue;
    const points=[...rooms.flatMap(room=>room.outline),...cameras.flatMap(scene=>scene.position?[scene.position]:[])],xs=points.map(p=>p.x),zs=points.map(p=>p.z);
    const method=plan.generatedFrom.method.split("+").includes(depthArchitectureMethodSuffix)?plan.generatedFrom.method:`${plan.generatedFrom.method}+${depthArchitectureMethodSuffix}`;
    result[index]={...plan,generatedRooms:rooms,walls:apartmentWalls(rooms),bounds:{minX:Math.min(...xs)-.5,maxX:Math.max(...xs)+.5,minZ:Math.min(...zs)-.5,maxZ:Math.max(...zs)+.5},generatedFrom:{...plan.generatedFrom,method}};
    used.add(index);
  }
  return result;
}
