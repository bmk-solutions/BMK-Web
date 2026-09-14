import type { Tour } from "./model";
import { applyConnectionOverrides, normalizeConnectionYaw } from "./connection-overrides";
import { quality } from "./spatial";

export type ConnectionEdit = { fromId: string; toId: string } & ({ action: "connect"; fromYaw: number; toYaw: number } | { action: "disconnect" });
export class ConnectionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Explicit reciprocal directions change navigation only, never camera positions or depth. */
export function editTourConnection(tour: Tour, edit: ConnectionEdit): Tour {
  if (edit.fromId === edit.toId) throw new ConnectionError("اختر لقطتين مختلفتين للربط.", 400);
  const from = tour.scenes.find(scene => scene.id === edit.fromId), to = tour.scenes.find(scene => scene.id === edit.toId);
  if (!from || !to) throw new ConnectionError("إحدى اللقطتين لم تعد موجودة في الجولة.", 404);
  if (from.floor !== to.floor) throw new ConnectionError("الربط اليدوي متاح حاليًا بين لقطات الدور نفسه.", 400);
  if (edit.action === "connect" && (!Number.isFinite(edit.fromYaw) || !Number.isFinite(edit.toYaw))) throw new ConnectionError("اختر اتجاهًا صالحًا في كلتا اللقطتين.", 400);
  const changed = tour.scenes.map(scene => {
    if (scene.id !== edit.fromId && scene.id !== edit.toId) return scene;
    const targetId = scene.id === edit.fromId ? edit.toId : edit.fromId;
    const manualLinks = (scene.manualLinks ?? []).filter(link => link.targetId !== targetId);
    const blockedLinks = new Set(scene.blockedLinks ?? []);
    if (edit.action === "connect") {
      if (manualLinks.length >= 200) throw new ConnectionError("وصلت اللقطة إلى الحد الأقصى للروابط اليدوية.", 400);
      manualLinks.push({ targetId, yaw: normalizeConnectionYaw(scene.id === edit.fromId ? edit.fromYaw : edit.toYaw) });
      blockedLinks.delete(targetId);
    } else blockedLinks.add(targetId);
    return { ...scene, manualLinks, blockedLinks: [...blockedLinks], links: edit.action === "disconnect" ? scene.links.filter(id => id !== targetId) : scene.links };
  });
  const scenes = applyConnectionOverrides(changed);
  const nextQuality = quality(scenes), previousCalculated = new Set(quality(tour.scenes).warnings);
  nextQuality.warnings = [...new Set([...nextQuality.warnings, ...tour.quality.warnings.filter(warning => !previousCalculated.has(warning))])];
  return { ...tour, scenes, quality: nextQuality };
}
