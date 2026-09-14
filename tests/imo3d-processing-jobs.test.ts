import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { cancelJob, claimJob, enqueueJob, heartbeatJob, imageFingerprint, latestJob } from "../src/lib/imo3d/processing-jobs";

function fixture() {
  const workspace = path.resolve("work/imo3d-job-tests");
  mkdirSync(workspace, { recursive: true });
  const directory = mkdtempSync(path.join(workspace, "database-"));
  const file = path.join(directory, "jobs.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY); INSERT INTO tours VALUES('tour-a'),('tour-b');");
  return { db, file, close() {
    db.close();
    // Delete only these test-created database files, without recursive cleanup.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    rmdirSync(directory);
  } };
}

test("duplicate enqueue keeps a single active job and its original input snapshot", () => {
  const resource = fixture();
  try {
    const a = enqueueJob(resource.db, "tour-a", "original-input");
    const b = enqueueJob(resource.db, "tour-a", "newer-input");
    assert.equal(a.id, b.id);
    assert.equal(b.status, "queued");
    assert.equal(resource.db.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE status IN ('queued','running')").get()?.count, 1);
    assert.equal(resource.db.prepare("SELECT input_hash FROM processing_jobs WHERE id=?").get(a.id)?.input_hash, "original-input");
  } finally { resource.close(); }
});

test("database uniqueness rejects a second active job even if a caller bypasses enqueue", () => {
  const resource = fixture();
  try {
    enqueueJob(resource.db, "tour-a", "input");
    assert.throws(() => resource.db.prepare("INSERT INTO processing_jobs(id,tour_id,status,stage,created_at,updated_at,input_hash) VALUES('collision','tour-a','running','stage','2026-01-01','2026-01-01','hash')").run(), /UNIQUE/);
    assert.throws(() => enqueueJob(resource.db, "missing-tour", "input"), /FOREIGN KEY/);
  } finally { resource.close(); }
});

test("cancel makes the job terminal, denies its heartbeat and permits a fresh retry", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "first");
    assert.equal(claimJob(resource.db, "worker-a")?.id, job.id);
    assert.equal(cancelJob(resource.db, "tour-a")?.status, "cancelled");
    assert.equal(heartbeatJob(resource.db, job.id, "worker-a", 90, "late update"), false);
    const retry = enqueueJob(resource.db, "tour-a", "second");
    assert.notEqual(retry.id, job.id);
    assert.equal(retry.status, "queued");
    assert.equal(latestJob(resource.db, "tour-a")?.id, retry.id);
  } finally { resource.close(); }
});

test("a live lease has one owner and a crashed worker's expired lease is reclaimable", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "input");
    const now = Date.now();
    const first = claimJob(resource.db, "worker-a", now);
    assert.equal(first?.id, job.id);
    assert.equal(first?.attempts, 1);
    assert.equal(first?.lease_owner, "worker-a");
    assert.equal(first?.lease_until, now + 30_000);
    assert.equal(claimJob(resource.db, "worker-b", now + 29_999), undefined);
    const reclaimed = claimJob(resource.db, "worker-b", now + 30_001);
    assert.equal(reclaimed?.id, job.id);
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(reclaimed?.lease_owner, "worker-b");
    assert.equal(heartbeatJob(resource.db, job.id, "worker-a", 99, "stale owner"), false);
    assert.equal(heartbeatJob(resource.db, job.id, "worker-b", 60, "استكمال المعالجة"), true);
  } finally { resource.close(); }
});

test("heartbeat requires the exact active owner and clamps intermediate progress", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "input");
    claimJob(resource.db, "worker-a");
    assert.equal(heartbeatJob(resource.db, job.id, "worker-b", 50, "wrong owner"), false);
    assert.equal(latestJob(resource.db, "tour-a")?.progress, 0);
    assert.equal(heartbeatJob(resource.db, job.id, "worker-a", 110, "stage"), true);
    assert.equal(latestJob(resource.db, "tour-a")?.progress, 99);
    assert.equal(heartbeatJob(resource.db, job.id, "worker-a", -5, "stage"), true);
    assert.equal(latestJob(resource.db, "tour-a")?.progress, 0);
  } finally { resource.close(); }
});

