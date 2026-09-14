import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./model";
import { cancelJob, ensureProcessingTables } from "./processing-jobs";
import { privateSceneAssetIds, removeTourScene } from "./scene-removal";
import {pruneUnreferencedSurfaceAssets} from "./surface-model-cleanup";

/** Commit the scene, references, owned records and active-job cancellation together. */
export function deleteSceneRecord(database: DatabaseSync, tourId: string, sceneId: string, expectedRevision: number): { tour: Tour; files: string[]; jobIds: string[] } {
  ensureProcessingTables(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT payload FROM tours WHERE id=?").get(tourId);
    if (!row) throw new Error("TOUR_NOT_FOUND");
    const current = JSON.parse(String(row.payload)) as Tour;
    if (current.revision !== expectedRevision) throw new Error("CONFLICT");
    const scene = current.scenes.find(value => value.id === sceneId);
    if (!scene) throw new Error("SCENE_NOT_FOUND");
    // Historical reconstruction inputs can contain this photograph even after
    // their public model was replaced. Prune whole terminal attempts because a
    // multiview archive cannot safely separate one camera's contribution.
    // "cancelled" alone does not prove Python has exited. A failed leased job
    // may likewise have been marked by lease recovery while its child exits.
    // Leave those attempts, along with queued/running jobs, to worker cleanup.
    const jobIds = database.prepare("SELECT id FROM processing_jobs WHERE tour_id=? AND (status IN ('completed','review','stale') OR status='failed' AND lease_owner IS NULL) ORDER BY rowid").all(tourId).map(row => String(row.id));
    const next = removeTourScene(current, sceneId)!;
    const stillReferenced = new Set(next.scenes.flatMap(privateSceneAssetIds));
    for(const plan of next.plans)for(const url of [plan.surfaceModel?.url,plan.texturedMesh?.url]){const id=url?.split('/').at(-1);if(id)stillReferenced.add(id);}
    for (const other of database.prepare("SELECT payload FROM tours WHERE id<>?").all(tourId)) {
      const tour = JSON.parse(String(other.payload)) as Tour;
      for (const id of tour.scenes.flatMap(privateSceneAssetIds)) stillReferenced.add(id);
      for(const plan of tour.plans)for(const url of [plan.surfaceModel?.url,plan.texturedMesh?.url]){const id=url?.split('/').at(-1);if(id)stillReferenced.add(id);}
    }
    const candidates = new Set<string>();
    const modelAssets=current.plans.flatMap(plan=>plan.surfaceModel?.cameras.some(camera=>camera.id===sceneId)?[plan.surfaceModel.url.split('/').at(-1)!]:[]);
    for (const id of [...privateSceneAssetIds(scene),...modelAssets]) {
      if (stillReferenced.has(id)) continue;
      const asset = database.prepare("SELECT file FROM assets WHERE id=? AND tour_id=?").get(id, tourId);
      if (!asset) continue;
      candidates.add(String(asset.file));
      database.prepare("DELETE FROM assets WHERE id=? AND tour_id=?").run(id, tourId);
    }
    const original = database.prepare("SELECT file FROM scene_originals WHERE scene_id=? AND tour_id=?").get(sceneId, tourId);
    if (original) {
      candidates.add(String(original.file));
      database.prepare("DELETE FROM scene_originals WHERE scene_id=? AND tour_id=?").run(sceneId, tourId);
    }
    for(const file of pruneUnreferencedSurfaceAssets(database,next))candidates.add(file);
    const files = [...candidates].filter(file => !database.prepare("SELECT 1 FROM assets WHERE file=? COLLATE NOCASE LIMIT 1").get(file) && !database.prepare("SELECT 1 FROM scene_originals WHERE file=? COLLATE NOCASE LIMIT 1").get(file));
    const saved: Tour = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    const changed = database.prepare("UPDATE tours SET payload=?,revision=?,published=? WHERE id=? AND revision=?").run(JSON.stringify(saved), saved.revision, saved.published ? 1 : 0, tourId, expectedRevision);
    if (!changed.changes) throw new Error("CONFLICT");
    cancelJob(database, tourId);
    database.exec("COMMIT");
    return { tour: saved, files, jobIds };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
