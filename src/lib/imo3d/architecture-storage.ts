import {z} from "zod";
import type {DatabaseSync} from "node:sqlite";
import type {Tour} from "./model";
import {architectureSchema,architectureIssues,deriveArchitecturalRooms,type Architecture} from "./architecture";
import {cancelJob,ensureProcessingTables} from "./processing-jobs";

export const architectureSaveSchema=z.object({
  revision:z.number().int().nonnegative(),floor:z.number().int().min(-10).max(200),
  action:z.enum(["save","review"]).default("save"),architecture:architectureSchema,
});
export class ArchitectureSaveError extends Error{constructor(message:string,public status=400){super(message);}}
export function architectureReviewIssues(architecture:Architecture,tour:Tour){
  const cameras=tour.scenes.filter(scene=>scene.floor===architecture.floor).map(scene=>({id:scene.id,position:scene.position}));
  const issues=architectureIssues(architecture,cameras);
  const reasons=issues.filter(issue=>issue.severity==="error").map(issue=>issue.message);
  if(!architecture.rooms.length)reasons.push("لا توجد غرف مغلقة مشتقة من وجوه الجدران.");
  const derived=deriveArchitecturalRooms(architecture);
  const samePolygon=(a:Architecture["rooms"][number]["polygon"],b:Architecture["rooms"][number]["polygon"])=>a.length===b.length&&b.some((_,offset)=>[1,-1].some(direction=>a.every((point,index)=>{const other=b[(offset+direction*index+b.length*2)%b.length];return Math.hypot(point.x-other.x,point.z-other.z)<1e-5;})));
  if(derived.length!==architecture.rooms.length||derived.some(room=>!architecture.rooms.some(saved=>samePolygon(room.polygon,saved.polygon)&&JSON.stringify([...room.wallIds].sort())===JSON.stringify([...saved.wallIds].sort()))))reasons.push("حدود الغرف يجب أن تطابق الوجوه الداخلية للجدران. أعد استخراج الغرف بعد تعديل الهندسة.");
  if(!architecture.walls.length||architecture.walls.some(wall=>wall.thickness===null))reasons.push("يجب تحديد سماكة الجدران قبل اعتماد المسقط المعماري.");
  const ids=new Set(cameras.map(camera=>camera.id));
  if(architecture.rooms.some(room=>room.cameraIds.some(id=>!ids.has(id))))reasons.push("هناك غرفة مرتبطة بلقطة غير موجودة في هذا الدور.");
  return [...new Set(reasons)];
}
/** Revision-safe, floor-local save. Drafting is not architectural approval. */
export function saveArchitecture(database:DatabaseSync,id:string,input:z.infer<typeof architectureSaveSchema>):Tour{
  ensureProcessingTables(database);
  database.exec("BEGIN IMMEDIATE");
  try{
    const row=database.prepare("SELECT payload,revision FROM tours WHERE id=?").get(id);
    if(!row)throw new ArchitectureSaveError("الجولة غير موجودة.",404);
    const tour=JSON.parse(String(row.payload)) as Tour;
    if(Number(row.revision)!==input.revision)throw new ArchitectureSaveError("تغيرت الجولة؛ أعد فتح المحرر.",409);
    if(input.architecture.floor!==input.floor)throw new ArchitectureSaveError("الدور المعماري لا يطابق دور الصور.");
    const floorIds=new Set(tour.scenes.filter(scene=>scene.floor===input.floor).map(scene=>scene.id));
    if(input.architecture.rooms.some(room=>room.cameraIds.some(camera=>!floorIds.has(camera))))throw new ArchitectureSaveError("لقطات الغرف يجب أن تنتمي إلى الدور نفسه.");
    const previous=tour.plans.find(plan=>plan.floor===input.floor);
    if(!previous)throw new ArchitectureSaveError("هذا الدور غير موجود.");
    if(input.action==="review"){
      if(JSON.stringify(previous.architecture)!==JSON.stringify(input.architecture))throw new ArchitectureSaveError("احفظ المسودة قبل اعتمادها.",409);
      const reasons=architectureReviewIssues(input.architecture,tour);
      if(reasons.length)throw new ArchitectureSaveError(reasons.join(" "));
    }
    const plan={...previous,architecture:input.architecture,architectureReview:input.action==="review"?"reviewed" as const:"draft" as const};
    // The legacy rejection stays attached to its legacy geometry. The new
    // semantic model has an independent explicit review state.
    const next:Tour={...tour,plans:tour.plans.map(value=>value.floor===input.floor?plan:value),revision:tour.revision+1,updatedAt:new Date().toISOString()};
    const result=database.prepare("UPDATE tours SET payload=?,revision=? WHERE id=? AND revision=?").run(JSON.stringify(next),next.revision,id,input.revision);
    if(!result.changes)throw new ArchitectureSaveError("تغيرت الجولة أثناء الحفظ.",409);
    cancelJob(database,id);
    database.exec("COMMIT");return next;
  }catch(error){database.exec("ROLLBACK");throw error;}
}
