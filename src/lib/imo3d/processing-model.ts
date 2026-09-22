import {z} from "zod";
import type {Tour} from "./model";
export type ProcessingStatus="queued"|"running"|"completed"|"review"|"failed"|"cancelled"|"stale";
export type ProcessingJob={
  id:string;tourId:string;status:ProcessingStatus;progress:number;stage:string;
  createdAt:string;updatedAt:string;error:string|null;warnings:string[];
  result?:{registered:number;total:number;links:number;components:number;scale:"relative"|"metric";analyzedPhotos?:number;analyzedSceneIds?:string[];analyzedSources?:{id:string;image:string;floor:number}[];positionedLocalPhotos?:number;independentFrames?:number;unmatchedPhotos?:number;boundaryPhotos?:number;recognizedPhotos?:number;rooms?:number;jointDepthPhotos?:number;jointPoints?:number};
};
export const processingActive=(job:ProcessingJob|null|undefined)=>job?.status==="queued"||job?.status==="running";

export const processingSourceSchema=z.object({
 id:z.string().regex(/^[\w-]+$/).max(80),
 image:z.string().max(512).refine(value=>/^\/(?:imo3d\/example\/|api\/imo3d\/assets\/)[a-zA-Z0-9/_.-]+$/.test(value)&&!value.includes('..')),
 floor:z.number().int().min(-10).max(200),
}).strict();
const processingJobResponse=z.object({
 id:z.string(),tourId:z.string(),status:z.enum(['queued','running','completed','review','failed','cancelled','stale']),
 progress:z.number().finite(),stage:z.string(),createdAt:z.string(),updatedAt:z.string(),error:z.string().nullable(),warnings:z.array(z.string()).default([]),
 result:z.object({registered:z.number(),total:z.number(),links:z.number(),components:z.number(),scale:z.enum(['relative','metric']),analyzedPhotos:z.number().int().min(0).max(500).optional(),analyzedSceneIds:z.array(z.string().regex(/^[\w-]+$/).max(80)).max(500).optional(),analyzedSources:z.array(processingSourceSchema).max(500).optional(),positionedLocalPhotos:z.number().int().min(0).max(500).optional(),independentFrames:z.number().int().min(0).max(500).optional(),unmatchedPhotos:z.number().int().min(0).max(500).optional(),boundaryPhotos:z.number().optional(),recognizedPhotos:z.number().optional(),rooms:z.number().optional(),jointDepthPhotos:z.number().optional(),jointPoints:z.number().optional()}).optional(),
}).nullable();
/** Validate before updating React state: API versions may differ during deployment. */
export function parseProcessingJob(value:unknown):ProcessingJob|null{
 const parsed=processingJobResponse.safeParse(value);
 if(!parsed.success)throw Error('تعذر قراءة حالة المعالجة. أعد المحاولة أو حدّث الصفحة؛ صورك محفوظة.');
 return parsed.data;
}

/** The processing job finishing is not evidence that every camera or floor is resolved. */
export function tourWorkflowCoverage(tour:Tour,job:ProcessingJob|null|undefined){
 const total=tour.scenes.length,floors=[...new Set(tour.scenes.map(scene=>scene.floor))];
 const finitePosition=(scene:Tour['scenes'][number])=>!!scene.position&&Object.values(scene.position).every(Number.isFinite);
 const positioned=tour.scenes.filter(finitePosition).length;
 const result=job?.tourId===tour.id&&['completed','review'].includes(job.status)&&job.result?.total===total?job.result:undefined;
 const validCount=(value:number|undefined)=>value!==undefined&&Number.isInteger(value)&&value>=0&&value<=total?value:null;
 const currentScenes=new Map(tour.scenes.map(scene=>[scene.id,scene])),evidenceIds=result?.analyzedSceneIds,sources=result?.analyzedSources;
 const evidenceSet=new Set(evidenceIds);
 // Snapshot original inputs. Retouch presentation assets are not reconstruction inputs.
 const currentEvidence=!!evidenceIds&&!!sources&&evidenceIds.length===result?.analyzedPhotos&&evidenceSet.size===evidenceIds.length
  &&sources.length===evidenceIds.length&&new Set(sources.map(source=>source.id)).size===sources.length
  &&sources.every(source=>{const current=currentScenes.get(source.id);return evidenceSet.has(source.id)&&current?.image===source.image&&current.floor===source.floor;});
 const analyzed=currentEvidence?validCount(result?.analyzedPhotos):null,localPositioned=currentEvidence?validCount(result?.positionedLocalPhotos):null;
 const analysisComplete=total>0&&analyzed===total;
 const connectedFloors=floors.filter(floor=>{
  const scenes=tour.scenes.filter(scene=>scene.floor===floor),byId=new Map(scenes.map(scene=>[scene.id,scene]));
  const edges=new Map(scenes.map(scene=>[scene.id,new Set<string>()]));
  for(const scene of scenes)for(const target of scene.links){if(byId.has(target)&&!scene.blockedLinks?.includes(target)&&!byId.get(target)?.blockedLinks?.includes(scene.id)){edges.get(scene.id)!.add(target);edges.get(target)!.add(scene.id);}}
  const visited=new Set<string>(),pending=[scenes[0].id];
  while(pending.length){const id=pending.pop()!;if(visited.has(id))continue;visited.add(id);for(const target of edges.get(id)??[])if(!visited.has(target))pending.push(target);}
  return visited.size===scenes.length;
 });
 const spatialComplete=total>0&&positioned===total&&connectedFloors.length===floors.length;
 const reviewedFloors=floors.filter(floor=>tour.plans.some(plan=>{
  if(plan.floor!==floor||plan.reviewStatus==='rejected'||plan.architectureReview!=='reviewed'||!plan.architecture?.rooms.length)return false;
  const covered=new Set(plan.architecture.rooms.flatMap(room=>room.cameraIds));
  return tour.scenes.filter(scene=>scene.floor===floor).every(scene=>covered.has(scene.id));
 }));
 const planComplete=total>0&&reviewedFloors.length===floors.length;
 return {total,analyzed,analysisComplete,positioned,unpositioned:total-positioned,localPositioned,
  independentFrames:currentEvidence?validCount(result?.independentFrames):null,unmatched:currentEvidence?validCount(result?.unmatchedPhotos):null,
  floors:floors.length,connectedFloors:connectedFloors.length,spatialComplete,
  reviewedFloors:reviewedFloors.length,planComplete,ready:analysisComplete&&spatialComplete&&planComplete};
}
