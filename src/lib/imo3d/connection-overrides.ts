import type { Scene } from "./model";

export const normalizeConnectionYaw = (yaw: number) => ((yaw % 360) + 360) % 360;

/** Retain the exact selected panorama bearing if reconstruction changes its world yaw. */
export function rebaseManualLinkYaws(scene: Scene, nextYaw: number): Scene["manualLinks"] {
  return scene.manualLinks?.map(link => ({ ...link, yaw: normalizeConnectionYaw(link.yaw + nextYaw - scene.yaw) }));
}

export function rebaseVisualLinkYaws(scene: Scene, nextYaw: number): Scene["visualLinks"] {
  return scene.visualLinks?.map(link => ({ ...link, yaw: normalizeConnectionYaw(link.yaw + nextYaw - scene.yaw) }));
}

/** User removal wins over computed edges; reciprocal manual pairs are not spatial proof. */
export function applyConnectionOverrides(scenes: Scene[]): Scene[] {
  const byId = new Map(scenes.map(scene => [scene.id, scene]));
  const blocked = new Map(scenes.map(scene => [scene.id, new Set(scene.blockedLinks ?? [])]));
  const manual = new Map(scenes.map(scene => [scene.id, new Map((scene.manualLinks ?? []).filter(link => Number.isFinite(link.yaw)).map(link => [link.targetId, link.yaw]))]));
  const visual = new Map(scenes.map(scene => [scene.id, new Map((scene.visualLinks ?? []).filter(link => Number.isFinite(link.yaw)).map(link => [link.targetId, link.yaw]))]));
  return scenes.map(scene => {
    const allowed = (id: string) => id !== scene.id && byId.get(id)?.floor === scene.floor && !blocked.get(scene.id)?.has(id) && !blocked.get(id)?.has(scene.id);
    const links = new Set(scene.links.filter(id => allowed(id) && byId.get(id)?.links.includes(scene.id)));
    for (const id of manual.get(scene.id)?.keys() ?? []) {
      if (allowed(id) && manual.get(id)?.has(scene.id)) links.add(id);
    }
    return { ...scene, links: [...links], ...(scene.visualLinks ? {
      visualLinks: [...visual.get(scene.id)!].filter(([id]) => allowed(id) && visual.get(id)?.has(scene.id)).map(([targetId, yaw]) => ({ targetId, yaw })),
    } : {}) };
  });
}
