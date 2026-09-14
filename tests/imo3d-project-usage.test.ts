import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectUsage, type ProjectUsage } from "../src/lib/imo3d/project-usage";
import { estimateProjectUsage } from "../src/lib/imo3d/usage-estimate";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT,file TEXT); CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT,file TEXT);
    CREATE TABLE project_brand_assets(id TEXT PRIMARY KEY,project_id TEXT,bytes BLOB);
    CREATE TABLE processing_jobs(id TEXT PRIMARY KEY,tour_id TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO projects VALUES('a'),('b'); INSERT INTO tours VALUES('a1','a'),('a2','a'),('b1','b');
    INSERT INTO assets VALUES('a-file','a1','a.webp'),('a-shared','a2','a.webp'),('b-file','b1','b.webp');
    INSERT INTO scene_originals VALUES('a-original','a1','a.original.jpg'),('b-original','b1','b.original.jpg');
    INSERT INTO project_brand_assets VALUES('logo-a','a',X'010203'),('logo-b','b',X'010203040506');
    INSERT INTO processing_jobs VALUES('a-done','a1','completed','2026-09-08T10:00:00Z','2026-09-08T10:02:00Z'),
      ('a-queued','a1','queued','2026-09-08T11:00:00Z','2026-09-08T11:01:00Z'),
      ('a-bad','a2','failed','invalid','invalid'),('b-done','b1','completed','2026-09-08T10:00:00Z','2026-09-08T11:00:00Z');`);
  const base = path.resolve("work/imo3d-usage-tests"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "fixture-")), assets = path.join(directory, "assets"); mkdirSync(assets);
  const files = ["a.webp", "a.original.jpg", "b.webp", "b.original.jpg"];
  files.forEach((file, index) => writeFileSync(path.join(assets, file), Buffer.alloc((index + 1) * 10)));
  return { database, directory, assets, close() { database.close(); for (const file of files) rmSync(path.join(assets, file), { force: true }); rmdirSync(assets); rmdirSync(directory); } };
}

test("usage counts only project-owned files once plus that project's logo bytes", async () => {
  const data = fixture();
  try {
    const usage = (await projectUsage(data.database, data.directory, "a"))!;
    assert.deepEqual(usage.storage, { bytes: 33, fileBytes: 30, brandingBytes: 3, files: 2, missingFiles: 0, unreadableFiles: 0 });
    assert.equal(usage.processing.jobs, 3); assert.equal(usage.processing.statuses.completed, 1); assert.equal(usage.processing.statuses.queued, 1);
    assert.equal(usage.processing.elapsedSeconds, 120); assert.equal(usage.processing.timedJobs, 1); assert.equal(usage.processing.unknownDurationJobs, 1);
    assert.equal(usage.processing.elapsedBasis, "created-to-last-update"); assert.equal(usage.transfer.bytes, null);
    assert.equal(await projectUsage(data.database, data.directory, "missing"), null);
    assert.equal(data.database.prepare("SELECT count(*) AS count FROM assets").get()?.count, 3);
  } finally { data.close(); }
});

test("missing and unsafe private paths remain explicit unknown bytes without leaving the assets directory", async () => {
  const data = fixture();
  const outside = path.join(data.directory, "outside.txt"); writeFileSync(outside, Buffer.alloc(100));
  try {
    data.database.prepare("INSERT INTO assets VALUES(?,?,?)").run("missing", "a1", "missing.webp");
    data.database.prepare("INSERT INTO assets VALUES(?,?,?)").run("unsafe", "a1", "../outside.txt");
    const usage = (await projectUsage(data.database, data.directory, "a"))!;
    assert.equal(usage.storage.bytes, 33); assert.equal(usage.storage.missingFiles, 1); assert.equal(usage.storage.unreadableFiles, 1);
  } finally { rmSync(outside); data.close(); }
});

test("empty projects and absent optional tables produce measured zero resources with unknown transfer", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT); INSERT INTO projects VALUES('empty');");
  try {
    const usage = (await projectUsage(database, path.resolve("work/imo3d-usage-tests/nonexistent-empty"), "empty"))!;
    assert.equal(usage.storage.bytes, 0); assert.equal(usage.storage.missingFiles, 0);
    assert.equal(usage.processing.jobs, 0); assert.equal(usage.transfer.bytes, null);
  } finally { database.close(); }
});

const usage: ProjectUsage = { projectId: "a", measuredAt: "2026-09-08", storage: { bytes: 2_000_000_000, fileBytes: 2_000_000_000, brandingBytes: 0, files: 2, missingFiles: 0, unreadableFiles: 0 }, processing: { jobs: 1, statuses: { completed: 1 }, elapsedSeconds: 300, elapsedBasis: "created-to-last-update", timedJobs: 1, unknownDurationJobs: 0 }, transfer: { bytes: null } };
test("cost scenario uses decimal GB, recorded elapsed minutes and explicit transfer assumptions", () => {
  assert.deepEqual(estimateProjectUsage(usage, { storagePerGBMonth: 3, elapsedPerMinute: .2, transferGB: 10, transferPerGB: .5 }), { storage: 6, processing: 1, transfer: 5, subtotal: 12, complete: true });
  assert.deepEqual(estimateProjectUsage(usage, { storagePerGBMonth: 3, elapsedPerMinute: null, transferGB: null, transferPerGB: .5 }), { storage: 6, processing: null, transfer: null, subtotal: 6, complete: false });
  const invalid = estimateProjectUsage(usage, { storagePerGBMonth: -1, elapsedPerMinute: Infinity, transferGB: 10, transferPerGB: NaN });
  assert.deepEqual(invalid, { storage: null, processing: null, transfer: null, subtotal: 0, complete: false });
  assert.equal(estimateProjectUsage({ ...usage, storage: { ...usage.storage, missingFiles: 1 } }, { storagePerGBMonth: 0, elapsedPerMinute: 0, transferGB: 0, transferPerGB: 0 }).complete, false);
});