test("queued and running jobs survive closing and reopening the SQLite file", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "persistent-input");
    const secondary = new DatabaseSync(resource.file);
    try {
      assert.equal(latestJob(secondary, "tour-a")?.id, job.id);
      claimJob(secondary, "restarted-process");
    } finally { secondary.close(); }
    assert.equal(latestJob(resource.db, "tour-a")?.status, "running");
    assert.equal(resource.db.prepare("SELECT lease_owner FROM processing_jobs WHERE id=?").get(job.id)?.lease_owner, "restarted-process");
  } finally { resource.close(); }
});

test("the public job projection excludes private lease ownership and input hashes", () => {
  const resource = fixture();
  try {
    enqueueJob(resource.db, "tour-a", "private-input-hash");
    claimJob(resource.db, "private-worker-owner");
    const job = latestJob(resource.db, "tour-a")!;
    assert.equal("input_hash" in job, false);
    assert.equal("lease_owner" in job, false);
    assert.equal("lease_until" in job, false);
    assert.deepEqual(job.warnings, []);
  } finally { resource.close(); }
});

test("an expired owner cannot renew its lease after its authority has ended", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "input"), now = Date.now();
    claimJob(resource.db, "worker-a", now);
    assert.equal(heartbeatJob(resource.db, job.id, "worker-a", 70, "late", now + 30_001), false);
    assert.equal(resource.db.prepare("SELECT lease_until FROM processing_jobs WHERE id=?").get(job.id)?.lease_until, now + 30_000);
  } finally { resource.close(); }
});

test("three crashed attempts become a visible failure that permits an explicit retry", () => {
  const resource = fixture();
  try {
    const job = enqueueJob(resource.db, "tour-a", "input"), now = Date.now();
    assert.equal(claimJob(resource.db, "worker-1", now)?.attempts, 1);
    assert.equal(claimJob(resource.db, "worker-2", now + 30_001)?.attempts, 2);
    assert.equal(claimJob(resource.db, "worker-3", now + 60_002)?.attempts, 3);
    assert.equal(claimJob(resource.db, "worker-4", now + 90_003), undefined);
    const failed = latestJob(resource.db, "tour-a")!;
    assert.equal(failed.id, job.id); assert.equal(failed.status, "failed"); assert.ok(failed.error);
    assert.notEqual(enqueueJob(resource.db, "tour-a", "retry-input").id, job.id);
  } finally { resource.close(); }
});

test("image fingerprint changes for spatial inputs but excludes editing metadata", () => {
  const original = { id: "a", image: "/api/imo3d/assets/a", floor: 0, position: { x: 0, y: 1.6, z: 0 }, yaw: 0, depth: { width: 8, height: 4, values: Array(32).fill(2) }, room: "المطبخ", name: "لقطة 1", links: ["b"] };
  const fingerprint = imageFingerprint([original]);
  assert.equal(fingerprint.length, 64);
  const metadataEdit = { ...original, room: "اسم جديد", name: "New title", links: ["different"] };
  assert.equal(imageFingerprint([metadataEdit]), fingerprint);
  for (const change of [
    { id: "b" }, { image: "/api/imo3d/assets/other" }, { floor: 1 }, { position: { x: 1, y: 1.6, z: 0 } }, { yaw: 90 },
    { depth: { ...original.depth, values: Array(32).fill(3) } },
  ]) assert.notEqual(imageFingerprint([{ ...original, ...change }]), fingerprint);
  assert.notEqual(imageFingerprint([]), fingerprint);
  const reorderedCoordinates = { ...original, position: { z: 0, x: 0, y: 1.6 } };
  assert.equal(imageFingerprint([reorderedCoordinates]), fingerprint);
  const other = { ...original, id: "b" };
  assert.equal(imageFingerprint([original, other]), imageFingerprint([other, original]));
});
