import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import fsPromises from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Plan, Scene, Tour } from "../src/lib/imo3d/model";
import { quality } from "../src/lib/imo3d/spatial";
import { claimJob, enqueueJob, heartbeatJob, imageFingerprint, latestJob } from "../src/lib/imo3d/processing-jobs";
import { privateSceneAssetIds, removeTourScene } from "../src/lib/imo3d/scene-removal";
import { deleteSceneRecord } from "../src/lib/imo3d/scene-deletion";
import { cleanupPrivateAssetFiles } from "../src/lib/imo3d/private-asset-cleanup";
import { cleanupProcessingArtifacts } from "../src/lib/imo3d/processing-cleanup";

const scene = (id: string, floor = 0): Scene => ({ id, name: id, room: "المطبخ", sourceName: `${id}.jpg`, floor, image: `/api/imo3d/assets/${id}-full`, preview: `/api/imo3d/assets/${id}-preview`, thumbnail: `/api/imo3d/assets/${id}-thumb`, position: { x: id === "a" ? 0 : 2, y: 1.6, z: 0 }, yaw: 0, links: [] });
const plan = (floor = 0): Plan => ({ floor, label: "المخطط", kind: "geometry", bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, image: "/imo3d/example/plan-f0.svg", width: 100, height: 100, walls: [{ a: { x: 0, z: 0 }, b: { x: 10, z: 0 } }], scenePoints: { a: { x: 10, y: 10 }, b: { x: 20, y: 20 } } });
const tour = (scenes: Scene[], id = "tour-a"): Tour => ({ id, title: "جولة الاختبار", projectId: "project-a", published: true, revision: 4, scenes, plans: [...new Set(scenes.map(value => value.floor))].map(plan), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", unit: { code: "A101", area: 100, price: 500000, bedrooms: 2, bathrooms: 1 }, quality: quality(scenes) });
function fixture(tours: Tour[]) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER); CREATE TABLE leads(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),name TEXT);");
  for (const value of tours) db.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(value.id, value.projectId, value.revision, value.published ? 1 : 0, JSON.stringify(value));
  return db;
}

test("scene removal preserves the calibrated drawing, remaining metadata and links", () => {
  const a = { ...scene("a"), links: ["b"] }, b = { ...scene("b"), links: ["a", "c"] }, c = { ...scene("c"), links: ["b"] };
  const original = tour([a, b, c]); const result = removeTourScene(original, "a")!;
  assert.deepEqual(result.scenes.map(value => value.id), ["b", "c"]);
  assert.deepEqual(result.scenes.map(value => value.links), [["c"], ["b"]]);
  assert.equal(result.plans[0].image, original.plans[0].image);
  assert.equal(result.plans[0].walls, original.plans[0].walls);
  assert.deepEqual(result.plans[0].scenePoints, { b: { x: 20, y: 20 } });
  assert.equal(result.unit, original.unit); assert.equal(result.title, original.title);
  assert.equal(result.quality.positioned, 2); assert.equal(result.quality.components, 1);
  assert.equal(original.scenes.length, 3); assert.ok(original.plans[0].scenePoints?.a);
  assert.equal(removeTourScene(original, "absent"), null);
});

test("removing a capture cannot approve a regenerated depth drawing", () => {
  const original = tour([scene("a"), {...scene("b"), depth: {width: 8, height: 4, values: Array(32).fill(3)}}]);
  original.plans[0] = {...original.plans[0], kind: "depth", reviewStatus: "rejected"};
  const result = removeTourScene(original, "a")!;
  assert.equal(result.plans[0].reviewStatus, "rejected");
  assert.equal(result.scenes.length, 1);
  assert.equal(original.scenes.length, 2);
});

test("empty floors disappear and deleting the final scene unpublishes the tour", () => {
  const original = tour([scene("a"), scene("b", 1)]);
  const first = removeTourScene(original, "a")!;
  assert.deepEqual(first.plans.map(value => value.floor), [1]); assert.equal(first.published, true);
  const empty = removeTourScene(first, "b")!;
  assert.equal(empty.published, false); assert.deepEqual(empty.plans, []); assert.deepEqual(empty.scenes, []);
  assert.deepEqual(empty.quality, { positioned: 0, depthScenes: 0, components: 0, warnings: [] });
});

