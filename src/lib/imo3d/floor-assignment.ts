import {hotspotsSchema,validateHotspots} from "./hotspots";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sceneSchema, unitSchema, type Plan, type Scene, type Tour } from "./model";
import { derivePlans, quality } from "./spatial";
import { applyConnectionOverrides } from "./connection-overrides";
import { cancelJob } from "./processing-jobs";
import { floorPlanProjection } from "../../components/imo3d/floorplan-geometry";
import {markRoomNameAsUser,reconcileRoomMembership,renameSemanticRoom} from "./room-semantics";
import {pruneUnreferencedSurfaceAssets} from "./surface-model-cleanup";
import {applyEntryView} from "./view-presentation";

const floorMessage = "اختر رقم دور صحيحًا من −10 إلى 200.";
export const uploadFloorSchema = z.preprocess(value => {
  if (value === null || value === undefined) return 0;
  return typeof value === "string" && /^-?\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}, z.number({ error: floorMessage }).int(floorMessage).min(-10, floorMessage).max(200, floorMessage));

export const tourMetadataSchema = z.object({
  hotspots:hotspotsSchema.optional(),
  revision: z.number().int().nonnegative(), title: z.string().trim().min(2).max(120).optional(),
  published: z.boolean().optional(), unit: unitSchema.optional(),
  measurementHeightMeters:z.number().finite().min(.15).max(10).nullable().optional(),
  entryView:z.object({sceneId:z.string().min(1).max(80),view:sceneSchema.shape.entryView.unwrap().nullable()}).optional(),
  scenes: z.array(sceneSchema.pick({ id: true, name: true, room: true, floor: true })).max(500).optional(),
  roomRenames:z.array(z.object({groupId:z.string().min(1).max(160),name:z.string().trim().min(1).max(100)})).max(500).refine(values=>new Set(values.map(value=>value.groupId)).size===values.length,"الغرفة مكررة في طلب التسمية.").optional(),
});
export type TourMetadataInput = z.infer<typeof tourMetadataSchema>;
export class FloorAssignmentError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** An old floor keeps its coordinate frame only through cameras that did not move. */
function retainedGeometry(plan: Plan, scenes: Scene[], moved: Set<string>): Plan | null {
  // A reviewed drawing belongs to its original floor even when remaining
  // photographs have no camera pose; no incoming capture is placed by this.
  if(plan.architecture){
    const ids=new Set(scenes.filter(scene=>scene.floor===plan.floor).map(scene=>scene.id));
    return {...plan,architectureReview:moved.size?"draft":plan.architectureReview,architecture:{
      ...plan.architecture,
      walls:plan.architecture.walls.map(wall=>({...wall,evidenceIds:wall.evidenceIds.filter(id=>ids.has(id))})),
      rooms:plan.architecture.rooms.map(room=>({...room,cameraIds:room.cameraIds.filter(id=>ids.has(id))})),
    }};
  }
  if(plan.authoredRooms?.length)return plan;
  const anchors = scenes.filter(scene => scene.floor === plan.floor && scene.position && !moved.has(scene.id));
  if (!anchors.length) return null;
  const retainedIds = new Set(anchors.map(scene => scene.id));
  const filtered = { ...plan, ...(plan.scenePoints ? { scenePoints: Object.fromEntries(Object.entries(plan.scenePoints).filter(([id]) => retainedIds.has(id))) } : {}) };
  if (!plan.image || floorPlanProjection(filtered, scenes)) return filtered;
  // World-space wall coordinates remain valid even if too few drawing anchors
  // survive to recover its affine registration. Do not keep stale pixel points.
  if (plan.walls.length) return { floor: plan.floor, label: plan.label, kind: "geometry", bounds: plan.bounds, walls: plan.walls };
  return null;
}

/** A floor label cannot transfer the old floor's spatial calibration to a new one. */
export function applySceneFloorAssignments(previous: Tour, nextScenes: Scene[]): Pick<Tour, "scenes" | "plans" | "quality"> {
  const before = new Map(previous.scenes.map(scene => [scene.id, scene]));
  const moved = new Set(nextScenes.filter(scene => before.get(scene.id)?.floor !== scene.floor).map(scene => scene.id));
  if (!moved.size) return { scenes: nextScenes, plans: previous.plans, quality: previous.quality };
  const floors = new Map(nextScenes.map(scene => [scene.id, scene.floor])), affected = new Set<number>();
  for (const id of moved) {
    const old = before.get(id); if (old) affected.add(old.floor);
    affected.add(floors.get(id)!);
  }
  const cleaned = nextScenes.map(scene => {
    const sameFloor = (id: string) => id !== scene.id && floors.get(id) === scene.floor;
    return {
      ...scene,
      ...(moved.has(scene.id) ? { position: null, depth: undefined } : {}),
      links: scene.links.filter(id => sameFloor(id) && !moved.has(scene.id) && !moved.has(id)),
      ...(scene.manualLinks ? { manualLinks: scene.manualLinks.filter(link => sameFloor(link.targetId)) } : {}),
      ...(scene.visualLinks ? { visualLinks: scene.visualLinks.filter(link => sameFloor(link.targetId)) } : {}),
      ...(scene.blockedLinks ? { blockedLinks: scene.blockedLinks.filter(sameFloor) } : {}),
    };
  });
  const scenes = reconcileRoomMembership(applyConnectionOverrides(cleaned));
  const plans = derivePlans(scenes).map(generated => {
    const old = previous.plans.find(plan => plan.floor === generated.floor);
    if (!old) return generated;
    if (!affected.has(generated.floor)) return old;
    if (old.kind === "geometry"||old.architecture) {
      const retained = retainedGeometry(old, scenes, moved);
      if (retained) return retained;
    }
    // Depth contours are regenerated without moved captures. Estimated surfaces
    // lack per-capture provenance, so retain only the remaining camera path.
    return { ...generated, label: old.label };
  });
  for(const old of previous.plans)if(old.architecture&&!plans.some(plan=>plan.floor===old.floor)){const retained=retainedGeometry(old,scenes,moved);if(retained)plans.push(retained);}
  plans.sort((a,b)=>a.floor-b.floor);
  const resultQuality = quality(scenes), oldCalculated = new Set(quality(previous.scenes).warnings);
  resultQuality.warnings = [...new Set([
    ...resultQuality.warnings,
    ...previous.quality.warnings.filter(warning => !oldCalculated.has(warning)),
    "تغيّر دور بعض اللقطات؛ أزيلت معايرتها السابقة وروابطها العابرة للأدوار. أعد تحليل الصور أو استورد معايرة الدور الصحيح لتحديد مواقعها.",
  ])];
  return { scenes, plans, quality: resultQuality };
}

