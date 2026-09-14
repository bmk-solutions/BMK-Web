import {z} from "zod";
import type {DatabaseSync} from "node:sqlite";
import type {Tour} from "./model";
import {cancelJob} from "./processing-jobs";
import {derivePlans} from "./spatial";
import {renameSemanticRoom} from "./room-semantics";
import {pruneUnreferencedSurfaceAssets} from "./surface-model-cleanup";
const point=z.object({x:z.number().finite().min(-10000).max(10000),z:z.number().finite().min(-10000).max(10000)});
// Generated room IDs also identify semantic groups; keep them when an outline is edited.
const roomId=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9@._-]*$/);
const doorway=z.object({edge:z.number().int().min(0).max(79),offset:z.number().finite().min(0).max(1),width:z.number().finite().positive().max(1),confidence:z.number().finite().min(0).max(1),verified:z.literal(false),pairedRoomId:roomId});
export const boundarySchema=z.object({revision:z.number().int().nonnegative(),floor:z.number().int().min(-10).max(200),rooms:z.array(z.object({id:roomId,name:z.string().trim().min(1).max(100),outline:z.array(point).min(3).max(80),finish:z.enum(["wood","tile","stone"]),openings:z.array(z.number().int().min(0).max(79)).max(80),doorwayCandidates:z.array(doorway).max(80).optional()})).max(80)});
import {BoundaryError,planFromRooms} from "./boundary-shapes";
export {BoundaryError} from "./boundary-shapes";
export function saveFloorBoundaries(database:DatabaseSync,tourId:string,input:z.infer<typeof boundarySchema>,removedFiles?:string[]):Tour{
  database.exec("BEGIN IMMEDIATE");try{
    const row=database.prepare("SELECT payload,revision FROM tours WHERE id=?").get(tourId);if(!row)throw new BoundaryError("الجولة غير موجودة.",404);
    const tour=JSON.parse(String(row.payload)) as Tour;if(Number(row.revision)!==input.revision)throw new BoundaryError("تغيرت الجولة؛ أعد فتح المحرر لتحميل آخر نسخة.",409);
    if(!tour.scenes.some(scene=>scene.floor===input.floor))throw new BoundaryError("هذا الدور غير موجود في الجولة.");
    const previous=tour.plans.find(p=>p.floor===input.floor);
    if(previous?.architecture)throw new BoundaryError("هذا الدور له نموذج معماري. استخدم المحرر المعماري لتعديل الجدران والغرف.",409);
    if(!input.rooms.length&&!previous?.authoredRooms?.length)throw new BoundaryError("لا توجد حدود يدوية محفوظة لمسحها في هذا الدور.");
    const previousRooms=new Map((previous?.authoredRooms??previous?.generatedRooms??[]).map(room=>[room.id,room]));
    let floorScenes=tour.scenes.filter(scene=>scene.floor===input.floor);
    const rooms=input.rooms.map(room=>{
      const members=floorScenes.filter(scene=>scene.roomSemantic?.groupId===room.id);if(!members.length)return room;
      if(previousRooms.get(room.id)?.name!==room.name){floorScenes=renameSemanticRoom(floorScenes,room.id,room.name);return room;}
      // Authored labels already belong to the user. Only a generated draft may
      // refresh its unchanged label from semantic metadata during geometry edits.
      if(previous?.authoredRooms?.some(saved=>saved.id===room.id))return room;
      const names=new Set(members.map(scene=>scene.room));return names.size===1?{...room,name:members[0].room}:room;
    });
    const byId=new Map(floorScenes.map(scene=>[scene.id,scene])),scenes=tour.scenes.map(scene=>byId.get(scene.id)??scene);
    const plan=rooms.length?planFromRooms(previous,rooms,input.floor):{...derivePlans(scenes.filter(scene=>scene.floor===input.floor))[0],label:previous!.label};
    if(input.rooms.length&&tour.spatialScale==="relative")plan.authoredScale="relative";
    const next:Tour={...tour,scenes,plans:[...tour.plans.filter(p=>p.floor!==input.floor),plan].sort((a,b)=>a.floor-b.floor),revision:tour.revision+1,updatedAt:new Date().toISOString()};
    const saved=database.prepare("UPDATE tours SET payload=?,revision=? WHERE id=? AND revision=?").run(JSON.stringify(next),next.revision,tourId,input.revision);if(!saved.changes)throw new BoundaryError("تغيرت الجولة أثناء الحفظ.",409);
    const files=pruneUnreferencedSurfaceAssets(database,next);
    cancelJob(database,tourId);database.exec("COMMIT");removedFiles?.push(...files);return next;
  }catch(error){database.exec("ROLLBACK");throw error;}
}