test("sample assets are never classified as private files to delete", () => {
  const sample = { ...scene("a"), image: "/imo3d/example/s001.full.webp", preview: "/imo3d/example/s001.lite.webp", thumbnail: "/imo3d/example/s001.poster.webp" };
  assert.deepEqual(privateSceneAssetIds(sample), []);
  const db = fixture([tour([sample])]);
  try { assert.deepEqual(deleteSceneRecord(db, "tour-a", "a", 4).files, []); } finally { db.close(); }
});

test("deleting a panorama also cleans its owned high-resolution tier without affecting other tiers", () => {
  const a = { ...scene("a"), detail: { image: "/api/imo3d/assets/a-detail", width: 8192, height: 4096 } };
  const b = { ...scene("b"), detail: { image: "/api/imo3d/assets/b-detail", width: 8192, height: 4096 } };
  const original = tour([a, b]), db = fixture([original]);
  try {
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-detail", original.id, "a.detail.webp", "image/webp");
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("b-detail", original.id, "b.detail.webp", "image/webp");
    const result = deleteSceneRecord(db, original.id, "a", 4);
    assert.deepEqual(result.files, ["a.detail.webp"]);
    assert.equal(db.prepare("SELECT id FROM assets WHERE id='a-detail'").get(), undefined);
    assert.ok(db.prepare("SELECT id FROM assets WHERE id='b-detail'").get());
    assert.deepEqual(result.tour.scenes[0].detail, b.detail);
  } finally { db.close(); }
});

test("high-resolution tiers still referenced by another scene are retained on image deletion", () => {
  const detail = { image: "/api/imo3d/assets/shared-detail", width: 8192, height: 4096 };
  const original = tour([{ ...scene("a"), detail }, { ...scene("b"), detail }]), db = fixture([original]);
  try {
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("shared-detail", original.id, "shared.detail.webp", "image/webp");
    assert.deepEqual(deleteSceneRecord(db, original.id, "a", 4).files, []);
    assert.ok(db.prepare("SELECT id FROM assets WHERE id='shared-detail'").get());
  } finally { db.close(); }
});

test("source deletion removes the owned photographic model and leaves unrelated assets",()=>{
  const original=tour([scene("a"),scene("b")]);original.plans[0].surfaceModel={url:"/api/imo3d/assets/photo-model",pointCount:2000,floorHeight:0,source:"da3-base-pose-conditioned-multiview",units:"camera_height",cameras:original.scenes.map(value=>({id:value.id,image:value.image,position:value.position!,yaw:value.yaw}))};
  const db=fixture([original]);try{
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("photo-model",original.id,"photo.surface.bin","application/vnd.imo3d.points");
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("b-full",original.id,"retained.webp","image/webp");
    const result=deleteSceneRecord(db,original.id,"a",4);
    assert.deepEqual(result.files,["photo.surface.bin"]);assert.equal(result.tour.plans[0].surfaceModel,undefined);assert.equal(db.prepare("SELECT id FROM assets WHERE id='photo-model'").get(),undefined);assert.ok(db.prepare("SELECT id FROM assets WHERE id='b-full'").get());
  }finally{db.close();}
});

test("stale revision or missing scene rolls back assets, tour and active processing", () => {
  const original = tour([scene("a"), scene("b")]), db = fixture([original]);
  try {
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-full", original.id, "a.webp", "image/webp");
    const job = enqueueJob(db, original.id, imageFingerprint(original.scenes)); claimJob(db, "worker");
    assert.throws(() => deleteSceneRecord(db, original.id, "a", 3), /CONFLICT/);
    assert.throws(() => deleteSceneRecord(db, original.id, "absent", 4), /SCENE_NOT_FOUND/);
    assert.equal(db.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision, 4);
    assert.ok(db.prepare("SELECT id FROM assets WHERE id='a-full'").get());
    assert.equal(latestJob(db, original.id)?.id, job.id); assert.equal(latestJob(db, original.id)?.status, "running");
  } finally { db.close(); }
});

test("deletion commits a new revision and cancels the active worker without touching leads", () => {
  const original = tour([scene("a"), scene("b")]), db = fixture([original]);
  try {
    db.prepare("INSERT INTO leads VALUES(?,?,?)").run("lead", original.id, "عميل الاختبار");
    db.prepare("INSERT INTO scene_originals VALUES(?,?,?,?,?,?)").run("a", original.id, "a.original.jpeg", "image/jpeg", 2048, 1024);
    const job = enqueueJob(db, original.id, imageFingerprint(original.scenes)); claimJob(db, "worker");
    const result = deleteSceneRecord(db, original.id, "a", 4);
    assert.equal(result.tour.revision, 5); assert.deepEqual(result.files, ["a.original.jpeg"]);
    assert.deepEqual(result.jobIds, [], "a running model must exit before its worker removes its artifacts");
    assert.equal(latestJob(db, original.id)?.status, "cancelled");
    assert.equal(heartbeatJob(db, job.id, "worker", 90, "late write"), false);
    assert.notEqual(imageFingerprint(result.tour.scenes), imageFingerprint(original.scenes));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads").get()?.count, 1);
  } finally { db.close(); }
});

