import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, lstat, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanupProcessingArtifacts, unreferencedInputAssetFiles } from "../src/lib/imo3d/processing-cleanup";

// Fixtures contain only synthetic bytes under ignored work/. Nothing reads or
// deletes the user's real .imo3d-data volume. Retained sentinels are intentional.
async function fixture() {
  const root = path.resolve("work/imo3d-cleanup-tests", randomUUID());
  const data = path.join(root, "data");
  await mkdir(path.join(data, "processing"), { recursive: true });
  return { root, data };
}
async function artifacts(data: string, id: string) {
  const directory = path.join(data, "processing", id);
  await mkdir(path.join(directory, "features"), { recursive: true });
  await writeFile(path.join(directory, "input.json"), "synthetic-private-paths");
  await writeFile(path.join(directory, "result.json"), "synthetic-layout");
  await writeFile(path.join(directory, "result.tmp"), "partial-result");
  await writeFile(path.join(directory, "features", `${"a".repeat(64)}.npz`), "synthetic-image-features");
  const attempt = path.join(directory, `room-analysis-${randomUUID()}`);
  await mkdir(attempt);
  for (const file of ["room-analysis-input.json", "room-profiles.json", "room-vision.json", "photo-depth-input.json", "photo-depth.json"]) {
    await writeFile(path.join(attempt, file), "synthetic-private-room-analysis");
  }
  await mkdir(path.join(directory, "analysis-cache", "boundaries"), { recursive: true });
  await writeFile(path.join(directory, "analysis-cache", `${"b".repeat(64)}.json`), "synthetic-private-captions");
  await writeFile(path.join(directory, "analysis-cache", "boundaries", `${"c".repeat(64)}.json`), "synthetic-private-boundaries");
  await mkdir(path.join(directory, "analysis-cache", "photo-depth"));
  await writeFile(path.join(directory, "analysis-cache", "photo-depth", `${"d".repeat(64)}.json`), "synthetic-private-display-depth");
  const jointAttempt = path.join(directory, `joint-depth-${randomUUID()}`);
  await mkdir(jointAttempt);
  for (const file of ["joint-depth-input.json", "joint-depth.json"]) await writeFile(path.join(jointAttempt, file), "synthetic-joint-surfaces");
  const jointGeometry = path.join(jointAttempt, "joint-geometry");
  await mkdir(jointGeometry);
  for (const file of ["manifest.json", "manifest.json.tmp", `${"f".repeat(64)}-pitch-neg30.npz`, `${"f".repeat(64)}-pitch-pos30.npz.tmp`]) await writeFile(path.join(jointGeometry, file), "synthetic-organized-depth");
  await mkdir(path.join(directory, "analysis-cache", "joint-depth"));
  for (const extension of ["json", "tmp"]) await writeFile(path.join(directory, "analysis-cache", "joint-depth", `${"e".repeat(64)}.${extension}`), "synthetic-joint-depth-cache");
  const architecture=path.join(directory,`depth-architecture-${randomUUID()}`);await mkdir(architecture);
  for(const file of ["depth-architecture-input.json","depth-architecture.json"])await writeFile(path.join(architecture,file),"synthetic-depth-architecture");
  return directory;
}
async function missing(target: string) {
  await assert.rejects(lstat(target), error => (error as NodeJS.ErrnoException).code === "ENOENT");
}

test("removes private artifacts only for explicit deleted job UUIDs", async () => {
  const { data } = await fixture(), deleted = randomUUID(), retained = randomUUID();
  const directory = await artifacts(data, deleted), other = await artifacts(data, retained);
  const result = await cleanupProcessingArtifacts(data, [deleted]);
  assert.deepEqual(result.removed, [deleted]);
  assert.deepEqual(result.failed, []);
  await missing(directory);
  assert.equal(await readFile(path.join(other, "result.json"), "utf8"), "synthetic-layout");
});

test("rejects path traversal, non-UUID names, and absolute paths without touching files", async () => {
  const { data } = await fixture(), id = randomUUID();
  const directory = await artifacts(data, id);
  const values = [`../${id}`, "..", "features", directory, "00000000-0000-0000-0000-000000000000"];
  const result = await cleanupProcessingArtifacts(data, values);
  assert.deepEqual(result.skipped, values);
  assert.deepEqual(result.removed, []);
  assert.equal(await readFile(path.join(directory, "input.json"), "utf8"), "synthetic-private-paths");
});

