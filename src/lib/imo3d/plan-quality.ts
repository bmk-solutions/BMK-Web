import {z} from 'zod';
import {floorplanAuditSchema,floorplanLayoutSchema,sceneEvidenceSchema,validateFloorplanLayout} from './openai-floorplan-pipeline.ts';

const analysisSchema=z.object({floors:z.array(z.object({
 floor:z.number().int(),geometryBasis:z.enum(['image-supported','topology-only','insufficient']),
 evidence:z.array(sceneEvidenceSchema),layout:floorplanLayoutSchema,audit:floorplanAuditSchema,
})).min(1)});
type SourceScene={id:string;floor:number};
export type PlanQualityIssue={
 code:'SOURCE_COVERAGE'|'SCHEMA'|'FLOOR_COVERAGE'|'PHOTO_COVERAGE'|'PHOTO_EVIDENCE_EMPTY'|'AUDIT_COVERAGE'|'GEOMETRY_INVALID'|'GEOMETRY_UNRESOLVED'|'ROOMS_UNRESOLVED'|'ACCESS_UNRESOLVED'|'AUDIT_UNRESOLVED';
 severity:'invalid'|'recovery';floor?:number;roomIds:string[];sceneIds:string[];detail:string;
};
export type PlanFloorQuality={
 floor:number;sceneCount:number;analyzedSceneCount:number;roomCount:number;locatedRoomCount:number;
 unresolvedRoomIds:string[];unlocatedSceneIds:string[];traversableRoomGroups:string[][];
};
export type PlanQualityReport={
 status:'complete-estimate'|'needs-recovery'|'invalid';readyForRender:boolean;issues:PlanQualityIssue[];
 sceneCount:number;analyzedSceneCount:number;roomCount:number;locatedRoomCount:number;floors:PlanFloorQuality[];
};
const unique=(values:readonly string[])=>[...new Set(values)];
function exactIds(actual:string[],expected:string[]){
 const allowed=new Set(expected);
 return actual.length===expected.length&&new Set(actual).size===expected.length&&actual.every(id=>allowed.has(id));
}

/** A consistent partial drawing is valuable evidence, but is not a completed
 * apartment. This gate checks completeness before spending time styling it.
 * Passing means a complete estimated draft, never surveyed metric accuracy. */