test("source deletion cleans completed and review geometry archives after commit, retaining other tours and running work", async () => {
  const original = tour([scene("a"), scene("b")]), other = tour([scene("foreign")], "tour-other"), db = fixture([original, other]);
  const base = path.resolve("work/imo3d-scene-cleanup-tests"); mkdirSync(base, {recursive: true});
  const directory = mkdtempSync(path.join(base, "terminal-evidence-"));
  const archive = (id: string) => {
    const target = path.join(directory, "processing", id, "joint-depth-" + randomUUID(), "joint-geometry");
    mkdirSync(target, {recursive: true});
    const file = path.join(target, "a".repeat(64) + "-pitch-neg30.npz");
    writeFileSync(file, "synthetic private raw and validated camera evidence");
    writeFileSync(path.join(target, "manifest.json"), "synthetic manifest");
    return file;
  };
  try {
    const completed = enqueueJob(db, original.id, "old-completed")!;
    db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(completed.id);
    const review = enqueueJob(db, original.id, "old-review")!;
    db.prepare("UPDATE processing_jobs SET status='review' WHERE id=?").run(review.id);
    const cancelled = enqueueJob(db, original.id, "previous-cancel")!;
    db.prepare("UPDATE processing_jobs SET status='cancelled',lease_owner='still-exiting' WHERE id=?").run(cancelled.id);
    const expiredFailure = enqueueJob(db, original.id, "expired-worker")!;
    db.prepare("UPDATE processing_jobs SET status='failed',lease_owner='expired-owner',lease_until=0,attempts=3 WHERE id=?").run(expiredFailure.id);
    const foreign = enqueueJob(db, other.id, "foreign-completed")!;
    db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(foreign.id);
    const active = enqueueJob(db, original.id, imageFingerprint(original.scenes))!; claimJob(db, "active-worker");
    const completedFile = archive(completed.id), reviewFile = archive(review.id), activeFile = archive(active.id), cancelledFile = archive(cancelled.id), expiredFile = archive(expiredFailure.id), foreignFile = archive(foreign.id);
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("foreign-full", other.id, "foreign.webp", "image/webp");
    const foreignPayload = db.prepare("SELECT payload FROM tours WHERE id=?").get(other.id)?.payload;
    const result = deleteSceneRecord(db, original.id, "a", 4);
    assert.deepEqual(result.jobIds, [completed.id, review.id]);
    assert.equal(db.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision, 5);
    assert.equal(db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(active.id)?.status, "cancelled");
    assert.equal(heartbeatJob(db, active.id, "active-worker", 90, "late model write"), false);
    // This is the API's post-commit cleanup. No model process is started.
    const cleanup = await cleanupProcessingArtifacts(directory, result.jobIds);
    assert.deepEqual(cleanup.removed, [completed.id, review.id]); assert.deepEqual(cleanup.failed, []);
    for (const file of [completedFile, reviewFile]) assert.throws(() => readFileSync(file), /ENOENT/);
    for (const file of [activeFile, cancelledFile, expiredFile, foreignFile]) assert.equal(readFileSync(file, "utf8"), "synthetic private raw and validated camera evidence");
    assert.equal(db.prepare("SELECT payload FROM tours WHERE id=?").get(other.id)?.payload, foreignPayload);
    assert.equal(db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(foreign.id)?.status, "completed");
    assert.ok(db.prepare("SELECT id FROM assets WHERE id='foreign-full'").get());
  } finally {
    db.close(); assert.equal(path.dirname(path.resolve(directory)), base); rmSync(directory, {recursive: true, force: true});
  }
});