test("never follows a job-directory junction to another directory", async () => {
  const { root, data } = await fixture(), id = randomUUID(), outside = path.join(root, "outside-job");
  await mkdir(outside);
  await writeFile(path.join(outside, "input.json"), "keep-target");
  await symlink(outside, path.join(data, "processing", id), process.platform === "win32" ? "junction" : "dir");
  const result = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(result.skipped, [id]);
  assert.equal(await readFile(path.join(outside, "input.json"), "utf8"), "keep-target");
});

test("never follows a features-directory junction or deletes its target features", async () => {
  const { root, data } = await fixture(), id = randomUUID(), directory = path.join(data, "processing", id);
  const outside = path.join(root, "outside-features"), feature = `${"b".repeat(64)}.npz`;
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(path.join(directory, "input.json"), "remove-known-input");
  await writeFile(path.join(outside, feature), "keep-target-features");
  await symlink(outside, path.join(directory, "features"), process.platform === "win32" ? "junction" : "dir");
  const result = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(result.skipped, [id]);
  assert.equal(await readFile(path.join(outside, feature), "utf8"), "keep-target-features");
});

test("unknown files are preserved and reported rather than recursively deleted", async () => {
  const { data } = await fixture(), id = randomUUID(), directory = await artifacts(data, id);
  await writeFile(path.join(directory, "operator-note.txt"), "keep-unknown-file");
  const result = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(result.skipped, [id]);
  assert.equal(await readFile(path.join(directory, "operator-note.txt"), "utf8"), "keep-unknown-file");
  await missing(path.join(directory, "result.json"));
});

test("model cleanup admits only UUID attempts, exact output files and SHA256 JSON caches", async () => {
  const { data } = await fixture(), id = randomUUID(), directory = await artifacts(data, id);
  const attempt = path.join(directory, `room-analysis-${randomUUID()}`);
  const unknownAttempt = path.join(directory, "room-analysis-operator-notes");
  const cache = path.join(directory, "analysis-cache");
  await mkdir(attempt);
  await mkdir(unknownAttempt);
  await mkdir(path.join(cache, "nested"));
  await writeFile(path.join(attempt, "room-vision.json"), "remove-known-result");
  const retained = [path.join(attempt, "operator-note.txt"), path.join(unknownAttempt, "room-vision.json"),
    path.join(cache, `${"d".repeat(64)}.txt`), path.join(cache, "caption.json"),
    path.join(cache, "nested", `${"e".repeat(64)}.json`), path.join(cache, "boundaries", "notes.json")];
  for (const file of retained) await writeFile(file, "keep-unknown-content");
  const result = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(result.skipped, [id]);
  assert.deepEqual(result.failed, []);
  for (const file of retained) assert.equal(await readFile(file, "utf8"), "keep-unknown-content");
  await missing(path.join(attempt, "room-vision.json"));
  await missing(path.join(cache, `${"b".repeat(64)}.json`));
  await missing(path.join(cache, "boundaries", `${"c".repeat(64)}.json`));
});

test("joint geometry cleanup retains unrelated files and does not follow a directory junction", async () => {
  const {root, data} = await fixture(), first = randomUUID(), second = randomUUID();
  for (const id of [first, second]) await mkdir(path.join(data, "processing", id));
  const attempt = path.join(data, "processing", first, `joint-depth-${randomUUID()}`);
  const geometry = path.join(attempt, "joint-geometry");
  await mkdir(geometry, {recursive: true});
  const owned = path.join(geometry, `${"a".repeat(64)}-pitch-neg30.npz`), unknown = path.join(geometry, "operator-data.npz");
  await writeFile(owned, "remove-owned"); await writeFile(unknown, "retain-unknown");
  const otherAttempt = path.join(data, "processing", second, `joint-depth-${randomUUID()}`), outside = path.join(root, "outside-geometry");
  await mkdir(otherAttempt); await mkdir(outside);
  const sentinel = path.join(outside, "manifest.json"); await writeFile(sentinel, "retain-target");
  await symlink(outside, path.join(otherAttempt, "joint-geometry"), process.platform === "win32" ? "junction" : "dir");
  const result = await cleanupProcessingArtifacts(data, [first, second]);
  assert.deepEqual(new Set(result.skipped), new Set([first, second]));
  assert.deepEqual(result.failed, []);
  await missing(owned);
  assert.equal(await readFile(unknown, "utf8"), "retain-unknown");
  assert.equal(await readFile(sentinel, "utf8"), "retain-target");
});

