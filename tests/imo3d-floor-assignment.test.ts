import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Plan, Scene, Tour } from "../src/lib/imo3d/model";
import { derivePlans, quality } from "../src/lib/imo3d/spatial";
import { claimJob, enqueueJob, heartbeatJob, imageFingerprint, latestJob } from "../src/lib/imo3d/processing-jobs";
import { applySceneFloorAssignments, FloorAssignmentError, saveTourMetadata, tourMetadataSchema, uploadFloorSchema } from "../src/lib/imo3d/floor-assignment";
import {applyRoomSemantics,initialRoomSemantic} from "../src/lib/imo3d/room-semantics";

const scene = (id: string, floor = 0, x = 0, z = 0): Scene => ({
  id, floor, name: id, room: "الغرفة", sourceName: id + ".jpg", position: { x, y: 1.6, z }, yaw: 35,
  image: "/api/imo3d/assets/" + id, preview: "/api/imo3d/assets/" + id, thumbnail: "/api/imo3d/assets/" + id, links: [],
});
const plan = (floor = 0): Plan => ({
  floor, label: "مخطط " + floor, kind: "geometry", bounds: { minX: -1, minZ: -1, maxX: 8, maxZ: 8 },
  walls: [{ a: { x: -1, z: -1 }, b: { x: 8, z: -1 } }],
});
const tour = (scenes: Scene[], id = "tour-a"): Tour => ({
  id, projectId: "project-a", title: "جولة الاختبار", revision: 4, published: true, scenes,
  plans: [...new Set(scenes.map(value => value.floor))].map(plan), quality: quality(scenes),
  unit: { code: "A1", area: 90, price: 500000, bedrooms: 2, bathrooms: 1 },
  spatialSource: "calibrated", spatialScale: "metric", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const metadata = (scenes: Scene[]) => scenes.map(({ id, name, room, floor }) => ({ id, name, room, floor }));
function fixture(values: Tour[]) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,published INTEGER,payload TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT,width INTEGER,height INTEGER);");
  for (const value of values) database.prepare("INSERT INTO tours VALUES(?,?,?,?,?)").run(value.id, value.projectId, value.revision, Number(value.published), JSON.stringify(value));
  return database;
}

test('recorded measurement height is revision safe, scoped to current images and preserves other tours and geometry',()=>{
 const original=tour([scene('a'),scene('b')]),other=tour([scene('c')],'other');
 const database=fixture([original,other]);
 try{
  for(const height of [0,-1,11,'1.8',NaN,Infinity])assert.equal(tourMetadataSchema.safeParse({revision:4,measurementHeightMeters:height}).success,false);
  const input=tourMetadataSchema.parse({revision:4,measurementHeightMeters:1.87,measurementScale:{sceneIds:['foreign']}});
  const saved=saveTourMetadata(database,original.id,input);
  assert.deepEqual(saved.measurementScale,{heightMeters:1.87,source:'operator_measured',sceneIds:['a','b']});
  assert.deepEqual(saved.scenes,original.scenes);assert.deepEqual(saved.plans,original.plans);assert.equal(saved.spatialScale,original.spatialScale);
  assert.equal(database.prepare('SELECT payload FROM tours WHERE id=?').get(other.id)?.payload,JSON.stringify(other));
  assert.throws(()=>saveTourMetadata(database,original.id,{revision:4,measurementHeightMeters:2}),/تغيّرت/);
  const renamed=saveTourMetadata(database,original.id,{revision:5,title:'Renamed'});
  assert.deepEqual(renamed.measurementScale,saved.measurementScale);
  const cleared=saveTourMetadata(database,original.id,{revision:6,measurementHeightMeters:null});
  assert.equal(cleared.measurementScale,undefined);assert.deepEqual(cleared.scenes,original.scenes);
 }finally{database.close();}
});

