import type { Depth, Point, Scene, Tour } from "./model";
import { autoConnect, derivePlans, quality } from "./spatial";
import { applyConnectionOverrides, normalizeConnectionYaw, rebaseVisualLinkYaws } from "./connection-overrides";

type SpatialTour = Pick<Tour, "scenes" | "plans">;
type SpatialResult = Pick<Tour, "scenes" | "plans" | "quality">;

export class AuthoredPlanCalibrationError extends Error {
  readonly status=409;
  constructor(){super("ملف الكاميرات يغيّر إحداثيات دور له حدود مرسومة. امسح حدود هذا الدور من محرر حدود الشقة، ثم استورد الكاميرات وارسم الحدود في الإحداثيات الجديدة.");}
}

function samePosition(a: Point | null, b: Point | null) {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function sameDepth(a?: Depth, b?: Depth) {
  return a === b || (!!a && !!b && a.width === b.width && a.height === b.height &&
    a.values.length === b.values.length && a.values.every((value, index) => value === b.values[index]));
}

function samePose(a: Scene, b: Scene) {
  return a.floor === b.floor && samePosition(a.position, b.position) &&
    Math.abs(Math.sin((a.yaw - b.yaw) * Math.PI / 180)) < 1e-10 &&
    Math.cos((a.yaw - b.yaw) * Math.PI / 180) > 0;
}

/**
 * Rebuild only spatial data affected by a changed calibration. New unpositioned
 * photographs must not erase the source plan or existing imported connections.
 * Preserved edges must already be reciprocal, remain on one floor, and retain
 * both endpoints' original camera/image/depth calibration.
 */
export function mergeTourSpatial(previous: SpatialTour, nextScenes: Scene[]): SpatialResult {
  const before = new Map(previous.scenes.map(scene => [scene.id, scene]));
  const authoredFloors=new Set(previous.plans.filter(plan=>plan.authoredRooms?.length||plan.architecture).map(plan=>plan.floor));
  const proposed=new Map(nextScenes.map(scene=>[scene.id,scene]));
  for(const scene of previous.scenes){
    if(!authoredFloors.has(scene.floor))continue;
    const next=proposed.get(scene.id);
    if(!next||next.floor!==scene.floor||!samePosition(scene.position,next.position))throw new AuthoredPlanCalibrationError();
  }
  for(const scene of nextScenes)if(authoredFloors.has(scene.floor)&&scene.position&&before.get(scene.id)?.floor!==scene.floor)throw new AuthoredPlanCalibrationError();
  nextScenes = nextScenes.map(scene => {
    const old = before.get(scene.id);
    if (!old || old.yaw === scene.yaw) return scene;
    return { ...scene,
      ...(scene.manualLinks ? { manualLinks: scene.manualLinks.map(link => ({ ...link, yaw: normalizeConnectionYaw(link.yaw + scene.yaw - old.yaw) })) } : {}),
      ...(scene.visualLinks ? { visualLinks: rebaseVisualLinkYaws({ ...scene, yaw: old.yaw }, scene.yaw) } : {}),
    };
  });
  const after = new Map(nextScenes.map(scene => [scene.id, scene]));
  const unchanged = new Set<string>();
  const changedFloors = new Set<number>();
  const changedGeometryFloors = new Set<number>();

  for (const scene of nextScenes) {
    const old = before.get(scene.id);
    const poseSame = !!old && samePose(old, scene);
    const depthSame = !!old && sameDepth(old.depth, scene.depth);
    if (old && poseSame && depthSame && old.image === scene.image) unchanged.add(scene.id);
    if (scene.position && (!old?.position || !poseSame || !depthSame)) changedFloors.add(scene.floor);
    if (old?.position && (!scene.position || !poseSame || !depthSame)) changedFloors.add(old.floor);
    // A new depth map does not invalidate an architectural drawing's frame.
    if (scene.position && (!old?.position || !poseSame)) changedGeometryFloors.add(scene.floor);
    if (old?.position && (!scene.position || !poseSame)) changedGeometryFloors.add(old.floor);
  }
  for (const old of previous.scenes) {
    if (!after.has(old.id) && old.position) {
      changedFloors.add(old.floor);
      changedGeometryFloors.add(old.floor);
    }
  }

  const scenes = autoConnect(nextScenes);
  const generated = new Map(scenes.map(scene => [scene.id, scene]));
  for (const scene of scenes) {
    const old = before.get(scene.id);
    // Visual bearings stay useful inside a component that has no shared map
    // position. Adding an image must not erase these reciprocal input edges.
    if (old && old.image === scene.image) for (const id of old.links) {
      const target = generated.get(id), oldTarget = before.get(id);
      if (!target || !oldTarget?.links.includes(scene.id) || oldTarget.image !== target.image ||
        target.floor !== scene.floor || scene.depth && target.depth ||
        !scene.visualLinks?.some(link => link.targetId === id) || !target.visualLinks?.some(link => link.targetId === scene.id)) continue;
      if (!scene.links.includes(id)) scene.links.push(id);
    }
    if (!old || !unchanged.has(scene.id) || !scene.position) continue;
    for (const id of old.links) {
      const target = generated.get(id);
      if (!target?.position || id === scene.id || target.floor !== scene.floor ||
        !unchanged.has(id) || !before.get(id)?.links.includes(scene.id)) continue;
      // Available depth is stronger evidence than a legacy link. Never restore
      // an edge that the current bidirectional clearance test has rejected.
      if (scene.depth && target.depth) continue;
      if (!scene.links.includes(id)) scene.links.push(id);
    }
  }

  const overridden = applyConnectionOverrides(scenes);
  const regenerated = derivePlans(overridden);
  const replacedPlans: number[] = [];
  const plans = regenerated.map(plan => {
    const old = previous.plans.find(previousPlan => previousPlan.floor === plan.floor);
    const preserve = old && (old.authoredRooms?.length || old.architecture || (old.kind === "geometry" ? !changedGeometryFloors.has(plan.floor) : !changedFloors.has(plan.floor)));
    if (preserve) return old;
    if (old?.kind === "geometry") replacedPlans.push(plan.floor);
    return old?.reviewStatus === "rejected" ? {...plan, reviewStatus: "rejected" as const} : plan;
  });
  // Architectural floors outlive their captures, including during later uploads.
  for (const old of previous.plans) {
    if (old.architecture && !plans.some(plan => plan.floor === old.floor)) plans.push(old);
  }
  plans.sort((a, b) => a.floor - b.floor);
  const resultQuality = quality(overridden);
  if (replacedPlans.length) {
    resultQuality.warnings.push("تغيّرت معايرة الكاميرات في دور له مخطط مسجّل؛ يلزم اعتماد ربط المخطط بالإحداثيات الجديدة قبل عرضه مجددًا.");
  }
  return { scenes: overridden, plans, quality: resultQuality };
}
