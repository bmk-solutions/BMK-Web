import {z} from "zod";
import type {Tour,Plan} from "../model";
import {tourMetadataSchema,applySceneFloorAssignments} from "../floor-assignment";
import {markRoomNameAsUser,renameSemanticRoom} from "../room-semantics";
import {boundarySchema} from "../floor-boundaries";
import {planFromRooms} from "../boundary-shapes";
import {derivePlans} from "../spatial";
import {architectureSaveSchema,architectureReviewIssues} from "../architecture-storage";
import {CloudHTTPError} from "./http";
export function requireRevision(tour:Tour,revision:number){if(tour.revision!==revision)throw new CloudHTTPError("تغيّرت الجولة؛ أعد تحميل أحدث نسخة.",409);}
export function applyMetadata(tour:Tour,input:z.infer<typeof tourMetadataSchema>):Tour{
 requireRevision(tour,input.revision);
 const changes=new Map(input.scenes?.map(scene=>[scene.id,scene]));
 if(input.scenes&&(input.scenes.length!==tour.scenes.length||changes.size!==tour.scenes.length||tour.scenes.some(scene=>!changes.has(scene.id))))throw new CloudHTTPError("قائمة اللقطات غير مطابقة.");
 let scenes=tour.scenes.map(scene=>{const next={...scene,...changes.get(scene.id)};return next.room!==scene.room?markRoomNameAsUser(next):next;});
 for(const rename of input.roomRenames??[])scenes=renameSemanticRoom(scenes,rename.groupId,rename.name);
 const published=input.published??tour.published;if(published&&!scenes.length)throw new CloudHTTPError("أضف لقطات قبل إتاحة الجولة.");
 const next:Tour={...tour,title:input.title??tour.title,unit:input.unit??tour.unit,published,...applySceneFloorAssignments(tour,scenes)};
 if(input.roomRenames?.length){const names=new Map(input.roomRenames.map(rename=>[rename.groupId,rename.name.trim()]));next.plans=next.plans.map(plan=>{
  const groups=new Set(next.scenes.filter(scene=>scene.floor===plan.floor&&scene.roomSemantic).map(scene=>scene.roomSemantic!.groupId));
  const rename=(rooms:NonNullable<Plan["authoredRooms"]>)=>rooms.map(room=>names.has(room.id)&&groups.has(room.id)?{...room,name:names.get(room.id)!}:room);
  return{...plan,...(plan.authoredRooms?{authoredRooms:rename(plan.authoredRooms)}:{}),...(plan.generatedRooms?{generatedRooms:rename(plan.generatedRooms)}:{})};
 });}return next;
}
export function applyBoundaries(tour:Tour,input:z.infer<typeof boundarySchema>):Tour{
 requireRevision(tour,input.revision);
 if(!tour.scenes.some(scene=>scene.floor===input.floor))throw new CloudHTTPError("هذا الدور غير موجود في الجولة.");
 const previous=tour.plans.find(plan=>plan.floor===input.floor);
 if(previous?.architecture)throw new CloudHTTPError("استخدم المحرر المعماري لتعديل الجدران والغرف.",409);
 if(!input.rooms.length&&!previous?.authoredRooms?.length)throw new CloudHTTPError("لا توجد حدود يدوية محفوظة لمسحها في هذا الدور.");
 const oldRooms=new Map((previous?.authoredRooms??previous?.generatedRooms??[]).map(room=>[room.id,room]));let floorScenes=tour.scenes.filter(scene=>scene.floor===input.floor);
 const rooms=input.rooms.map(room=>{const members=floorScenes.filter(scene=>scene.roomSemantic?.groupId===room.id);if(!members.length)return room;
  if(oldRooms.get(room.id)?.name!==room.name){floorScenes=renameSemanticRoom(floorScenes,room.id,room.name);return room;}
  if(previous?.authoredRooms?.some(saved=>saved.id===room.id))return room;
  return new Set(members.map(scene=>scene.room)).size===1?{...room,name:members[0].room}:room;
 });
 const byId=new Map(floorScenes.map(scene=>[scene.id,scene])),scenes=tour.scenes.map(scene=>byId.get(scene.id)??scene);
 const plan=rooms.length?planFromRooms(previous,rooms,input.floor):{...derivePlans(scenes.filter(scene=>scene.floor===input.floor))[0],label:previous!.label};
 if(input.rooms.length&&tour.spatialScale==="relative")plan.authoredScale="relative";
 return{...tour,scenes,plans:[...tour.plans.filter(p=>p.floor!==input.floor),plan].sort((a,b)=>a.floor-b.floor)};
}
export function applyArchitecture(tour:Tour,input:z.infer<typeof architectureSaveSchema>):Tour{
 requireRevision(tour,input.revision);
 if(input.architecture.floor!==input.floor)throw new CloudHTTPError("الدور المعماري لا يطابق دور الصور.");
 const floorIds=new Set(tour.scenes.filter(scene=>scene.floor===input.floor).map(scene=>scene.id));
 if(input.architecture.rooms.some(room=>room.cameraIds.some(camera=>!floorIds.has(camera))))throw new CloudHTTPError("لقطات الغرف يجب أن تنتمي إلى الدور نفسه.");
 const previous=tour.plans.find(plan=>plan.floor===input.floor);if(!previous)throw new CloudHTTPError("هذا الدور غير موجود.");
 if(input.action==="review"){
  if(JSON.stringify(previous.architecture)!==JSON.stringify(input.architecture))throw new CloudHTTPError("احفظ المسودة قبل اعتمادها.",409);
  const reasons=architectureReviewIssues(input.architecture,tour);if(reasons.length)throw new CloudHTTPError(reasons.join(" "));
 }
 return{...tour,plans:tour.plans.map(plan=>plan.floor===input.floor?{...plan,architecture:input.architecture,architectureReview:input.action==="review"?"reviewed":"draft"}:plan)};
}