export function assessPlanQuality(analysis:unknown,scenes:readonly SourceScene[]):PlanQualityReport{
 const report:PlanQualityReport={status:'invalid',readyForRender:false,issues:[],sceneCount:scenes.length,analyzedSceneCount:0,roomCount:0,locatedRoomCount:0,floors:[]};
 const add=(issue:PlanQualityIssue)=>report.issues.push(issue);
 if(!scenes.length||new Set(scenes.map(s=>s.id)).size!==scenes.length||scenes.some(s=>!s.id||!Number.isSafeInteger(s.floor)))
  add({code:'SOURCE_COVERAGE',severity:'invalid',roomIds:[],sceneIds:[],detail:'Source photographs must have unique IDs and valid floors.'});
 const parsed=analysisSchema.safeParse(analysis);
 if(!parsed.success){add({code:'SCHEMA',severity:'invalid',roomIds:[],sceneIds:[],detail:'Analysis does not match the floor, photo evidence and geometry contract.'});return report;}
 const sourceFloors=unique(scenes.map(s=>String(s.floor))),actualFloors=parsed.data.floors.map(f=>String(f.floor));
 if(!exactIds(actualFloors,sourceFloors))add({code:'FLOOR_COVERAGE',severity:'invalid',roomIds:[],sceneIds:[],detail:'Analysis must include each source floor exactly once.'});
 for(const floor of parsed.data.floors){
  const ids=scenes.filter(s=>s.floor===floor.floor).map(s=>s.id),allowed=new Set(ids),rooms=floor.layout.rooms;
  const analyzed=unique(floor.evidence.map(e=>e.sceneId).filter(id=>allowed.has(id)));
  const located=rooms.filter(r=>r.polygon),coveredByLocated=new Set(located.flatMap(r=>r.evidenceSceneIds));
  const result:PlanFloorQuality={floor:floor.floor,sceneCount:ids.length,analyzedSceneCount:analyzed.length,roomCount:rooms.length,locatedRoomCount:located.length,
   unresolvedRoomIds:rooms.filter(r=>!r.polygon).map(r=>r.id),unlocatedSceneIds:ids.filter(id=>!coveredByLocated.has(id)),traversableRoomGroups:[]};
  report.floors.push(result);report.analyzedSceneCount+=analyzed.length;report.roomCount+=rooms.length;report.locatedRoomCount+=located.length;
  const issue=(code:PlanQualityIssue['code'],severity:PlanQualityIssue['severity'],detail:string,roomIds:string[]=[],sceneIds:string[]=[])=>add({code,severity,detail,floor:floor.floor,roomIds,sceneIds});
  if(!exactIds(floor.evidence.map(e=>e.sceneId),ids))issue('PHOTO_COVERAGE','invalid','Every source photograph must have exactly one same-floor analysis entry.',[],ids.filter(id=>!analyzed.includes(id)));
  const emptyEvidence=floor.evidence.filter(e=>![...e.visibleEvidence,...e.distinctiveFeatures,...e.openings.flatMap(o=>[o.direction,o.destinationEvidence])].some(fact=>fact.trim())).map(e=>e.sceneId);
  if(emptyEvidence.length)issue('PHOTO_EVIDENCE_EMPTY','recovery','Some photographs have an ID but no recorded visual observations; inspect those images before claiming complete analysis.',[],emptyEvidence);
  if(!exactIds(floor.audit.reviewedSceneIds,ids))issue('AUDIT_COVERAGE','invalid','Every source photograph must occur exactly once in the same-floor audit.',[],ids.filter(id=>!floor.audit.reviewedSceneIds.includes(id)));
  let geometryValid=true;
  try{validateFloorplanLayout(floor.layout,ids);}catch(error){geometryValid=false;issue('GEOMETRY_INVALID','invalid',error instanceof Error?error.message:'Invalid room geometry.',rooms.map(r=>r.id),ids);}
  if(floor.geometryBasis!=='image-supported')issue('GEOMETRY_UNRESOLVED','recovery','Room arrangement is not yet supported by the image evidence.',rooms.map(r=>r.id),ids);
  if(result.unresolvedRoomIds.length)issue('ROOMS_UNRESOLVED','recovery','Some observed spaces still have no supported polygon; do not render them as a complete apartment.',result.unresolvedRoomIds,result.unlocatedSceneIds);
  if(geometryValid){
   const adjacency=new Map(located.map(r=>[r.id,new Set<string>()]));
   for(const opening of floor.layout.openings){
    // A shared window is not a traversable connection. Exterior openings with
    // no identified other room cannot prove a path to a different component.
    if(opening.kind==='window'||!opening.otherRoomId)continue;
    adjacency.get(opening.roomId)?.add(opening.otherRoomId);adjacency.get(opening.otherRoomId)?.add(opening.roomId);
   }
   const seen=new Set<string>();
   for(const room of located){
    if(seen.has(room.id))continue;
    const group:string[]=[],queue=[room.id];seen.add(room.id);
    for(let i=0;i<queue.length;i++){const id=queue[i];group.push(id);for(const next of adjacency.get(id)??[])if(!seen.has(next)){seen.add(next);queue.push(next);}}
    result.traversableRoomGroups.push(group);
   }
   if(result.traversableRoomGroups.length>1)issue('ACCESS_UNRESOLVED','recovery','Located spaces form separate access groups. Review photographed doorways and exterior/shared access; never connect them through a wall merely to satisfy this check.',located.map(r=>r.id),unique(located.flatMap(r=>r.evidenceSceneIds)));
  }
  if(floor.audit.verdict!=='consistent'||floor.audit.issues.length)issue('AUDIT_UNRESOLVED','recovery','The image audit reports unresolved issues or an inconclusive arrangement.',[],ids);
 }
 report.status=report.issues.some(i=>i.severity==='invalid')?'invalid':report.issues.length?'needs-recovery':'complete-estimate';
 report.readyForRender=report.status==='complete-estimate';return report;
}

export type PlanRecoveryTask={
 kind:'photo-coverage'|'room-outline'|'room-alignment'|'geometry-consistency'|'audit-review';floor:number;
 roomIds:string[];sceneIds:string[];contextSceneIds:string[];objective:string;
};
/** Produces evidence review work, never guessed coordinates or new edges.
 * Capture neighbours are review candidates only, not proof of adjacency. */