for (const group of ["attempt", "analysis-cache", "boundaries", "photo-depth"]) {
  test(`model cleanup never follows a ${group} directory junction`, async () => {
    const { root, data } = await fixture(), id = randomUUID(), directory = path.join(data, "processing", id);
    const outside = path.join(root, `outside-${group}`);
    const relative = group === "attempt" ? `room-analysis-${randomUUID()}`
      : group === "boundaries" || group === "photo-depth" ? path.join("analysis-cache", group) : "analysis-cache";
    const file = group === "attempt" ? "room-vision.json" : `${"d".repeat(64)}.json`;
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(directory, "input.json"), "remove-known-input");
    await writeFile(path.join(outside, file), "keep-target-analysis");
    await symlink(outside, path.join(directory, relative), process.platform === "win32" ? "junction" : "dir");
    const result = await cleanupProcessingArtifacts(data, [id]);
    assert.deepEqual(result.skipped, [id]);
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(path.join(outside, file), "utf8"), "keep-target-analysis");
    await missing(path.join(directory, "input.json"));
  });
}

test("a worker finalizer can remove artifacts recreated during cancellation", async () => {
  const { data } = await fixture(), id = randomUUID();
  const directory = await artifacts(data, id);
  await cleanupProcessingArtifacts(data, [id]);
  await artifacts(data, id); // Simulate the still-exiting image worker recreating it.
  const result = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(result.removed, [id]);
  await missing(directory);
  const repeated = await cleanupProcessingArtifacts(data, [id]);
  assert.deepEqual(repeated.missing, [id]);
});

test("API cleanup and worker finalizer can run concurrently without leaving artifacts", async () => {
  const { data } = await fixture(), id = randomUUID(), directory = await artifacts(data, id);
  const results = await Promise.all([cleanupProcessingArtifacts(data, [id]), cleanupProcessingArtifacts(data, [id])]);
  assert.ok(results.every(result => result.failed.length === 0 && result.skipped.length === 0), JSON.stringify(results));
  await missing(directory);
});

test("worker original-input retry excludes referenced, shared, public and external files", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE assets(file TEXT); CREATE TABLE scene_originals(file TEXT); INSERT INTO assets VALUES('shared.webp'); INSERT INTO scene_originals VALUES('HELD.JPG');");
    const data = path.resolve("work/imo3d-cleanup-tests", randomUUID(), "data");
    const inputPaths = [path.join(data, "assets", "shared.webp"), path.join(data, "assets", "held.jpg"),
      path.join(data, "assets", "deleted.jpg"), path.join(data, "public", "public.webp"),
      path.join(data, "assets", "nested", "other.jpg"), path.join(data, "assets", "..", "outside.jpg")];
    assert.deepEqual(unreferencedInputAssetFiles(database, data, inputPaths), ["deleted.jpg"]);
  } finally { database.close(); }
});

test("original-input eligibility uses fresh references after scene deletion even if job remains", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE assets(file TEXT); CREATE TABLE scene_originals(file TEXT); CREATE TABLE processing_jobs(id TEXT,status TEXT); INSERT INTO scene_originals VALUES('capture.jpg'); INSERT INTO processing_jobs VALUES('retained-job','cancelled');");
    const data = path.resolve("work/imo3d-cleanup-tests", randomUUID(), "data"), input = path.join(data, "assets", "capture.jpg");
    assert.deepEqual(unreferencedInputAssetFiles(database, data, [input]), []);
    database.exec("DELETE FROM scene_originals WHERE file='capture.jpg'");
    assert.deepEqual(unreferencedInputAssetFiles(database, data, [input]), ["capture.jpg"]);
    assert.equal(database.prepare("SELECT count(*) AS count FROM processing_jobs").get()?.count, 1);
  } finally { database.close(); }
});
