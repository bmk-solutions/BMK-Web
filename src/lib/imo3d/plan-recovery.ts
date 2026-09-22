import {createHash} from 'node:crypto';
import {assessPlanQuality,buildPlanRecoveryTasks,selectPlanRecoveryPhotos,type PlanQualityReport,type PlanRecoveryTask} from './plan-quality';

/** Reuse completed reviews on retry. A rendering pass is never a substitute
 * for resolving missing room geometry, photograph coverage or door access. */
export async function recoverCompletePlan<T,P extends {sceneId:string;floor:number}>(options:{
 analysis:T;scenes:readonly {id:string;floor:number}[];photos:readonly P[];signal:AbortSignal;contextKey?:string;
 load:(key:string)=>Promise<T|null>;save:(key:string,value:T)=>Promise<void>;
 progress:(pass:number,quality:PlanQualityReport)=>Promise<void>;
 recover:(input:{analysis:T;photos:P[];tasks:PlanRecoveryTask[];quality:PlanQualityReport;pass:number})=>Promise<T>;
}){
 let analysis=options.analysis,quality=assessPlanQuality(analysis,options.scenes);
 for(let pass=1;pass<=2&&!quality.readyForRender;pass++){
  options.signal.throwIfAborted();
  const tasks=buildPlanRecoveryTasks(analysis,options.scenes,quality);
  const photos=pass===2?[...options.photos]:selectPlanRecoveryPhotos(options.photos,tasks,64);
  // Include source IDs/floors and actual proposal; unrelated projects and old
  // image snapshots cannot share a completed recovery checkpoint.
  const key=`geometry-recovery-v1-${pass}-`+createHash('sha256').update(JSON.stringify([options.contextKey??'',options.scenes.map(({id,floor})=>({id,floor})),analysis,photos.map(p=>p.sceneId)])).digest('hex').slice(0,24);
  await options.progress(pass,quality);
  options.signal.throwIfAborted();
  const cached=await options.load(key);
  options.signal.throwIfAborted();
  const candidate=cached??await options.recover({analysis,photos,tasks,quality,pass});
  options.signal.throwIfAborted();
  if(!cached)await options.save(key,candidate);
  const next=assessPlanQuality(candidate,options.scenes);
  // A model can appear complete by merging distinct observed spaces into one
  // polygon. Never reward a smaller per-floor inventory automatically. A
  // legitimate consolidation requires review, not silent loss of a room.
  const inventoryReduced=quality.floors.some(previous=>{
   const current=next.floors.find(floor=>floor.floor===previous.floor);
   return !current||current.roomCount<previous.roomCount;
  });
  // Preserve the better proposal if a review regresses. Still inspect all
  // source photographs on the second pass rather than silently giving up.
  const rank=(report:PlanQualityReport)=>[
   report.issues.filter(i=>i.severity==='invalid').length,
   report.sceneCount-report.analyzedSceneCount,
   report.roomCount-report.locatedRoomCount,
   report.issues.length,
  ];
  const before=rank(quality),after=rank(next),difference=after.findIndex((n,i)=>n!==before[i]);
  if(!inventoryReduced&&(next.readyForRender||difference<0||after[difference]<before[difference])){analysis=candidate;quality=next;}
 }
 return {analysis,quality};
}
