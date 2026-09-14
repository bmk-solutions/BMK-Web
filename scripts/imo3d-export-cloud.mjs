import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// LOCAL PRIVATE export only. No network client, upload, delete, source SQL write,
// migration execution, or application imports (which could initialize tables).
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const slash = value => value.replaceAll('\\', '/');
const digest = value => createHash('sha256').update(value).digest('hex');
export function encodeSqlValue(value) {
  if (value instanceof Uint8Array) return { $sqlite: 'blob', base64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return { $sqlite: 'integer', decimal: String(value) };
  return value;
}
export function decodeSqlValue(value) {
  if (value?.$sqlite === 'blob') return Buffer.from(value.base64, 'base64');
  if (value?.$sqlite === 'integer') return BigInt(value.decimal);
  return value;
}
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function safeExisting(root, candidate) {
  if (!inside(root, path.resolve(candidate))) throw new Error('Path is outside the project.');
  const resolved = await realpath(candidate);
  if (!inside(root, resolved)) throw new Error('A path resolves outside the project.');
  return resolved;
}
async function hashFile(file) {
  const before = await stat(file, { bigint: true });
  if (!before.isFile()) throw new Error('Expected a regular file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await stat(file, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) throw new Error('File changed during hashing.');
  return { bytes: Number(after.size), sha256: hash.digest('hex'), mtimeNs: String(after.mtimeNs) };
}
export function readMetadata(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
  const tables = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
    statement.setReadBigInts(true);
    const rows = statement.all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeSqlValue(value)])));
    const encodedRows = rows.map(row => JSON.stringify(row)).sort();
    tables[name] = {
      columns: db.prepare(`PRAGMA table_info(${quote(name)})`).all(),
      count: rows.length, sha256: digest(encodedRows.join('\n')), rows,
    };
  }
  return { schema, tables, fingerprint: digest(JSON.stringify([schema, Object.entries(tables).map(([name, table]) => [name, table.count, table.sha256])])) };
}
const scalar = value => value?.$sqlite === 'integer' ? BigInt(value.decimal) : value;
function walkStrings(value, visit, location = '') {
  if (typeof value === 'string') visit(value, location);
  else if (Array.isArray(value)) value.forEach((item, index) => walkStrings(item, visit, `${location}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walkStrings(item, visit, location ? `${location}.${key}` : key);
}
function assertIgnored(root, relative) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, input: `${relative}\0`, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.split('\0').includes(relative)) throw new Error('Private export destination is not protected by Git ignore rules.');
}

export async function exportCloudPackage({ root, dataDirectory = '.imo3d-data' }) {
  root = await realpath(root);
  const dataRoot = await safeExisting(root, path.resolve(root, dataDirectory));
  const sourcePath = await safeExisting(root, path.join(dataRoot, 'imo3d.sqlite'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  await safeExisting(root, work);
  const exportRoot = path.join(work, 'cloud-export');
  await mkdir(exportRoot, { recursive: true });
  await safeExisting(root, exportRoot);
  const stamp = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const destination = path.join(exportRoot, stamp);
  const outputRelative = slash(path.relative(root, destination));
  assertIgnored(root, `${outputRelative}/metadata.json`);
  await mkdir(destination); // Unique, never overwrite an earlier export.
  const report = { format: 'imo3d-private-cloud-export', version: 1, status: 'incomplete', cloudReady: false, createdAt: new Date().toISOString(), outputDirectory: outputRelative, sourceReadOnly: true, uploaded: false, mediaCopied: false };
  let source, snapshot;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
    const before = readMetadata(source);
    const snapshotPath = path.join(destination, 'snapshot.sqlite');
    await backup(source, snapshotPath);
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const metadata = readMetadata(snapshot);
    const issues = [];
    const issue = (code, context) => issues.push({ code, context });
    const integrity = snapshot.prepare('PRAGMA quick_check').all();
    if (integrity.some(row => Object.values(row)[0] !== 'ok')) issue('database-integrity', 'Snapshot quick_check failed.');
    const foreignKeys = snapshot.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) issue('foreign-keys', `${foreignKeys.length} broken foreign key references.`);
    const rows = name => metadata.tables[name]?.rows ?? [];
    const assetRows = new Map(rows('assets').map(row => [String(row.id), row]));
    const logoRows = new Map(rows('project_brand_assets').map(row => [String(row.id), row]));
    const references = [], candidates = new Map();
    const addFile = (file, reason) => {
      const absolute = path.resolve(file);
      if (!inside(root, absolute)) { issue('path-outside-project', reason); return null; }
      const relative = slash(path.relative(root, absolute));
      if (!candidates.has(relative)) candidates.set(relative, { absolute, reasons: new Set() });
      candidates.get(relative).reasons.add(reason);
      return relative;
    };
    async function inventoryDirectory(directory, reason) {
      let entries;
      try { await safeExisting(root, directory); entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') issue('directory-unreadable', reason); return; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { issue('symbolic-link', slash(path.relative(root, file))); continue; }
        if (entry.isDirectory()) await inventoryDirectory(file, reason);
        else if (entry.isFile()) addFile(file, reason);
      }
    }
    await inventoryDirectory(path.join(dataRoot, 'assets'), 'private-assets-inventory');
    await inventoryDirectory(path.join(dataRoot, 'ai-plans'), 'private-ai-plan-artifacts');
    for (const table of ['assets', 'scene_originals']) for (const row of rows(table)) {
      const context = `${table}:${row.id ?? row.scene_id}`;
      const file = path.resolve(dataRoot, 'assets', String(row.file));
      if (!inside(path.join(dataRoot, 'assets'), file)) { issue('unsafe-asset-path', context); continue; }
      references.push({ context, kind: table, target: String(row.file), file: addFile(file, context) });
    }
    const localUrl = (url, context, ownerTour) => {
      let parsed;
      try { parsed = new URL(url, 'http://imo3d-local.invalid'); } catch { issue('invalid-local-url', context); return; }
      if (parsed.origin !== 'http://imo3d-local.invalid') return;
      const pathname = decodeURIComponent(parsed.pathname);
      const asset = pathname.match(/^\/api\/imo3d\/assets\/([^/]+)$/);
      if (asset) {
        const row = assetRows.get(asset[1]);
        if (!row || ownerTour && row.tour_id !== ownerTour) issue('missing-or-cross-tour-asset', context);
        references.push({ context, kind: 'asset-url', target: url, assetId: asset[1], resolved: !!row && (!ownerTour || row.tour_id === ownerTour) });
      } else if (pathname.startsWith('/imo3d/')) {
        const file = path.resolve(root, 'public', `.${pathname}`);
        if (!inside(path.join(root, 'public', 'imo3d'), file)) { issue('unsafe-public-path', context); return; }
        references.push({ context, kind: 'private-example-url', target: url, file: addFile(file, context) });
      } else if (pathname.startsWith('/api/imo3d/branding-assets/')) {
        const id = pathname.split('/').at(-1), resolved = logoRows.has(id);
        if (!resolved) issue('missing-logo', context);
        references.push({ context, kind: 'embedded-logo-url', target: url, assetId: id, resolved });
      }
    };
    let sceneCount = 0, exampleSceneCount = 0;
    const originalScenes = new Set(rows('scene_originals').map(row => String(row.scene_id)));
    for (const row of rows('tours')) {
      let tour;
      try { tour = JSON.parse(row.payload); } catch { issue('invalid-tour-json', String(row.id)); continue; }
      if (tour.id !== row.id || tour.projectId !== row.project_id || BigInt(tour.revision) !== scalar(row.revision) || BigInt(tour.published ? 1 : 0) !== scalar(row.published)) issue('tour-metadata-mismatch', String(row.id));
      sceneCount += tour.scenes?.length ?? 0;
      for (const scene of tour.scenes ?? []) if (!originalScenes.has(scene.id)) {
        if (typeof scene.image === 'string' && scene.image.startsWith('/imo3d/')) exampleSceneCount++;
        else issue('scene-without-original-record', `${row.id}:${scene.id}`);
      }
      walkStrings(tour, (value, field) => { if (value.startsWith('/')) localUrl(value, `tours:${row.id}:${field}`, row.id); });
    }
    for (const row of rows('project_branding')) if (row.logo_asset_id && !logoRows.has(String(row.logo_asset_id))) issue('missing-branding-logo', String(row.project_id));
    // Private job JSON is preserved verbatim in metadata. Only artifact references
    // become inventory entries; never print job prompts/results or credential hashes.
    for (const table of ['ai_plan_jobs', 'processing_jobs']) for (const row of rows(table)) {
      if (!row.result) continue;
      let value;
      try { value = JSON.parse(row.result); } catch { issue('invalid-job-result-json', `${table}:${row.id}`); continue; }
      walkStrings(value, (text, field) => {
        const context = `${table}:${row.id}:${field}`;
        if (path.isAbsolute(text) && /(?:path|file)$/i.test(field)) references.push({ context, kind: 'private-artifact-path', target: text, file: addFile(text, context) });
        else if (text.startsWith('/imo3d/') || text.startsWith('/api/imo3d/assets/')) localUrl(text, context, row.tour_id);
      });
    }
    const inventory = [];
    for (const [relative, candidate] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const resolved = await safeExisting(root, candidate.absolute);
        inventory.push({ file: relative, ...await hashFile(resolved), reasons: [...candidate.reasons].sort() });
      } catch { issue('missing-unreadable-or-changing-file', relative); }
    }
    for (const item of inventory) {
      const current = await stat(path.join(root, item.file), { bigint: true }).catch(() => null);
      if (!current || String(current.mtimeNs) !== item.mtimeNs || Number(current.size) !== item.bytes) issue('file-changed-after-hashing', item.file);
    }
    const after = readMetadata(source);
    const unchanged = before.fingerprint === after.fingerprint && before.fingerprint === metadata.fingerprint;
    if (!unchanged) issue('source-changed-during-export', 'Source metadata changed; generate a fresh export before import.');
    const embeddedBlobs = [];
    for (const [table, data] of Object.entries(metadata.tables)) for (const row of data.rows) for (const [column, value] of Object.entries(row)) if (value?.$sqlite === 'blob') {
      const bytes = Buffer.from(value.base64, 'base64');
      embeddedBlobs.push({ table, column, rowId: row.id ?? null, bytes: bytes.length, sha256: digest(bytes) });
    }
    const totals = { tables: Object.keys(metadata.tables).length, tableCounts: Object.fromEntries(Object.entries(metadata.tables).map(([name, table]) => [name, table.count])), scenes: sceneCount, exampleScenesWithoutOriginalRecord: exampleSceneCount, files: inventory.length, fileBytes: inventory.reduce((sum, item) => sum + item.bytes, 0), references: references.length, embeddedBlobs: embeddedBlobs.length };
    snapshot.close(); snapshot = undefined;
    const snapshotHash = await hashFile(snapshotPath);
    const metadataBody = JSON.stringify({ format: 'imo3d-private-sqlite-metadata', version: 1, classification: 'PRIVATE — contains customer data, private jobs and integration-key hashes; never publish', integerEncoding: { $sqlite: 'integer', decimal: 'exact base-10 integer' }, blobEncoding: { $sqlite: 'blob', base64: 'base64 bytes' }, ...metadata }, null, 2);
    await writeFile(path.join(destination, 'metadata.json'), metadataBody, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(destination, 'files.json'), JSON.stringify({ sourceRoot: root, dataDirectory: slash(path.relative(root, dataRoot)), inventory, embeddedBlobs, references }, null, 2), { flag: 'wx', mode: 0o600 });
    Object.assign(report, { status: issues.length ? 'blocked' : 'verified-local-export', sourceUnchanged: unchanged, sourceFingerprint: before.fingerprint, snapshotFingerprint: metadata.fingerprint, snapshot: { file: 'snapshot.sqlite', ...snapshotHash }, metadata: { file: 'metadata.json', bytes: Buffer.byteLength(metadataBody), sha256: digest(metadataBody) }, totals, issues, limitations: ['Local export only; no cloud import or deployment has been performed.', 'Media files are inventoried in place, not copied. Recheck their SHA256 before any upload.', 'Private integration credentials and job state must never be exposed to public clients.', 'Importer must preserve IDs/revisions/published flags, map private artifact paths to storage object keys, and avoid restarting historical jobs.', 'A verified export does not certify Vercel compatibility or a completed database migration.'] });
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    await writeFile(path.join(destination, 'incomplete.json'), JSON.stringify({ ...report, error: 'Export interrupted or failed. Do not import this directory.' }, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw error;
  } finally { snapshot?.close(); source?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json-summary')) {
    console.error('Usage: node scripts/imo3d-export-cloud.mjs [--json-summary]'); process.exitCode = 1;
  } else {
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const report = await exportCloudPackage({ root, dataDirectory: process.env.IMO3D_DATA_DIR ?? '.imo3d-data' });
      // Counts and the private output path only; do not log metadata or references.
      console.log(JSON.stringify({ status: report.status, cloudReady: false, outputDirectory: report.outputDirectory, sourceUnchanged: report.sourceUnchanged, totals: report.totals, issueCount: report.issues.length }, null, 2));
      process.exitCode = report.issues.length ? 2 : 0;
    } catch { console.error('Local export failed. Inspect only the private export directory; no cloud upload was attempted.'); process.exitCode = 1; }
  }
}