export function buildPlanRecoveryTasks(analysis:unknown,scenes:readonly SourceScene[],report=assessPlanQuality(analysis,scenes)):PlanRecoveryTask[]{
 const parsed=analysisSchema.safeParse(analysis);if(!parsed.success)return [];
 const tasks:PlanRecoveryTask[]=[];
 for(const floor of parsed.data.floors){
  const ids=scenes.filter(s=>s.floor===floor.floor).map(s=>s.id),allowed=new Set(ids),rooms=floor.layout.rooms;
  const sorted=(values:readonly string[])=>{const selected=new Set(values);return ids.filter(id=>selected.has(id));};
  const findings=report.issues.filter(i=>i.floor===floor.floor);
  if(findings.some(i=>i.code==='PHOTO_COVERAGE'||i.code==='AUDIT_COVERAGE'||i.code==='PHOTO_EVIDENCE_EMPTY'))tasks.push({kind:'photo-coverage',floor:floor.floor,roomIds:[],sceneIds:ids,contextSceneIds:[],objective:'Inspect images without recorded observations and repair missing, duplicate or incorrect photo and audit IDs without removing a source photograph.'});
  for(const room of rooms.filter(r=>!r.polygon)){
   const primary=sorted(room.evidenceSceneIds),primarySet=new Set(primary),neighbours=new Set<string>();
   for(const id of primary){const index=ids.indexOf(id);for(const next of [ids[index-1],ids[index+1]])if(next&&!primarySet.has(next))neighbours.add(next);}
   for(const opening of floor.layout.openings.filter(o=>o.roomId===room.id||o.otherRoomId===room.id))for(const id of opening.evidenceSceneIds)if(!primarySet.has(id)&&allowed.has(id))neighbours.add(id);
   tasks.push({kind:'room-outline',floor:floor.floor,roomIds:[room.id],sceneIds:primary,contextSceneIds:sorted([...neighbours]),objective:`Recover the observed boundary and doorway relationships of ${room.label} from all its source views. Inspect context views for shared landmarks, not assumed capture-order adjacency. Preserve polygon:null if unsupported.`});
  }
  const quality=report.floors.find(f=>f.floor===floor.floor);
  if(quality&&quality.traversableRoomGroups.length>1){
   const involved=rooms.filter(r=>quality.traversableRoomGroups.some(g=>g.includes(r.id))),all=sorted(involved.flatMap(r=>r.evidenceSceneIds));
   const doorViews=new Set(floor.evidence.filter(e=>e.openings.some(o=>o.kind==='door'||o.kind==='passage')).map(e=>e.sceneId));
   tasks.push({kind:'room-alignment',floor:floor.floor,roomIds:involved.map(r=>r.id),sceneIds:all.filter(id=>doorViews.has(id)),contextSceneIds:all.filter(id=>!doorViews.has(id)),objective:'Resolve the relationship between separate access groups using reciprocal doorway views and repeated landmarks. Review exterior/shared access explicitly. Independent camera frames cannot be overlaid; never add an unsupported door or path.'});
  }
  if(findings.some(i=>i.code==='GEOMETRY_INVALID'||i.code==='GEOMETRY_UNRESOLVED'))tasks.push({kind:'geometry-consistency',floor:floor.floor,roomIds:rooms.map(r=>r.id),sceneIds:ids,contextSceneIds:[],objective:'Correct only evidence-supported polygon, shared wall and opening contradictions. Keep unresolved geometry unknown and retain all source photo evidence.'});
  if(findings.some(i=>i.code==='AUDIT_UNRESOLVED'))tasks.push({kind:'audit-review',floor:floor.floor,roomIds:rooms.map(r=>r.id),sceneIds:ids,contextSceneIds:[],objective:'Recheck the specific audit issues against photographs and corrected geometry. Do not change the audit verdict merely to pass the gate.'});
 }
 return tasks;
}

/** Fairly attaches unresolved room views first, then bridge/context views.
 * The full transcript remains available; a photo budget never drops a room. */
export function selectPlanRecoveryPhotos<T extends {sceneId:string;floor:number}>(photos:readonly T[],tasks:readonly PlanRecoveryTask[],maxPhotos=48):T[]{
 const byId=new Map(photos.map(p=>[p.sceneId,p])),selected=new Set<string>();
 const lists=tasks.map(task=>{
  const primary=unique(task.sceneIds).filter(id=>byId.get(id)?.floor===task.floor);
  // First / last / middle plus remaining views avoids selecting only the
  // beginning of one long capture sequence when a budget is tight.
  const spread=unique([primary[0],primary.at(-1),primary[Math.floor(primary.length/2)],...primary].filter((id):id is string=>!!id));
  const context=task.contextSceneIds.filter(id=>byId.get(id)?.floor===task.floor&&!primary.includes(id));
  return {kind:task.kind,primary:spread,context};
 }).sort((a,b)=>Number(b.kind==='room-outline')-Number(a.kind==='room-outline'));
 for(const list of lists)if(list.primary[0])selected.add(list.primary[0]);
 const budget=Math.max(selected.size,Number.isFinite(maxPhotos)?Math.max(1,Math.floor(maxPhotos)):48);
 for(let round=0;selected.size<budget;round++){
  let available=false;
  for(const list of lists){
   const id=round===0?list.context[0]:round===1?list.primary[1]:round===2?list.primary[2]:[...list.primary.slice(3),...list.context.slice(1)][round-3];
   if(id){available=true;selected.add(id);}if(selected.size>=budget)break;
  }
  if(!available&&round>=3)break;
 }
 return photos.filter(p=>selected.has(p.sceneId));
}
