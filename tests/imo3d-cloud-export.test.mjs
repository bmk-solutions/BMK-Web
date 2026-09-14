import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSqlValue, encodeSqlValue, exportCloudPackage, inside } from '../scripts/imo3d-export-cloud.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureParent = path.join(project, 'work', 'cloud-export-tests');
async function fixture() {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(path.join(fixtureParent, 'fixture-'));
  const git = spawnSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  assert.equal(git.status, 0);
  await writeFile(path.join(root, '.gitignore'), '/work/\n/.imo3d-data/\n/public/imo3d/\n');
  await mkdir(path.join(root, '.imo3d-data', 'assets'), { recursive: true });
  await mkdir(path.join(root, '.imo3d-data', 'ai-plans', 'plan-1'), { recursive: true });
  await mkdir(path.join(root, 'public', 'imo3d', 'example'), { recursive: true });
  await writeFile(path.join(root, '.imo3d-data', 'assets', 'image.webp'), Buffer.from([1, 2, 3]));
  await writeFile(path.join(root, '.imo3d-data', 'assets', 'original.jpg'), Buffer.from([4, 5, 6]));
  await writeFile(path.join(root, 'public', 'imo3d', 'example', 'reference.webp'), Buffer.from([7, 8]));
  const imagePath = path.join(root, '.imo3d-data', 'ai-plans', 'plan-1', 'plan.png');
  await writeFile(imagePath, Buffer.from([9, 10]));
  const db = new DatabaseSync(path.join(root, '.imo3d-data', 'imo3d.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE tours(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),revision INTEGER,published INTEGER,payload TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT,mime TEXT);
    CREATE TABLE scene_originals(scene_id TEXT PRIMARY KEY,tour_id TEXT REFERENCES tours(id),file TEXT);
    CREATE TABLE project_brand_assets(id TEXT PRIMARY KEY,project_id TEXT,bytes BLOB);
    CREATE TABLE project_branding(project_id TEXT,logo_asset_id TEXT);
    CREATE TABLE ai_plan_jobs(id TEXT PRIMARY KEY,tour_id TEXT,result TEXT);
    CREATE TABLE integration_keys(id TEXT PRIMARY KEY,secret_hash TEXT,large_integer INTEGER);
    INSERT INTO projects VALUES('project-1','Private title');
    INSERT INTO integration_keys VALUES('key-1','PRIVATE HASH — NEVER LOG',9223372036854775807);`);
  const payload = { id: 'tour-1', projectId: 'project-1', revision: 42, published: false, scenes: [{ id: 'scene-1', image: '/api/imo3d/assets/asset-1', floor: 0 }, { id: 'scene-example', image: '/imo3d/example/reference.webp', floor: 0 }] };
  db.prepare('INSERT INTO tours VALUES(?,?,?,?,?)').run('tour-1', 'project-1', 42, 0, JSON.stringify(payload));
  db.exec("INSERT INTO assets VALUES('asset-1','tour-1','image.webp','image/webp'); INSERT INTO scene_originals VALUES('scene-1','tour-1','original.jpg'); INSERT INTO project_branding VALUES('project-1','logo-1');");
  db.prepare('INSERT INTO project_brand_assets VALUES(?,?,?)').run('logo-1', 'project-1', Buffer.from([0, 255, 42]));
  db.prepare('INSERT INTO ai_plan_jobs VALUES(?,?,?)').run('plan-1', 'tour-1', JSON.stringify({ floors: [{ imagePath }] }));
  return { root, db, payload };
}

test('SQL export encoding preserves binary logos and integers above JSON safe range', () => {
  const bytes = Buffer.from([0, 200, 255]);
  assert.deepEqual(decodeSqlValue(JSON.parse(JSON.stringify(encodeSqlValue(bytes)))), bytes);
  const integer = 9223372036854775807n;
  assert.equal(decodeSqlValue(JSON.parse(JSON.stringify(encodeSqlValue(integer)))), integer);
  assert.equal(decodeSqlValue(encodeSqlValue('unmodified text')), 'unmodified text');
  assert.equal(decodeSqlValue(encodeSqlValue(null)), null);
});

test('consistent private snapshot includes WAL, example scenes, branding and immutable source records', async () => {
  const { root, db, payload } = await fixture();
  try {
    const before = db.prepare('SELECT * FROM tours').all();
    const report = await exportCloudPackage({ root });
    assert.equal(report.status, 'verified-local-export');
    assert.equal(report.cloudReady, false);
    assert.equal(report.uploaded, false);
    assert.equal(report.mediaCopied, false);
    assert.equal(report.sourceUnchanged, true);
    assert.deepEqual(report.issues, []);
    assert.equal(report.totals.scenes, 2);
    assert.equal(report.totals.exampleScenesWithoutOriginalRecord, 1);
    assert.equal(report.totals.files, 4);
    assert.equal(report.totals.embeddedBlobs, 1);
    assert.deepEqual(db.prepare('SELECT * FROM tours').all(), before);
    const out = path.join(root, report.outputDirectory);
    const metadata = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));
    assert.deepEqual(JSON.parse(metadata.tables.tours.rows[0].payload), payload);
    assert.equal(decodeSqlValue(metadata.tables.tours.rows[0].revision), 42n);
    assert.equal(decodeSqlValue(metadata.tables.tours.rows[0].published), 0n);
    assert.equal(decodeSqlValue(metadata.tables.integration_keys.rows[0].large_integer), 9223372036854775807n);
    assert.deepEqual(decodeSqlValue(metadata.tables.project_brand_assets.rows[0].bytes), Buffer.from([0, 255, 42]));
    const files = JSON.parse(await readFile(path.join(out, 'files.json'), 'utf8'));
    assert.ok(files.inventory.some(item => item.file === 'public/imo3d/example/reference.webp'));
    assert.ok(files.inventory.every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
    assert.ok(!JSON.stringify(report).includes('PRIVATE HASH'));
    const snapshot = new DatabaseSync(path.join(out, 'snapshot.sqlite'), { readOnly: true });
    assert.equal(snapshot.prepare('SELECT revision FROM tours').get().revision, 42);
    snapshot.close();
  } finally { db.close(); }
});

test('missing image blocks export without removing or repairing source metadata', async () => {
  const { root, db } = await fixture();
  try {
    db.prepare('UPDATE assets SET file=? WHERE id=?').run('missing.webp', 'asset-1');
    const before = db.prepare('SELECT * FROM assets').all();
    const report = await exportCloudPackage({ root });
    assert.equal(report.status, 'blocked');
    assert.equal(report.sourceUnchanged, true);
    assert.ok(report.issues.some(issue => issue.code === 'missing-unreadable-or-changing-file'));
    assert.deepEqual(db.prepare('SELECT * FROM assets').all(), before);
  } finally { db.close(); }
});

test('requires ignored private destination and rejects asset traversal', async () => {
  const { root, db } = await fixture();
  try {
    await writeFile(path.join(root, '.gitignore'), '');
    await assert.rejects(exportCloudPackage({ root }), /Git ignore/);
    await writeFile(path.join(root, '.gitignore'), '/work/\n');
    db.prepare('UPDATE assets SET file=? WHERE id=?').run('../../elsewhere-secret.txt', 'asset-1');
    const report = await exportCloudPackage({ root });
    assert.equal(report.status, 'blocked');
    assert.ok(report.issues.some(issue => issue.code === 'unsafe-asset-path'));
    assert.equal(inside(root, `${root}-other-project/file`), false);
    assert.equal(inside(root, path.join(root, 'public', 'imo3d')), true);
  } finally { db.close(); }
});

test('metadata revision mismatch and cross-tour asset reference block import readiness', async () => {
  const { root, db } = await fixture();
  try {
    db.exec("PRAGMA foreign_keys=OFF; UPDATE tours SET revision=43; UPDATE assets SET tour_id='different-tour';");
    const report = await exportCloudPackage({ root });
    assert.equal(report.status, 'blocked');
    assert.ok(report.issues.some(issue => issue.code === 'tour-metadata-mismatch'));
    assert.ok(report.issues.some(issue => issue.code === 'missing-or-cross-tour-asset'));
  } finally { db.close(); }
});
