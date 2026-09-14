import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Scene, Tour } from "../src/lib/imo3d/model";
import { saveTourMetadata } from "../src/lib/imo3d/floor-assignment";
import { saveFloorBoundaries } from "../src/lib/imo3d/floor-boundaries";
import { deleteSceneRecord } from "../src/lib/imo3d/scene-deletion";
import { claimJob, enqueueJob, imageFingerprint, latestJob } from "../src/lib/imo3d/processing-jobs";
import { currentSurfaceModel, surfaceModelMime } from "../src/lib/imo3d/surface-model";
import { pruneUnreferencedSurfaceAssets } from "../src/lib/imo3d/surface-model-cleanup";
import { mergeTourSpatial } from "../src/lib/imo3d/tour-merge";

const scene = (id: string, x = 0): Scene => ({
  id, name: id, room: "الغرفة", sourceName: id + ".jpg", floor: 0, yaw: 0, position: { x, y: 0, z: 0 }, links: [],
  image: `/api/imo3d/assets/${id}`, preview: `/api/imo3d/assets/${id}`, thumbnail: `/api/imo3d/assets/${id}`,
});
function makeTour(id = "tour"): Tour {
  const scenes = [scene("a"), scene("b", 1)];
  return {
    id, projectId: "project", title: "الجولة", scenes, revision: 1, published: false, createdAt: "now", updatedAt: "now",
    spatialSource: "images", spatialScale: "relative", unit: { code: "", area: null, price: null, bedrooms: null, bathrooms: null },
    quality: { positioned: 2, depthScenes: 0, components: 1, warnings: [] },
    plans: [{ floor: 0, label: "الدور", kind: "estimated", walls: [], bounds: { minX: -1, minZ: -1, maxX: 2, maxZ: 2 },
      surfaceModel: { url: "/api/imo3d/assets/model", pointCount: 100, floorHeight: -1,
        source: "da3-base-pose-conditioned-multiview", units: "camera_height",
        cameras: scenes.map(value => ({ id: value.id, image: value.image, position: value.position!, yaw: value.yaw })) },
    }],
  };
}
function fixture(tours: Tour[]) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  for (const tour of tours) database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(tour.id, tour.projectId, tour.revision, Number(tour.published), JSON.stringify(tour));
  return database;
}
const addModel = (database: DatabaseSync, owner = "tour", id = "model", file = `${id}.surface.bin`) =>
  database.prepare("INSERT INTO assets VALUES(?,?,?,?)").run(id, owner, file, surfaceModelMime);
const metadata = (scenes: Scene[]) => scenes.map(({ id, name, room, floor }) => ({ id, name, room, floor }));

test("floor reassignment removes the old model before source deletion can orphan it", () => {
  const original = makeTour(), database = fixture([original]), files: string[] = [];
  try {
    addModel(database);
    database.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a", original.id, "a.webp", "image/webp");
    database.prepare("INSERT INTO scene_originals VALUES(?,?,?,?,?,?)").run("a", original.id, "a.original.jpg", "image/jpeg", 1024, 512);
    const moved = saveTourMetadata(database, original.id, { revision: 1, scenes: metadata(original.scenes.map(value => value.id === "a" ? { ...value, floor: 1 } : value)) }, files);
    assert.deepEqual(files, ["model.surface.bin"]);
    assert.equal(database.prepare("SELECT id FROM assets WHERE id='model'").get(), undefined);
    assert.ok(moved.plans.every(plan => !plan.surfaceModel));
    const deleted = deleteSceneRecord(database, original.id, "a", moved.revision);
    assert.deepEqual(deleted.files.sort(), ["a.original.jpg", "a.webp"]);
    assert.equal(database.prepare("SELECT id FROM assets WHERE mime=?").get(surfaceModelMime), undefined);
  } finally { database.close(); }
});

test("failed worker cancellation rolls back model pruning and publishes no cleanup filenames", () => {
  const original = makeTour(), database = fixture([original]), files = ["previously-committed.bin"];
  try {
    addModel(database); enqueueJob(database, original.id, imageFingerprint(original.scenes)); claimJob(database, "worker");
    database.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON processing_jobs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'cancel rejected'); END;");
    assert.throws(() => saveTourMetadata(database, original.id, { revision: 1, scenes: metadata(original.scenes.map(value => ({ ...value, floor: 1 }))) }, files), /cancel rejected/);
    assert.deepEqual(files, ["previously-committed.bin"]);
    assert.ok(database.prepare("SELECT id FROM assets WHERE id='model'").get());
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload, JSON.stringify(original));
    assert.equal(latestJob(database, original.id)?.status, "running");
  } finally { database.close(); }
});

