import type { Scene, Tour } from "./model";
import { derivePlans, quality } from "./spatial";
import {reconcileRoomMembership} from "./room-semantics";

export const privateSceneAssetIds = (scene: Scene) => [...new Set([scene.image, scene.preview, scene.thumbnail, ...(scene.detail ? [scene.detail.image] : [])].flatMap(url => {
  const id = /^\/api\/imo3d\/assets\/([\w-]+)$/.exec(url)?.[1];
  return id ? [id] : [];
}))];

/** Removing a capture does not invalidate a registered drawing's coordinate frame. */
export function removeTourScene(tour: Tour, sceneId: string): Tour | null {
  const removed = tour.scenes.find(scene => scene.id === sceneId);
  if (!removed) return null;
  const scenes = reconcileRoomMembership(tour.scenes.filter(scene => scene.id !== sceneId).map(scene => ({ ...scene, links: scene.links.filter(id => id !== sceneId),
    ...(scene.manualLinks ? { manualLinks: scene.manualLinks.filter(link => link.targetId !== sceneId) } : {}),
    ...(scene.visualLinks ? { visualLinks: scene.visualLinks.filter(link => link.targetId !== sceneId) } : {}),
    ...(scene.blockedLinks ? { blockedLinks: scene.blockedLinks.filter(id => id !== sceneId) } : {}),
  })));
  const floors = new Set([...scenes.map(scene => scene.floor),...tour.plans.filter(plan=>plan.architecture).map(plan=>plan.floor)]);
  const plans = tour.plans.filter(plan => floors.has(plan.floor)).map(savedPlan => {
    const plan={...savedPlan};if(plan.surfaceModel?.cameras.some(camera=>camera.id===sceneId))delete plan.surfaceModel;
    if(plan.architecture)plan.architecture={...plan.architecture,rooms:plan.architecture.rooms.map(room=>({...room,cameraIds:room.cameraIds.filter(id=>id!==sceneId)})),walls:plan.architecture.walls.map(wall=>({...wall,evidenceIds:wall.evidenceIds.filter(id=>id!==sceneId)}))};
    if(plan.architecture?.walls.some(wall=>wall.source==="observed"&&wall.evidenceIds.length===0))plan.architectureReview="draft";
    if(plan.texturedMesh?.cameras.some(camera=>camera.id===sceneId))delete plan.texturedMesh;
    if (plan.floor === removed.floor && plan.kind === "depth" && !plan.architecture) {
      return {...derivePlans(scenes.filter(scene => scene.floor === plan.floor))[0], ...(plan.reviewStatus ? {reviewStatus: plan.reviewStatus} : {})};
    }
    if (!plan.scenePoints?.[sceneId]) return plan;
    return { ...plan, scenePoints: Object.fromEntries(Object.entries(plan.scenePoints).filter(([id]) => id !== sceneId)) };
  });
  const resultQuality = quality(scenes);
  // Recalculate numeric warnings while preserving unrelated source-quality notes.
  const previousCalculated = new Set(quality(tour.scenes).warnings);
  if (scenes.length) resultQuality.warnings = [...new Set([...resultQuality.warnings, ...tour.quality.warnings.filter(warning => !previousCalculated.has(warning))])];
  return { ...tour, scenes, plans, published: scenes.length ? tour.published : false, quality: resultQuality };
}
