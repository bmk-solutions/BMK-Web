import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./model";
import { privateSceneAssetIds } from "./scene-removal";
import { currentSurfaceModel, surfaceModelMime } from "./surface-model";
import {currentTexturedMesh,meshModelMime} from "./mesh-model";

const assetId = (url?: string) => url && /^\/api\/imo3d\/assets\/([\w-]{1,80})$/.exec(url)?.[1];

/**
 * Call inside the tour mutation's transaction. Delete only owned photographic
 * derivative rows; unlink returned files only after the transaction commits.
 * Scanning all owned models also recovers derivatives orphaned by older saves.
 */
export function pruneUnreferencedSurfaceAssets(database: DatabaseSync, tour: Tour): string[] {
  const owned = database.prepare("SELECT id,file,mime FROM assets WHERE tour_id=? AND mime IN (?,?)").all(tour.id, surfaceModelMime, meshModelMime);
  if (!owned.length) return [];
  const retained = new Set(tour.scenes.flatMap(privateSceneAssetIds));
  for (const plan of tour.plans) {
    for (const url of [plan.image, currentSurfaceModel(plan, tour.scenes)?.url, currentTexturedMesh(plan,tour.scenes)?.url]) {
      const id = assetId(url); if (id) retained.add(id);
    }
  }
  // An imported reference may be owned by another tour. Never delete its row
  // while any other tour still references it, even if its model is not current.
  for (const row of database.prepare("SELECT payload FROM tours WHERE id<>?").all(tour.id)) {
    const other = JSON.parse(String(row.payload)) as Tour;
    for (const id of other.scenes.flatMap(privateSceneAssetIds)) retained.add(id);
    for (const plan of other.plans) for (const url of [plan.image, plan.surfaceModel?.url, plan.texturedMesh?.url]) {
      const id = assetId(url); if (id) retained.add(id);
    }
  }
  const candidates = new Set<string>();
  for (const row of owned) {
    if (retained.has(String(row.id))) continue;
    const removed = database.prepare("DELETE FROM assets WHERE id=? AND tour_id=? AND mime=?").run(row.id, tour.id, row.mime);
    if (removed.changes) candidates.add(String(row.file));
  }
  return [...candidates].filter(file =>
    !database.prepare("SELECT 1 FROM assets WHERE file=? COLLATE NOCASE LIMIT 1").get(file) &&
    !database.prepare("SELECT 1 FROM scene_originals WHERE file=? COLLATE NOCASE LIMIT 1").get(file));
}