test("group naming is revision-safe, scoped to one tour and keeps user ownership during a running analysis",()=>{
  const input=[{...scene("a"),room:"لقطات تحتاج تسمية",links:["b"]},{...scene("b"),room:"لقطات تحتاج تسمية",links:["a"]},scene("c")];
  const evidence={observations:[{id:"oa",sceneId:"a",kind:"bedroom" as const,confidence:.95,evidence:["bed visible"]},{id:"ob",sceneId:"b",kind:"bedroom" as const,confidence:.95,evidence:["bed visible"]}],relations:[{id:"same",fromId:"a",toId:"b",kind:"same_room" as const,confidence:.95,verified:true}]};
  const classified=applyRoomSemantics(input,evidence),original=tour(classified.scenes),foreign=tour([scene("foreign")],"other-tour");
  const database=fixture([original,foreign]);
  try{
    const groupId=classified.scenes[0].roomSemantic!.groupId,hash=imageFingerprint(original.scenes);
    enqueueJob(database,original.id,hash);claimJob(database,"test-worker");
    const saved=saveTourMetadata(database,original.id,tourMetadataSchema.parse({revision:4,roomRenames:[{groupId,name:"  غرفة العائلة  "}]}));
    assert.deepEqual(saved.scenes.slice(0,2).map(scene=>[scene.room,scene.roomSemantic?.nameSource]),[["غرفة العائلة","user"],["غرفة العائلة","user"]]);
    assert.deepEqual(saved.scenes[2],original.scenes[2]);assert.deepEqual(saved.plans,original.plans);
    assert.equal(imageFingerprint(saved.scenes),hash);assert.equal(latestJob(database,original.id)?.status,"running");
    assert.ok(applyRoomSemantics(saved.scenes,evidence).scenes.slice(0,2).every(scene=>scene.room==="غرفة العائلة"));
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(foreign.id)?.payload,JSON.stringify(foreign));
    const before=database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload;
    assert.throws(()=>saveTourMetadata(database,original.id,{revision:4,roomRenames:[{groupId,name:"stale"}]}),/تغيّرت/);
    assert.throws(()=>saveTourMetadata(database,original.id,{revision:5,roomRenames:[{groupId,name:"must roll back"},{groupId:"missing",name:"invalid"}]}),/غير موجودة/);
    assert.equal(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload,before);
  }finally{database.close();}
});

test("individual name editing records user ownership while unchanged auto names retain it",()=>{
  const a={...scene("a"),roomSemantic:initialRoomSemantic("a")},b={...scene("b"),roomSemantic:initialRoomSemantic("b")},original=tour([a,b]);
  const database=fixture([original]);
  try{
    const saved=saveTourMetadata(database,original.id,{revision:4,scenes:metadata([{...a,name:"مكتبي",room:"مكتبي"},b])});
    assert.equal(saved.scenes[0].roomSemantic?.nameSource,"user");assert.equal(saved.scenes[1].roomSemantic?.nameSource,"automatic");
    assert.equal(tourMetadataSchema.safeParse({revision:5,roomRenames:[{groupId:"room-a",name:""}]}).success,false);
    assert.equal(tourMetadataSchema.safeParse({revision:5,roomRenames:[{groupId:"room-a",name:"one"},{groupId:"room-a",name:"two"}]}).success,false);
  }finally{database.close();}
});

test("upload floor defaults only when omitted and rejects malformed or out-of-range multipart values", () => {
  assert.equal(uploadFloorSchema.parse(null), 0);
  assert.equal(uploadFloorSchema.parse(undefined), 0);
  for (const value of ["-10", "0", "2", "200", " 12 "]) assert.equal(uploadFloorSchema.parse(value), Number(value));
  for (const value of ["", " ", "-11", "201", "1.5", "1e2", "0x2", "1,2", "NaN", new Blob(["1"])]) assert.equal(uploadFloorSchema.safeParse(value).success, false);
  const form = new FormData(); form.set("floor", "-2");
  assert.equal(uploadFloorSchema.parse(form.get("floor")), -2);
});

