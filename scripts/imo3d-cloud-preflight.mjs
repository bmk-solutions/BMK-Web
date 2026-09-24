import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {inspectCloudIsolation} from './lib/imo3d-cloud-isolation.mjs';

// Read-only static release guard. It does not connect to cloud services, open
// application databases, read environment secrets, or change the Git index.
export const protectedProbes = [
  '.imo3d-data/imo3d.sqlite', 'work/private-input.png',
  'public/imo3d/example/probe.webp', 'src/lib/imo3d/example.json',
  '.next-desktop/server/probe.js', '.next-production/server/probe.js',
  '.next-dev.stdout.log', '.env.local', 'private-backup.sqlite',
  'scripts/imo3d-register-al-hamra-draft.mjs',
  'scripts/imo3d-align-al-hamra-room-labels.mjs',
  'scripts/imo3d-draft-contact-sheets.mjs',
  'scripts/imo3d-import-image-draft.mjs', 'docs/imo3d/private-review.md',
];
export const requiredVercelRules = [
  '.imo3d-data', 'work', 'public/imo3d', 'src/lib/imo3d/example.json',
  '.next-*', '*.log', '.env*', '*.sqlite', '*.sqlite-*', '*.db', '*.db-*',
  'scripts/imo3d-register-al-hamra-draft.mjs',
  'scripts/imo3d-align-al-hamra-room-labels.mjs',
  'scripts/imo3d-draft-contact-sheets.mjs',
  'scripts/imo3d-import-image-draft.mjs', 'docs/imo3d',
];
const normalize = value => value.replaceAll('\\', '/').replace(/^\.\//, '');
const privatePrefixes = ['.imo3d-data/', 'work/', 'public/imo3d/', '.next/', 'docs/imo3d/'];
const privateExact = new Set(protectedProbes.filter(value => /^(src|scripts)\//.test(value)));
export function isProtectedPath(value) {
  const file = normalize(value), basename = file.split('/').at(-1);
  return privatePrefixes.some(prefix => file.startsWith(prefix)) || privateExact.has(file)
    || /^\.next-[^/]+\//.test(file) || /(^|\/)\.env[^/]*$/.test(file)
    || /\.(?:log|sqlite(?:-[^/]*)?|db(?:-[^/]*)?|pem)$/i.test(basename);
}
const expectedOrigin = value => /^(?:https:\/\/github\.com\/|git@github\.com:)bmk-solutions\/BMK-Web(?:\.git)?\/?$/i.test(value.trim());

export function evaluateCloudReadiness(snapshot) {
  const checks = [];
  const add = (id, blocked, message, evidence = []) => checks.push({id, status: blocked ? 'blocked' : 'passed', message, evidence});
  const files = Object.entries(snapshot.sources ?? {});
  const isolation=inspectCloudIsolation(snapshot.sources??{});
  if(isolation.present)add('cloud-route-isolation',!isolation.isolated,isolation.isolated?'Every API export delegates before local work, and the cloud runtime dependency graph excludes SQLite, filesystem and child-process imports.':'Cloud runtime isolation inspection failed.',isolation.errors);
  const runtimeFiles=isolation.isolated?new Set(isolation.reachable):null;
  const runtimeEvidence=paths=>runtimeFiles?paths.filter(file=>runtimeFiles.has(file)):paths;
  const matching = regex => files.filter(([, content]) => regex.test(content)).map(([file]) => file);
  add('inspection', !!snapshot.inspectionErrors?.length,
    snapshot.inspectionErrors?.length ? 'Inspection was incomplete; release is blocked.' : 'Required source and Git inspection completed.', snapshot.inspectionErrors ?? []);
  add('repository-scope', !expectedOrigin(snapshot.origin ?? ''),
    expectedOrigin(snapshot.origin ?? '') ? 'Origin matches the authorized repository.' : 'Origin is missing or does not match the authorized repository.');
  const tracked = (snapshot.tracked ?? []).filter(isProtectedPath);
  add('tracked-private-data', !!tracked.length,
    tracked.length ? 'Private data is already tracked. Ignore rules do not remove tracked files; review the index before publishing.' : 'No protected data paths are tracked.', tracked);
  const ignored = new Set(snapshot.ignored ?? []);
  const unprotected = protectedProbes.filter(file => !ignored.has(file));
  add('git-exclusions', !!unprotected.length,
    unprotected.length ? 'Git exclusions are missing for private inputs or generated outputs.' : 'Git excludes all required private inputs and generated outputs.', unprotected);
  const rules = new Set((snapshot.vercelIgnore ?? '').split(/\r?\n/).map(line => line.trim().replace(/^\//, '').replace(/\/$/, '')).filter(line => line && !line.startsWith('#')));
  const missingRules = requiredVercelRules.filter(rule => !rules.has(rule));
  const overrides = [...rules].filter(rule => rule.startsWith('!'));
  add('vercel-exclusions', !!(missingRules.length || overrides.length),
    missingRules.length || overrides.length ? 'Vercel archive exclusions are incomplete or contain exceptions needing review.' : 'Vercel archive excludes the required private inputs.', [...missingRules, ...overrides]);
  const sqlite = isolation.isolated?[]:runtimeEvidence(matching(/(?:from\s*|import\s*)["']node:sqlite["']/));
  add('persistent-database', !!sqlite.length,
    sqlite.length ? 'API or shared server modules still depend on local SQLite. Implement the asynchronous cloud repository and atomic revision checks.' : 'No direct SQLite imports found in inspected API/shared modules.', sqlite);
  const filesystem = runtimeEvidence(matching(/(?:from\s*|import\s*)["']node:fs(?:\/promises)?["']/));
  add('private-object-storage', !!filesystem.length,
    filesystem.length ? 'API/shared modules still access local files. Private assets and plan artifacts need cloud object keys and authorized downloads.' : 'No direct filesystem imports found in inspected API/shared modules.', filesystem);
  const workers = runtimeEvidence(matching(/(?:from\s*|import\s*)["']node:child_process["']|detached\s*:\s*true/));
  add('worker-queue', !!workers.length,
    workers.length ? 'The server still launches local child processes. Move long processing to a separately running worker using a durable leased queue.' : 'No child-process launchers found in inspected API/shared modules.', workers);
  const upload = runtimeEvidence(matching(/100\s*\*\s*1024\s*\*\s*1024/).filter(file => /src\/app\/api\//.test(file) && /Buffer\.concat|arrayBuffer\(/.test(snapshot.sources[file])));
  add('large-upload-path', !!upload.length,
    upload.length ? 'A 100 MiB upload is buffered in an API handler. Use signed direct resumable storage uploads and validated finalization.' : 'No known 100 MiB buffered API upload found.', upload);
  const exampleImports = matching(/(?:from\s*|import\s*)["'][^"']*example\.json["']/);
  add('private-example-dependency', !!exampleImports.length,
    exampleImports.length ? 'Source imports the excluded real-apartment dataset. Replace the static import before building a clean checkout; do not force-add the dataset.' : 'No static import of the excluded real-apartment dataset found.', exampleImports);
  const planRoutes = (isolation.isolated?files.filter(([file])=>runtimeFiles.has(file)):files).filter(([file, content]) => /\/ai-plan\/(?:image\/)?route\.ts$/.test(file) && /!(?:await\s+)?isAdmin\(request\)/.test(content) && !/\.published\b/.test(content)).map(([file]) => file);
  add('published-plan-access', !!planRoutes.length,
    planRoutes.length ? 'Raster-plan routes are admin-only. A reviewed plan needs a separate published-tour authorization path.' : 'No known unconditional admin-only raster-plan path found.', planRoutes);
  const blocked = checks.filter(check => check.status === 'blocked');
  return {
    status: blocked.length ? 'blocked' : 'requires-live-verification',
    cloudReady: false,
    readOnly: true,
    blockerCount: blocked.length,
    checks,
    note: 'Static inspection never certifies deployment. Verify isolated cloud import, access control, 100 MiB uploads, revisions, worker restart, and file hashes before release.',
  };
}

export async function collectSnapshot(root) {
  const inspectionErrors = [], sources = {};
  async function read(relative) {
    try { return await readFile(path.join(root, relative), 'utf8'); }
    catch { inspectionErrors.push(`Cannot read ${relative}`); return ''; }
  }
  async function walk(relative) {
    let entries;
    try { entries = await readdir(path.join(root, relative), {withFileTypes: true}); }
    catch { inspectionErrors.push(`Cannot inspect ${relative}`); return; }
    for (const entry of entries) {
      const target = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) { inspectionErrors.push(`Source link requires review: ${target}`); continue; }
      if (entry.isDirectory()) await walk(target);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) sources[target] = await read(target);
    }
  }
  function git(args, input) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024, windowsHide: true});
    if (result.error || result.signal || result.status !== 0 && !(args[0] === 'check-ignore' && result.status === 1)) {
      inspectionErrors.push(`Git ${args[0]} inspection failed`); return '';
    }
    return result.stdout;
  }
  await Promise.all(['src/lib/imo3d', 'src/app/api/imo3d', 'src/components/imo3d'].map(walk));
  const vercelIgnore = await read('.vercelignore');
  const origin = git(['remote', 'get-url', 'origin']).trim();
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const ignored = git(['check-ignore', '--no-index', '-z', '--stdin'], `${protectedProbes.join('\0')}\0`).split('\0').filter(Boolean);
  return {sources, origin, tracked, ignored, vercelIgnore, inspectionErrors};
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) {
    console.error('Usage: node scripts/imo3d-cloud-preflight.mjs [--json]');
    process.exitCode = 1;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const report = evaluateCloudReadiness(await collectSnapshot(root));
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`IMO 3D cloud preflight: ${report.status.toUpperCase()} (${report.blockerCount} blockers)`);
      for (const check of report.checks) {
        console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
        for (const file of check.evidence) console.log(`  ${file}`);
      }
      console.log(report.note);
    }
    // Even a static-clear result is not an automated deployment approval.
    process.exitCode = report.blockerCount ? 1 : 2;
  }
}