/** Revision validation, floor updates and worker cancellation commit together. */
export function saveTourMetadata(database: DatabaseSync, tourId: string, input: TourMetadataInput, removedFiles?: string[]): Tour {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT payload,revision FROM tours WHERE id=?").get(tourId);
    if (!row) throw new FloorAssignmentError(404, "الجولة غير موجودة.");
    const current = JSON.parse(String(row.payload)) as Tour;
    if (Number(row.revision) !== input.revision || current.revision !== input.revision) throw new FloorAssignmentError(409, "تغيّرت الجولة. أعد تحميل أحدث نسخة قبل الحفظ.");
    const changes = new Map(input.scenes?.map(scene => [scene.id, scene]));
    if (input.scenes && (input.scenes.length !== current.scenes.length || changes.size !== current.scenes.length || current.scenes.some(scene => !changes.has(scene.id)))) {
      throw new FloorAssignmentError(400, "قائمة اللقطات غير مطابقة.");
    }
    let nextScenes = current.scenes.map(scene => {const next={...scene,...changes.get(scene.id)};return next.room!==scene.room?markRoomNameAsUser(next):next;});
    if(input.entryView){try{nextScenes=applyEntryView({...current,scenes:nextScenes},input.entryView);}catch(error){throw new FloorAssignmentError(400,error instanceof Error?error.message:"تعذر حفظ جهة العرض.");}}
    for(const rename of input.roomRenames??[]){try{nextScenes=renameSemanticRoom(nextScenes,rename.groupId,rename.name);}catch(error){throw new FloorAssignmentError(400,error instanceof Error?error.message:"تعذر تعديل اسم الغرفة.");}}
    const floorChanged = nextScenes.some((scene, index) => scene.floor !== current.scenes[index].floor);
    const published = input.published ?? current.published;
    if (published && !nextScenes.length) throw new FloorAssignmentError(400, "أضف لقطات قبل إتاحة الجولة.");
    const hotspotChanges=input.hotspots===undefined?{}:{hotspots:validateHotspots(current,input.hotspots)};
    const next = {
      ...current, ...hotspotChanges, title: input.title ?? current.title, unit: input.unit ?? current.unit, published,
      ...(input.measurementHeightMeters===undefined?{}:{measurementScale:input.measurementHeightMeters===null?undefined:{heightMeters:input.measurementHeightMeters,source:"operator_measured" as const,sceneIds:current.scenes.map(scene=>scene.id)}}),
      ...applySceneFloorAssignments(current, nextScenes), revision: current.revision + 1, updatedAt: new Date().toISOString(),
    };
    if(input.roomRenames?.length){
      const names=new Map(input.roomRenames.map(rename=>[rename.groupId,rename.name.trim()]));
      next.plans=next.plans.map(plan=>{
        const groups=new Set(next.scenes.filter(scene=>scene.floor===plan.floor&&scene.roomSemantic).map(scene=>scene.roomSemantic!.groupId));
        const rename=(rooms:NonNullable<Plan["authoredRooms"]>)=>rooms.map(room=>names.has(room.id)&&groups.has(room.id)?{...room,name:names.get(room.id)!}:room);
        return{...plan,...(plan.authoredRooms?{authoredRooms:rename(plan.authoredRooms)}:{}),...(plan.generatedRooms?{generatedRooms:rename(plan.generatedRooms)}:{})};
      });
    }
    const saved = database.prepare("UPDATE tours SET payload=?,revision=?,published=? WHERE id=? AND revision=?").run(JSON.stringify(next), next.revision, next.published ? 1 : 0, tourId, input.revision);
    if (!saved.changes) throw new FloorAssignmentError(409, "تغيّرت الجولة. أعد تحميل أحدث نسخة قبل الحفظ.");
    const files = pruneUnreferencedSurfaceAssets(database, next);
    if (floorChanged) cancelJob(database, tourId);
    database.exec("COMMIT");
    removedFiles?.push(...files);
    return next;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