test("metadata revision and assigned floors are validated without accepting spatial fields", () => {
  const input = { revision: 4, scenes: [{ ...scene("a"), floor: 2 }] };
  const parsed = tourMetadataSchema.parse(input);
  assert.deepEqual(parsed.scenes, [{ id: "a", name: "a", room: "الغرفة", floor: 2 }]);
  assert.equal(tourMetadataSchema.safeParse({ scenes: input.scenes }).success, false);
  for (const floor of [-11, 201, .5, "2"]) assert.equal(tourMetadataSchema.safeParse({ ...input, scenes: [{ ...input.scenes[0], floor }] }).success, false);
});

test("moving one capture removes its calibration and reciprocal cross-floor references while retaining other floors", () => {
  const a = { ...scene("a"), depth: { width: 8, height: 4, values: Array(32).fill(8) }, links: ["b"], manualLinks: [{ targetId: "b", yaw: 90 }], visualLinks: [{ targetId: "b", yaw: 90 }], blockedLinks: ["b"] };
  const b = { ...scene("b", 0, 3), links: ["a"], manualLinks: [{ targetId: "a", yaw: 270 }], visualLinks: [{ targetId: "a", yaw: 270 }], blockedLinks: ["a"] };
  const c = scene("c", 1, 20), d = scene("d", 2, 40), original = tour([a, b, c, d]);
  const result = applySceneFloorAssignments(original, [{ ...a, floor: 2 }, b, c, d]);
  const moved = result.scenes[0], left = result.scenes[1];
  assert.equal(moved.floor, 2); assert.equal(moved.position, null); assert.equal(moved.depth, undefined); assert.equal(moved.yaw, a.yaw);
  assert.deepEqual(moved.links, []); assert.deepEqual(moved.manualLinks, []); assert.deepEqual(moved.blockedLinks, []);
  assert.deepEqual(left.links, []); assert.deepEqual(left.manualLinks, []); assert.deepEqual(left.blockedLinks, []);
  assert.deepEqual(moved.visualLinks, []); assert.deepEqual(left.visualLinks, []);
  assert.equal(left.position, b.position); assert.equal(result.scenes[3].position, d.position);
  assert.equal(result.plans.find(value => value.floor === 1), original.plans[1]);
  assert.equal(result.plans.find(value => value.floor === 2)?.walls, original.plans[2].walls);
  assert.equal(original.scenes[0].position, a.position); assert.deepEqual(original.scenes[0].links, ["b"]);
});

test("moving a manually linked group retains doorway bearings but discards unverified computed links", () => {
  const a = { ...scene("a"), links: ["b", "c"], manualLinks: [{ targetId: "b", yaw: 55 }] };
  const b = { ...scene("b"), links: ["a"], manualLinks: [{ targetId: "a", yaw: 235 }] };
  const c = { ...scene("c"), links: ["a"] }, original = tour([a, b, c]);
  const result = applySceneFloorAssignments(original, original.scenes.map(value => ({ ...value, floor: 3 })));
  assert.deepEqual(result.scenes.map(value => value.position), [null, null, null]);
  assert.deepEqual(result.scenes.map(value => value.links), [["b"], ["a"], []]);
  assert.deepEqual(result.scenes[0].manualLinks, a.manualLinks);
  assert.deepEqual(result.plans.map(value => [value.floor, value.kind]), [[3, "missing"]]);
});

test("estimated floor surfaces are invalidated and remaining camera positions generate only a relative path", () => {
  const a = scene("a"), b = scene("b", 0, 3), original = tour([a, b]);
  original.spatialSource = "images"; original.spatialScale = "relative";
  original.plans = [{ ...plan(), kind: "estimated", walls: [], estimatedSurfaces: [{ a: { x: 1, z: 2 }, b: { x: 3, z: 2 }, confidence: .5, supportPoints: 30, kind: "vertical_surface", classification: "unverified" }] }];
  const result = applySceneFloorAssignments(original, [{ ...a, floor: 1 }, b]);
  assert.equal(result.plans[0].kind, "path"); assert.deepEqual(result.plans[0].walls, []);
  assert.equal(result.plans[0].estimatedSurfaces, undefined); assert.equal(result.plans[1].kind, "missing");
  assert.equal(result.scenes[1].position, b.position);
});

