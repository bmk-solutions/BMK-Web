import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCloudReadiness, isProtectedPath, protectedProbes, requiredVercelRules} from '../scripts/imo3d-cloud-preflight.mjs';

const clean = () => ({
  origin: 'https://github.com/bmk-solutions/BMK-Web.git',
  sources: {}, tracked: [], ignored: [...protectedProbes],
  vercelIgnore: requiredVercelRules.join('\n'), inspectionErrors: [],
});
const check = (report, id) => report.checks.find(item => item.id === id);

test('protected data paths include private media, geometry, databases, logs and custom builds', () => {
  for (const value of ['public/imo3d/example/a.webp', 'src/lib/imo3d/example.json', '.imo3d-data/assets/a.png', 'work/input.jpg', '.next-desktop/server/page.js', 'exports/backup.sqlite-wal', '.env.production', 'logs/test.log']) assert.equal(isProtectedPath(value), true, value);
  for (const value of ['src/lib/imo3d/model.ts', 'public/brand/logo.svg', 'docs/imo3d-cloud-deployment.md', 'scripts/imo3d-cloud-preflight.mjs']) assert.equal(isProtectedPath(value), false, value);
});

test('ignore rules cannot conceal sensitive files already tracked by Git', () => {
  const snapshot = clean(); snapshot.tracked = ['public/imo3d/example/a.webp', 'work/private-output.json'];
  const report = evaluateCloudReadiness(snapshot);
  assert.equal(check(report, 'tracked-private-data').status, 'blocked');
  assert.equal(check(report, 'git-exclusions').status, 'passed');
  assert.equal(report.cloudReady, false);
});

test('missing Git protection and Vercel negations both block publication', () => {
  const snapshot = clean(); snapshot.ignored = snapshot.ignored.filter(file => file !== 'src/lib/imo3d/example.json');
  snapshot.vercelIgnore += '\n!public/imo3d/example/a.webp';
  const report = evaluateCloudReadiness(snapshot);
  assert.equal(check(report, 'git-exclusions').status, 'blocked');
  assert.equal(check(report, 'vercel-exclusions').status, 'blocked');
});

test('local database, filesystem, detached workers and 100 MiB buffering are independent blockers', () => {
  const snapshot = clean(); snapshot.sources = {
    'src/lib/imo3d/store.ts': 'import {DatabaseSync} from "node:sqlite";',
    'src/lib/imo3d/assets.ts': 'import {readFile} from "node:fs/promises";',
    'src/lib/imo3d/worker.ts': 'import {spawn} from "node:child_process"; spawn("node",[],{detached:true});',
    'src/app/api/imo3d/upload/route.ts': 'const max=100*1024*1024; Buffer.concat(parts);',
  };
  const report = evaluateCloudReadiness(snapshot);
  for (const id of ['persistent-database', 'private-object-storage', 'worker-queue', 'large-upload-path']) assert.equal(check(report, id).status, 'blocked', id);
});

test('excluding the real dataset exposes the existing clean-build dependency explicitly', () => {
  const snapshot = clean(); snapshot.sources = {'src/lib/imo3d/store.ts': 'import example from "./example.json";'};
  const report = evaluateCloudReadiness(snapshot);
  assert.equal(check(report, 'private-example-dependency').status, 'blocked');
  assert.deepEqual(check(report, 'private-example-dependency').evidence, ['src/lib/imo3d/store.ts']);
});

test('public plan release fails when only administrator access exists', () => {
  const snapshot = clean(); snapshot.sources = {
    'src/app/api/imo3d/tours/[id]/ai-plan/route.ts': 'if(!isAdmin(request)) return deny();',
    'src/app/api/imo3d/tours/[id]/ai-plan/image/route.ts': 'if(!isAdmin(request)) return deny();',
  };
  assert.equal(check(evaluateCloudReadiness(snapshot), 'published-plan-access').status, 'blocked');
});

test('inspection failures and deceptive remote URLs fail closed without exposing input secrets', () => {
  const snapshot = clean(); snapshot.origin = 'https://github.com.attacker.invalid/bmk-solutions/BMK-Web.git';
  snapshot.inspectionErrors = ['Git ls-files inspection failed'];
  snapshot.sources = {'src/lib/imo3d/private.ts': 'const token = "synthetic-secret-must-not-appear";'};
  const report = evaluateCloudReadiness(snapshot);
  assert.equal(check(report, 'repository-scope').status, 'blocked');
  assert.equal(check(report, 'inspection').status, 'blocked');
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-must-not-appear'));
  assert.ok(!JSON.stringify(report).includes('attacker.invalid'));
});

test('static-clear results never claim a live deployment has been verified', () => {
  const snapshot = clean(); snapshot.origin = 'git@github.com:bmk-solutions/BMK-Web.git';
  const report = evaluateCloudReadiness(snapshot);
  assert.equal(report.blockerCount, 0);
  assert.equal(report.status, 'requires-live-verification');
  assert.equal(report.cloudReady, false);
  assert.equal(report.readOnly, true);
});

const guardedCloud = () => ({
 'src/app/api/imo3d/example/route.ts': `import {cloudEnabled} from "@/lib/imo3d/cloud/client";import {cloudRoute} from "@/lib/imo3d/cloud/handlers";import {db} from "../../../../lib/imo3d/store";export async function GET(request){if(cloudEnabled())return cloudRoute(request);return db();}`,
 'src/lib/imo3d/cloud/client.ts': `export const cloudEnabled=()=>process.env.IMO3D_CLOUD==='1';`,
 'src/lib/imo3d/cloud/handlers.ts': `import type {DatabaseSync} from 'node:sqlite';export async function cloudRoute(request){return new Response('ok');}`,
 'src/lib/imo3d/store.ts': `import {DatabaseSync} from 'node:sqlite';import {mkdirSync} from 'node:fs';export function db(){mkdirSync('private');return new DatabaseSync('private.sqlite');}`,
});
test('fully guarded cloud routes exclude inert local runtime adapters and type-only SQLite imports',()=>{
 const snapshot=clean();snapshot.sources=guardedCloud();const report=evaluateCloudReadiness(snapshot);
 assert.equal(check(report,'cloud-route-isolation').status,'passed');assert.equal(check(report,'persistent-database').status,'passed');assert.equal(check(report,'private-object-storage').status,'passed');
});
test('a local call before a cloud guard blocks deployment',()=>{
 const snapshot=clean();snapshot.sources=guardedCloud();const file='src/app/api/imo3d/example/route.ts';snapshot.sources[file]=snapshot.sources[file].replace('if(cloudEnabled())','db();if(cloudEnabled())');
 assert.equal(check(evaluateCloudReadiness(snapshot),'cloud-route-isolation').status,'blocked');
});
test('transitive cloud imports and dynamic builtins cannot hide a local SQLite dependency',()=>{
 for(const dependency of [`import {db} from '../store';`,`const sqlite=process.getBuiltinModule('node:sqlite');`]){
 const snapshot=clean();snapshot.sources=guardedCloud();snapshot.sources['src/lib/imo3d/cloud/handlers.ts']=dependency+'export async function cloudRoute(){return new Response();}';
 assert.equal(check(evaluateCloudReadiness(snapshot),'cloud-route-isolation').status,'blocked');}
});
test('module-scope database initialization is blocked even when every handler has a guard',()=>{
 const snapshot=clean();snapshot.sources=guardedCloud();snapshot.sources['src/lib/imo3d/store.ts']+='const eager=db();';
 assert.equal(check(evaluateCloudReadiness(snapshot),'cloud-route-isolation').status,'blocked');
});
