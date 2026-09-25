import {z} from "zod";
import type {Tour} from "./model";
export type ProcessingStatus="queued"|"running"|"completed"|"review"|"failed"|"cancelled"|"stale";
export type ProcessingJob={
  id:string;tourId:string;status:ProcessingStatus;progress:number;stage:string;
  createdAt:string;updatedAt:string;error:string|null;warnings:string[];
  /** Heartbeat of the photos engine on the owner's PC; `unknown` until that engine has ever reported. */
  photosEngine?:'online'|'offline'|'unknown';
  result?:{registered:number;total:number;links:number;components:number;scale:"relative"|"metric";analyzedPhotos?:number;analyzedSceneIds?:string[];analyzedSources?:{id:string;image:string;floor:number}[];positionedLocalPhotos?:number;independentFrames?:number;unmatchedPhotos?:number;boundaryPhotos?:number;recognizedPhotos?:number;rooms?:number;jointDepthPhotos?:number;jointPoints?:number};
};
export const processingActive=(job:ProcessingJob|null|undefined)=>job?.status==="queued"||job?.status==="running";
/** A queued upload that no engine will pick up says so instead of waiting forever. */
export const PHOTOS_ENGINE_GRACE_MS=90_000;
export function photosEngineNotice(job:ProcessingJob|null|undefined,now=Date.now()):string|null{
 if(job?.status!=='queued'||job.photosEngine!=='offline')return null;
 const queued=Math.max(Date.parse(job.createdAt),Date.parse(job.updatedAt)||0);
 return Number.isFinite(queued)&&now-queued>PHOTOS_ENGINE_GRACE_MS?'محرك الصور على جهازك غير متصل — شغّل الجهاز أو سجّل الدخول عليه. الصور المرفوعة محفوظة وتبدأ معالجتها تلقائيًا عند اتصاله.':null;
}

/** Worker labels are phase evidence; percentages are not, since recovery can restart matching. */
export function processingPhase(job:ProcessingJob|null|undefined):'queued'|'inspection'|'linking'|'unknown'|null{
 if(!processingActive(job))return null;
 if(job?.status==='queued')return 'queued';
 const label=job?.stage.split('·',1)[0].trim();
 if(['مطابقة اللقطات','تصحيح منظور الصور للربط','تقدير مواقع التصوير','دمج الأسطح بين الصور','تدقيق الجدران المعمارية'].includes(label??''))return 'linking';
 if(['تجهيز الصور','تجهيز الصور على عامل المعالجة المحلي','فحص محرك المعالجة قبل تجهيز الصور','تجهيز صور المعالجة المحلية','استخراج حدود الغرف','تحسين عمق الانتقال','التعرف على الغرف','تحليل الصور'].includes(label??''))return 'inspection';
 return 'unknown';
}

export function processingWorkflowSteps(job:ProcessingJob|null|undefined,coverage:ReturnType<typeof tourWorkflowCoverage>,format:(n:number)=>string=String){
 const phase=processingPhase(job),interrupted=!!job&&['failed','cancelled','stale'].includes(job.status);
 if(phase)return {
  inspection:{detail:phase==='linking'?'انتهى فحص الصور الأولي؛ تُوثّق التغطية عند حفظ النتيجة':job?.stage||'بانتظار فحص الصور',state:phase==='linking'?'done':'is-active'},
  linking:{detail:phase==='linking'?job!.stage:'بانتظار اكتمال فحص الصور',state:phase==='linking'?'is-active':''},
 };
 return {
  inspection:{detail:coverage.analyzed!==null?`${format(coverage.analyzed)} / ${format(coverage.total)} لقطة فُحصت`:interrupted?'توقف الفحص قبل توثيق نتيجة جديدة':job?.result?'تغطية الفحص غير موثّقة في النتيجة السابقة':'ينطلق تلقائيًا بعد الرفع',state:coverage.analysisComplete?'done':job?.result||interrupted?'needs-review':''},
  linking:{detail:`${interrupted?'آخر نتيجة محفوظة: ':''}${format(coverage.positioned)} / ${format(coverage.total)} في الإطار المكاني${coverage.unpositioned?` · ${format(coverage.unpositioned)} لم تُحسم`:''}`,state:!interrupted&&coverage.spatialComplete?'done':coverage.total?'needs-review':''},
 };
}

export const processingSourceSchema=z.object({
 id:z.string().regex(/^[\w-]+$/).max(80),
 image:z.string().max(512).refine(value=>/^\/(?:imo3d\/example\/|api\/imo3d\/assets\/)[a-zA-Z0-9/_.-]+$/.test(value)&&!value.includes('..')),
 floor:z.number().int().min(-10).max(200),
}).strict();
const processingJobResponse=z.object({
 id:z.string(),tourId:z.string(),status:z.enum(['queued','running','completed','review','failed','cancelled','stale']),
 progress:z.number().finite(),stage:z.string(),createdAt:z.string(),updatedAt:z.string(),error:z.string().nullable(),warnings:z.array(z.string()).default([]),photosEngine:z.enum(['online','offline','unknown']).optional(),
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