test("registered drawings survive valid remaining anchors and drop stale pixel registration when anchors become insufficient", () => {
  const scenes = [scene("a"), scene("b", 0, 4), scene("c", 0, 0, 3), scene("d", 0, 4, 3)];
  const original = tour(scenes), drawing = {
    ...plan(), image: "/imo3d/example/plan.svg", width: 300, height: 300,
    scenePoints: Object.fromEntries(scenes.map(value => [value.id, { x: 20 + value.position!.x * 40, y: 250 - value.position!.z * 40 }])),
  };
  original.plans = [drawing];
  const retained = applySceneFloorAssignments(original, scenes.map(value => ({ ...value, floor: value.id === "a" ? 1 : 0 })));
  assert.equal(retained.plans[0].image, drawing.image); assert.equal(retained.plans[0].walls, drawing.walls);
  assert.equal(retained.plans[0].scenePoints?.a, undefined); assert.ok(retained.plans[0].scenePoints?.b);
  const insufficient = applySceneFloorAssignments(original, scenes.map(value => ({ ...value, floor: ["a", "b"].includes(value.id) ? 1 : 0 })));
  assert.equal(insufficient.plans[0].kind, "geometry"); assert.equal(insufficient.plans[0].image, undefined);
  assert.equal(insufficient.plans[0].scenePoints, undefined); assert.equal(insufficient.plans[0].walls, drawing.walls);
  const unplaced = { ...scene("unplaced"), position: null }, last = tour([scenes[0], unplaced]); last.plans = [drawing];
  const cleared = applySceneFloorAssignments(last, [{ ...scenes[0], floor: 1 }, unplaced]);
  assert.equal(cleared.plans[0].kind, "missing"); assert.deepEqual(cleared.plans[0].walls, []);
});

test("depth-derived plans exclude the moved capture's samples", () => {
  const a = { ...scene("a"), depth: { width: 8, height: 4, values: Array(32).fill(8) } };
  const b = { ...scene("b", 0, 3), depth: { width: 8, height: 4, values: Array(32).fill(4) } };
  const original = tour([a, b]); original.plans = derivePlans(original.scenes);
  const result = applySceneFloorAssignments(original, [{ ...a, floor: -1 }, b]);
  assert.deepEqual(result.plans.find(value => value.floor === 0)?.walls, derivePlans([b])[0].walls);
  assert.equal(result.scenes[0].depth, undefined); assert.equal(result.scenes[1].depth, b.depth);
});

test("metadata-only save preserves spatial/manual state and the active worker", () => {
  const a = { ...scene("a"), manualLinks: [{ targetId: "b", yaw: 90 }], links: ["b"], blockedLinks: ["c"] };
  const b = { ...scene("b"), manualLinks: [{ targetId: "a", yaw: 270 }], links: ["a"] };
  const original = tour([a, b]), database = fixture([original]);
  try {
    enqueueJob(database, original.id, imageFingerprint(original.scenes)); claimJob(database, "worker");
    const next = saveTourMetadata(database, original.id, { revision: 4, title: "اسم جديد", scenes: metadata(original.scenes).map(value => ({ ...value, room: "اسم الغرفة" })) });
    assert.equal(next.revision, 5); assert.equal(next.title, "اسم جديد");
    assert.deepEqual(next.plans, original.plans); assert.deepEqual(next.scenes[0].manualLinks, a.manualLinks);
    assert.deepEqual(next.scenes[0].blockedLinks, a.blockedLinks); assert.deepEqual(next.scenes[0].position, a.position);
    assert.equal(latestJob(database, original.id)?.status, "running");
  } finally { database.close(); }
});

