import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sceneSchema, type Scene, type Tour } from "../src/lib/imo3d/model";
import { applyConnectionOverrides, rebaseManualLinkYaws, rebaseVisualLinkYaws } from "../src/lib/imo3d/connection-overrides";
import { ConnectionError, editTourConnection } from "../src/lib/imo3d/connection-editing";
import { saveConnectionEdit } from "../src/lib/imo3d/connection-storage";
import { autoConnect, quality } from "../src/lib/imo3d/spatial";
import { mergeTourSpatial } from "../src/lib/imo3d/tour-merge";
import { removeTourScene } from "../src/lib/imo3d/scene-removal";
import { claimJob, enqueueJob, heartbeatJob, imageFingerprint, latestJob } from "../src/lib/imo3d/processing-jobs";

const scene = (id: string, floor = 0): Scene => ({ id, name: id, room: "المطبخ", sourceName: `${id}.jpg`, floor,
  image: `/api/imo3d/assets/${id}`, preview: `/api/imo3d/assets/${id}`, thumbnail: `/api/imo3d/assets/${id}`,
  position: null, yaw: 0, links: [] });
const tour = (scenes: Scene[], id = "tour-a"): Tour => ({ id, title: "جولة الاختبار", projectId: "project-a", published: true, revision: 4,
  scenes, plans: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  unit: { code: "A101", area: 100, price: 500000, bedrooms: 2, bathrooms: 1 }, quality: quality(scenes) });
const connect = { action: "connect" as const, fromId: "a", toId: "b", fromYaw: -90, toYaw: 450 };
const disconnect = { action: "disconnect" as const, fromId: "a", toId: "b" };
const clear = (id: string): Scene => ({ ...scene(id), position: { x: 0, y: 1.6, z: id === "b" ? -2 : 0 },
  depth: { width: 8, height: 4, values: Array(32).fill(8) } });

test("manual pairing creates reciprocal navigation without fabricating spatial data", () => {
  const original = tour([scene("a"), scene("b"), scene("c")]);
  const result = editTourConnection(original, connect);
  assert.deepEqual(result.scenes.map(value => value.links), [["b"], ["a"], []]);
  assert.deepEqual(result.scenes[0].manualLinks, [{ targetId: "b", yaw: 270 }]);
  assert.deepEqual(result.scenes[1].manualLinks, [{ targetId: "a", yaw: 90 }]);
  assert.ok(result.scenes.every(value => value.position === null && !value.depth));
  assert.equal(result.plans, original.plans); assert.equal(result.unit, original.unit);
  assert.equal(result.quality.positioned, 0); assert.equal(result.quality.components, 2);
  assert.ok(result.quality.warnings.some(value => value.includes("لا تثبت")));
  assert.deepEqual(original.scenes[0].links, []);
  assert.deepEqual(autoConnect(result.scenes).map(value => value.links), [["b"], ["a"], []]);
});

test("editing a direction replaces the pair once, and reconnect clears both blocks", () => {
  const linked = editTourConnection(tour([scene("a"), scene("b")]), connect);
  const updated = editTourConnection(linked, { ...connect, fromYaw: 32, toYaw: 212 });
  assert.deepEqual(updated.scenes[0].manualLinks, [{ targetId: "b", yaw: 32 }]);
  const removed = editTourConnection(updated, disconnect);
  assert.deepEqual(removed.scenes.map(value => value.links), [[], []]);
  assert.deepEqual(removed.scenes.map(value => value.manualLinks), [[], []]);
  assert.deepEqual(removed.scenes.map(value => value.blockedLinks), [["b"], ["a"]]);
  const restored = editTourConnection(removed, connect);
  assert.deepEqual(restored.scenes.map(value => value.blockedLinks), [[], []]);
  assert.deepEqual(restored.scenes.map(value => value.links), [["b"], ["a"]]);
});