test("renaming keeps current models while recovering pre-existing unreferenced derivatives", () => {
  const original = makeTour(), database = fixture([original]), files: string[] = [];
  try {
    addModel(database); addModel(database, original.id, "old-orphan");
    const saved = saveTourMetadata(database, original.id, { revision: 1, title: "الاسم الجديد" }, files);
    assert.ok(currentSurfaceModel(saved.plans[0], saved.scenes));
    assert.ok(database.prepare("SELECT id FROM assets WHERE id='model'").get());
    assert.deepEqual(files, ["old-orphan.surface.bin"]);
  } finally { database.close(); }
});

test("source snapshot changes invalidate an otherwise referenced owned model", () => {
  for (const change of [{ yaw: 90 }, { floor: 1 }, { image: "/api/imo3d/assets/replacement" }, { position: null }]) {
    const original = makeTour(), database = fixture([original]);
    try {
      addModel(database); const next = { ...original, scenes: [{ ...original.scenes[0], ...change }, original.scenes[1]] };
      database.exec("BEGIN IMMEDIATE");
      assert.deepEqual(pruneUnreferencedSurfaceAssets(database, next), ["model.surface.bin"]);
      database.exec("COMMIT");
      assert.equal(database.prepare("SELECT id FROM assets WHERE id='model'").get(), undefined);
    } finally { database.close(); }
  }
});

test("pruning preserves foreign ownership, all cross-tour references and non-model assets", () => {
  const original = makeTour(), other = makeTour("other"); original.plans = [];
  const database = fixture([original, other]);
  try {
    addModel(database); addModel(database, other.id, "foreign-unreferenced"); addModel(database, original.id, "obsolete");
    database.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("photo", original.id, "photo.webp", "image/webp");
    database.exec("BEGIN IMMEDIATE");
    assert.deepEqual(pruneUnreferencedSurfaceAssets(database, original), ["obsolete.surface.bin"]);
    database.exec("COMMIT");
    assert.deepEqual(database.prepare("SELECT id FROM assets ORDER BY id").all().map(row => row.id), ["foreign-unreferenced", "model", "photo"]);
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(other.id)?.payload, JSON.stringify(other));
  } finally { database.close(); }
});

test("removed model rows never schedule files still referenced by other assets or original photos", () => {
  const original = makeTour(), other = makeTour("other"); original.plans = []; other.plans = [];
  const database = fixture([original, other]);
  try {
    addModel(database, original.id, "one", "shared.bin"); addModel(database, original.id, "two", "original.bin");
    database.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("alias", other.id, "shared.bin", "image/webp");
    database.prepare("INSERT INTO scene_originals VALUES(?,?,?,?,?,?)").run("source", other.id, "original.bin", "image/jpeg", 1024, 512);
    database.exec("BEGIN IMMEDIATE");
    assert.deepEqual(pruneUnreferencedSurfaceAssets(database, original), []);
    database.exec("COMMIT");
    assert.equal(database.prepare("SELECT id FROM assets WHERE tour_id=?").get(original.id), undefined);
    assert.ok(database.prepare("SELECT id FROM assets WHERE id='alias'").get());
    assert.ok(database.prepare("SELECT scene_id FROM scene_originals WHERE scene_id='source'").get());
  } finally { database.close(); }
});

test("upload preserves valid source models; replaced camera calibration and depth rebuilds prune them", () => {
  for (const operation of ["upload", "cameras", "depth"] as const) {
    const original = makeTour(), database = fixture([original]);
    try {
      addModel(database);
      const scenes = operation === "upload" ? [...original.scenes, { ...scene("new"), position: null }] :
        original.scenes.map(value => operation === "cameras" ? { ...value, yaw: 30 } : { ...value, depth: { width: 8, height: 4, values: Array(32).fill(3) } });
      const next = { ...original, ...mergeTourSpatial(original, scenes) };
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE tours SET payload=? WHERE id=?").run(JSON.stringify(next), next.id);
      const files = pruneUnreferencedSurfaceAssets(database, next);
      database.exec("COMMIT");
      assert.deepEqual(files, operation === "upload" ? [] : ["model.surface.bin"]);
      assert.equal(Boolean(database.prepare("SELECT id FROM assets WHERE id='model'").get()), operation === "upload");
    } finally { database.close(); }
  }
});

test("saving or clearing authored boundaries cleans the model discarded by plan replacement", () => {
  const room = { id: "manual-room", name: "الغرفة", outline: [{ x: -1, z: -1 }, { x: 2, z: -1 }, { x: 2, z: 2 }, { x: -1, z: 2 }], finish: "wood" as const, openings: [] };
  for (const clear of [false, true]) {
    const original = makeTour(); if (clear) original.plans[0].authoredRooms = [room];
    const database = fixture([original]), files: string[] = [];
    try {
      addModel(database);
      const saved = saveFloorBoundaries(database, original.id, { revision: 1, floor: 0, rooms: clear ? [] : [room] }, files);
      assert.deepEqual(files, ["model.surface.bin"]);
      assert.equal(saved.plans[0].surfaceModel, undefined);
      assert.equal(database.prepare("SELECT id FROM assets WHERE id='model'").get(), undefined);
    } finally { database.close(); }
  }
});