test("floor assignment commits its revision and cancellation together without affecting another tour's job", () => {
  const original = tour([scene("a"), scene("b")]), other = tour([scene("other")], "tour-b"), database = fixture([original, other]);
  try {
    const job = enqueueJob(database, original.id, imageFingerprint(original.scenes)); claimJob(database, "worker");
    enqueueJob(database, other.id, imageFingerprint(other.scenes));
    const next = saveTourMetadata(database, original.id, { revision: 4, scenes: metadata(original.scenes).map(value => ({ ...value, floor: value.id === "a" ? 1 : 0 })) });
    assert.equal(next.revision, 5); assert.equal(latestJob(database, original.id)?.status, "cancelled");
    assert.equal(heartbeatJob(database, job.id, "worker", 90, "late write"), false);
    assert.equal(latestJob(database, other.id)?.status, "queued"); assert.notEqual(imageFingerprint(next.scenes), imageFingerprint(original.scenes));
    assert.equal(database.prepare("SELECT revision FROM tours WHERE id=?").get(original.id)?.revision, 5);
  } finally { database.close(); }
});

test("stale revision or invalid scene membership leaves both the tour and active job unchanged", () => {
  const original = tour([scene("a"), scene("b")]), database = fixture([original]);
  const status = (code: number) => (error: unknown) => error instanceof FloorAssignmentError && error.status === code;
  try {
    enqueueJob(database, original.id, imageFingerprint(original.scenes)); claimJob(database, "worker");
    assert.throws(() => saveTourMetadata(database, original.id, { revision: 3, scenes: metadata(original.scenes) }), status(409));
    assert.throws(() => saveTourMetadata(database, original.id, { revision: 4, scenes: metadata([scene("a"), scene("foreign")]) }), status(400));
    assert.throws(() => saveTourMetadata(database, "absent", { revision: 4 }), status(404));
    assert.deepEqual(JSON.parse(String(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload)), original);
    assert.equal(latestJob(database, original.id)?.status, "running");
  } finally { database.close(); }
});

test("a failed cancellation rolls back the floor change instead of leaving a live worker on new geometry", () => {
  const original = tour([scene("a"), scene("b")]), database = fixture([original]);
  try {
    enqueueJob(database, original.id, imageFingerprint(original.scenes)); claimJob(database, "worker");
    database.exec("CREATE TRIGGER reject_cancellation BEFORE UPDATE OF status ON processing_jobs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'test cancellation failure'); END;");
    assert.throws(() => saveTourMetadata(database, original.id, { revision: 4, scenes: metadata(original.scenes).map(value => ({ ...value, floor: 1 })) }), /test cancellation failure/);
    assert.deepEqual(JSON.parse(String(database.prepare("SELECT payload FROM tours WHERE id=?").get(original.id)?.payload)), original);
    assert.equal(latestJob(database, original.id)?.status, "running");
  } finally { database.close(); }
});


test('entry view is revision safe, saves only one room entrance and does not change navigation',()=>{
 const original=tour([scene('a'),scene('b'),{...scene('c'),room:'different'}]),other=tour([scene('foreign')],'other');
 const database=fixture([original,other]);
 try{
  const view={yaw:90,pitch:0,fov:74};
  const saved=saveTourMetadata(database,original.id,tourMetadataSchema.parse({revision:4,entryView:{sceneId:'a',view}}));
  assert.deepEqual(saved.scenes[0],{...original.scenes[0],entryView:view});assert.deepEqual(saved.plans,original.plans);
  assert.throws(()=>saveTourMetadata(database,original.id,{revision:4,entryView:{sceneId:'b',view}}),/تغيّرت/);
  assert.throws(()=>saveTourMetadata(database,original.id,{revision:5,entryView:{sceneId:'foreign',view}}),/غير موجودة/);
  const moved=saveTourMetadata(database,original.id,{revision:5,entryView:{sceneId:'b',view}});
  assert.equal(moved.scenes[0].entryView,undefined);assert.deepEqual(moved.scenes[1].entryView,view);
  assert.equal(database.prepare('SELECT payload FROM tours WHERE id=?').get(other.id)?.payload,JSON.stringify(other));
  const removed=saveTourMetadata(database,original.id,{revision:6,entryView:{sceneId:'b',view:null}});assert.equal(removed.scenes[1].entryView,undefined);
 }finally{database.close();}
});