test("an explicit removal beats verified automatic edges and retained legacy edges", () => {
  const initial = tour(autoConnect([clear("a"), clear("b")]));
  assert.deepEqual(initial.scenes[0].links, ["b"]);
  const removed = editTourConnection(initial, disconnect);
  assert.deepEqual(autoConnect(removed.scenes).map(value => value.links), [[], []]);
  const withoutDepth = removed.scenes.map(value => ({ ...value, depth: undefined }));
  // Even an old reciprocal imported graph must not undo the user's newer block.
  const legacy = { ...initial, scenes: initial.scenes.map(value => ({ ...value, depth: undefined })) };
  assert.deepEqual(mergeTourSpatial(legacy, withoutDepth).scenes.map(value => value.links), [[], []]);
  const inconsistent = removed.scenes.map(value => ({ ...value, links: value.id === "a" ? ["b"] : ["a"], manualLinks: [{ targetId: value.id === "a" ? "b" : "a", yaw: 0 }] }));
  assert.deepEqual(applyConnectionOverrides(inconsistent).map(value => value.links), [[], []]);
});

test("invalid pairs and one-sided metadata do not become manual links", () => {
  const original = tour([scene("a"), scene("b"), scene("up", 1)]);
  for (const edit of [{ ...connect, toId: "a" }, { ...connect, toId: "missing" }, { ...connect, toId: "up" }, { ...connect, fromYaw: Infinity }]) {
    assert.throws(() => editTourConnection(original, edit), (error: unknown) => error instanceof ConnectionError && [400, 404].includes(error.status));
  }
  const [a, b] = original.scenes;
  assert.deepEqual(applyConnectionOverrides([{ ...a, manualLinks: [{ targetId: b.id, yaw: 90 }] }, b]).map(value => value.links), [[], []]);
  assert.equal(sceneSchema.safeParse({ ...a, manualLinks: [{ targetId: "b", yaw: 90 }, { targetId: "b", yaw: 180 }] }).success, false);
  assert.equal(sceneSchema.safeParse({ ...a, blockedLinks: ["b", "b"] }).success, false);
  assert.equal(sceneSchema.safeParse({ ...a, manualLinks: [{ targetId: "b", yaw: Infinity }] }).success, false);
  assert.deepEqual(sceneSchema.parse({ ...a, manualLinks: [{ targetId: "b", yaw: 90 }], blockedLinks: ["up"] }).blockedLinks, ["up"]);
});

test("panorama deletion removes manual and blocked references while keeping other choices", () => {
  const linked = editTourConnection(editTourConnection(tour([scene("a"), scene("b"), scene("c")]), connect), { ...connect, toId: "c" });
  const before = editTourConnection(linked, { ...disconnect, fromId: "b", toId: "c" });
  const result = removeTourScene(before, "b")!;
  assert.deepEqual(result.scenes.map(value => value.id), ["a", "c"]);
  assert.deepEqual(result.scenes.map(value => value.links), [["c"], ["a"]]);
  assert.ok(result.scenes.every(value => !value.manualLinks?.some(link => link.targetId === "b") && !value.blockedLinks?.includes("b")));
});

test("camera recalibration preserves the selected pixel direction in each panorama", () => {
  const original = editTourConnection(tour([scene("a"), scene("b")]), { ...connect, fromYaw: 45, toYaw: 230 });
  const a = { ...original.scenes[0], yaw: 20 };
  assert.deepEqual(rebaseManualLinkYaws(a, 70), [{ targetId: "b", yaw: 95 }]);
  const merged = mergeTourSpatial(original, original.scenes.map(value => ({ ...value, yaw: value.id === "a" ? 90 : -30 })));
  assert.deepEqual(merged.scenes.map(value => value.manualLinks?.[0].yaw), [135, 200]);
  assert.deepEqual(merged.scenes.map(value => value.links), [["b"], ["a"]]);
  assert.ok(merged.scenes.every(value => value.position === null));
});