test("conflicts and late cancellation failures never schedule terminal evidence cleanup", () => {
  const original = tour([scene("a"), scene("b")]), db = fixture([original]);
  const scheduled: string[] = [];
  try {
    const terminal = enqueueJob(db, original.id, "completed-input")!;
    db.prepare("UPDATE processing_jobs SET status='completed' WHERE id=?").run(terminal.id);
    const active = enqueueJob(db, original.id, imageFingerprint(original.scenes))!; claimJob(db, "worker");
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-full", original.id, "a.webp", "image/webp");
    const attempt = (revision: number) => { const result = deleteSceneRecord(db, original.id, "a", revision); scheduled.push(...result.jobIds); };
    assert.throws(() => attempt(3), /CONFLICT/);
    db.exec("CREATE TRIGGER reject_delete_cancel BEFORE UPDATE OF status ON processing_jobs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'cancellation failed'); END;");
    assert.throws(() => attempt(4), /cancellation failed/);
    assert.deepEqual(scheduled, []);
    assert.equal(db.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload, JSON.stringify(original));
    assert.equal(db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(terminal.id)?.status, "completed");
    assert.equal(db.prepare("SELECT status FROM processing_jobs WHERE id=?").get(active.id)?.status, "running");
    assert.ok(db.prepare("SELECT id FROM assets WHERE id='a-full'").get());
  } finally { db.close(); }
});

test("shared image references and other-tour owned assets are preserved", () => {
  const a = scene("a"), b = { ...scene("b"), preview: a.preview }, other = tour([scene("foreign")], "tour-b");
  const original = tour([a, b]), db = fixture([original, other]);
  try {
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-full", original.id, "shared.webp", "image/webp");
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("foreign-full", other.id, "shared.webp", "image/webp");
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-preview", original.id, "kept-preview.webp", "image/webp");
    // A corrupted cross-tour ID reference still must not confer deletion ownership.
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run("a-thumb", other.id, "foreign-thumb.webp", "image/webp");
    const result = deleteSceneRecord(db, original.id, "a", 4);
    assert.deepEqual(result.files, []);
    assert.equal(db.prepare("SELECT id FROM assets WHERE id='a-full'").get(), undefined);
    for (const id of ["a-preview", "a-thumb", "foreign-full"]) assert.ok(db.prepare("SELECT id FROM assets WHERE id=?").get(id));
  } finally { db.close(); }
});

test("private cleanup deletes only named regular files within its assets directory", async () => {
  const base = path.resolve("work/imo3d-scene-cleanup-tests"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "fixture-")), assets = path.join(directory, "assets"); mkdirSync(assets);
  const owned = path.join(assets, "owned.webp"), kept = path.join(assets, "kept.webp"), outside = path.join(directory, "outside.txt"), nested = path.join(assets, "nested");
  writeFileSync(owned, "owned"); writeFileSync(kept, "keep"); writeFileSync(outside, "outside"); mkdirSync(nested);
  try {
    const result = await cleanupPrivateAssetFiles(directory, ["owned.webp", "owned.webp", "missing.webp", "../outside.txt", "..\\outside.txt", outside, "nested"]);
    assert.equal(result.failed.length, 4);
    assert.throws(() => readFileSync(owned), /ENOENT/);
    assert.equal(readFileSync(kept, "utf8"), "keep"); assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally {
    for (const file of [owned, kept, outside]) rmSync(file, { force: true });
    rmdirSync(nested); rmdirSync(assets); rmdirSync(directory);
  }
});

test("private cleanup retries transient Windows file locks with a bounded failure result", async context => {
  const base = path.resolve("work/imo3d-scene-cleanup-tests"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "locked-")), assets = path.join(directory, "assets"); mkdirSync(assets);
  const temporary = path.join(assets, "temporary.webp"), locked = path.join(assets, "locked.webp");
  writeFileSync(temporary, "temporary"); writeFileSync(locked, "locked");
  const unlink = fsPromises.unlink; let attempts = 0, lockedAttempts = 0;
  const mocked = context.mock.method(fsPromises, "unlink", async (file: Parameters<typeof fsPromises.unlink>[0]) => {
    if (file === temporary && ++attempts < 3) throw Object.assign(new Error("transient"), { code: "EPERM" });
    if (file === locked) { lockedAttempts++; throw Object.assign(new Error("still locked"), { code: "EBUSY" }); }
    return unlink(file);
  });
  try {
    const result = await cleanupPrivateAssetFiles(directory, ["temporary.webp", "locked.webp"]);
    assert.equal(attempts, 3); assert.equal(lockedAttempts, 3);
    assert.deepEqual(result.failed, ["locked.webp"]);
    assert.throws(() => readFileSync(temporary), /ENOENT/); assert.equal(readFileSync(locked, "utf8"), "locked");
  } finally {
    mocked.mock.restore();
    rmSync(temporary, { force: true }); rmSync(locked, { force: true }); rmdirSync(assets); rmdirSync(directory);
  }
});