test("manual directions and exclusions invalidate processing input independent of array order", () => {
  const original = scene("a"), baseline = imageFingerprint([original]);
  const edited = { ...original, manualLinks: [{ targetId: "b", yaw: 90 }, { targetId: "c", yaw: 180 }], blockedLinks: ["d", "e"] };
  assert.notEqual(imageFingerprint([edited]), baseline);
  assert.equal(imageFingerprint([edited]), imageFingerprint([{ ...edited, manualLinks: [...edited.manualLinks].reverse(), blockedLinks: [...edited.blockedLinks].reverse() }]));
  assert.notEqual(imageFingerprint([edited]), imageFingerprint([{ ...edited, manualLinks: [{ targetId: "b", yaw: 91 }, edited.manualLinks[1]] }]));
  assert.notEqual(imageFingerprint([edited]), imageFingerprint([{ ...edited, blockedLinks: ["d"] }]));
});

test("visual bearings keep the same image direction after recalibration and survive an unrelated upload without map coordinates",()=>{
  const a={...scene("a"),links:["b"],visualLinks:[{targetId:"b",yaw:90}]},b={...scene("b"),links:["a"],visualLinks:[{targetId:"a",yaw:270}]};
  const original=tour([a,b]);
  assert.deepEqual(rebaseVisualLinkYaws(a,45),[{targetId:"b",yaw:135}]);
  const merged=mergeTourSpatial(original,[{...a,yaw:45},b,scene("new")]);
  assert.deepEqual(merged.scenes.map(value=>value.links),[["b"],["a"],[]]);
  assert.equal(merged.scenes[0].visualLinks?.[0].yaw,135);
  assert.ok(merged.scenes.every(value=>value.position===null));
});

test("visual pair metadata is removed with deleted, blocked, cross-floor or nonreciprocal targets",()=>{
  const a={...scene("a"),links:["b"],visualLinks:[{targetId:"b",yaw:90}]},b={...scene("b"),links:["a"],visualLinks:[{targetId:"a",yaw:270}]};
  assert.deepEqual(removeTourScene(tour([a,b]),"b")?.scenes[0].visualLinks,[]);
  for(const target of [{...b,floor:1},{...b,visualLinks:[]},{...b,blockedLinks:["a"]}])assert.deepEqual(applyConnectionOverrides([a,target])[0].visualLinks,[]);
  assert.equal(sceneSchema.safeParse({...a,visualLinks:[{targetId:"b",yaw:0},{targetId:"b",yaw:1}]}).success,false);
});

test("revision conflicts roll back and successful manual edits atomically cancel only their tour job", () => {
  const original = tour([scene("a"), scene("b")]), other = tour([scene("c"), scene("d")], "tour-b");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY,revision INTEGER,payload TEXT);");
  for (const value of [original, other]) db.prepare("INSERT INTO tours VALUES(?,?,?)").run(value.id, value.revision, JSON.stringify(value));
  try {
    const job = enqueueJob(db, original.id, imageFingerprint(original.scenes)); claimJob(db, "worker");
    const otherJob = enqueueJob(db, other.id, imageFingerprint(other.scenes));
    assert.throws(() => saveConnectionEdit(db, original.id, 3, connect), (error: unknown) => error instanceof ConnectionError && error.status === 409);
    assert.throws(() => saveConnectionEdit(db, original.id, 4, { ...connect, toId: "missing" }), (error: unknown) => error instanceof ConnectionError && error.status === 404);
    assert.equal(latestJob(db, original.id)?.status, "running");
    assert.equal(db.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision, 4);
    const saved = saveConnectionEdit(db, original.id, 4, connect);
    assert.equal(saved.revision, 5); assert.equal(latestJob(db, original.id)?.status, "cancelled");
    assert.equal(heartbeatJob(db, job.id, "worker", 99, "stale write"), false);
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload)), saved);
    assert.equal(latestJob(db, other.id)?.id, otherJob.id); assert.equal(latestJob(db, other.id)?.status, "queued");
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT payload FROM tours WHERE id=?").get(other.id)?.payload)), other);
    assert.notEqual(imageFingerprint(saved.scenes), imageFingerprint(original.scenes));
  } finally { db.close(); }
});
