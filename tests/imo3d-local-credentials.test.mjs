import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withLocalCredential} from '../scripts/lib/imo3d-local-credentials.mjs';

const windows = process.platform === 'win32';
const root = fileURLToPath(new URL('../', import.meta.url));
const modulePath = path.join(root, 'scripts/lib/imo3d-local-credentials.psm1');
const bridge = path.join(root, 'scripts/imo3d-local-credential-bridge.ps1');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const dummy = 'synthetic-only-not-a-provider-key';

function run(script) {
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {windowsHide: true, encoding: 'utf8', timeout: 15000});
}

function fixture(t) {
  const name = 'test-' + randomUUID().replaceAll('-', '');
  const setup = `$ErrorActionPreference='Stop';$WarningPreference='SilentlyContinue';Import-Module ${quote(modulePath)} -Force;`;
  const created = run(setup + `$s=New-Object Security.SecureString;foreach($ch in ${quote(dummy)}.ToCharArray()){$s.AppendChar($ch)};try{Save-ImoLocalCredential -Name ${quote(name)} -Secret $s}finally{$s.Dispose()}`);
  assert.equal(created.status, 0, 'synthetic fixture setup succeeds');
  assert.equal(created.stdout, '', 'saving emits no secret or metadata');
  t.after(() => {
    const cleaned = run(setup + `$p=Get-ImoCredentialPath -Name ${quote(name)};if([IO.File]::Exists($p)){[IO.File]::Delete($p)}`);
    assert.equal(cleaned.status, 0, 'only the synthetic fixture file is removed');
  });
  return {name, setup};
}

test('private pipe reads a synthetic key, then wipes its owned buffer', {skip: !windows}, async t => {
  const {name} = fixture(t);
  let retained;
  const result = await withLocalCredential(name, async bytes => {
    retained = bytes;
    assert.ok(bytes.toString('utf8') === dummy);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.ok(retained.every(value => value === 0));
});

test('callback failure still wipes the synthetic key buffer', {skip: !windows}, async t => {
  const {name} = fixture(t);
  let retained;
  await assert.rejects(withLocalCredential(name, bytes => { retained = bytes; throw new Error('consumer failed'); }), /consumer failed/);
  assert.ok(retained.every(value => value === 0));
});

test('status bridge emits booleans only and rejects corrupted encrypted files', {skip: !windows}, t => {
  const {name, setup} = fixture(t);
  const check = () => spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridge, '-Name', name],
    {windowsHide: true, encoding: 'utf8', timeout: 15000});
  const good = check();
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), {configured: true, decryptable: true});
  assert.equal(good.stderr, '');
  const changed = run(setup + `$p=Get-ImoCredentialPath -Name ${quote(name)};[IO.File]::WriteAllText($p,'invalid-synthetic-ciphertext')`);
  assert.equal(changed.status, 0);
  const bad = check();
  assert.equal(bad.status, 2);
  assert.deepEqual(JSON.parse(bad.stdout), {configured: true, decryptable: false});
  assert.equal(bad.stderr, '');
});

test('missing credential, invalid name, and pre-cancellation fail without sensitive errors', async () => {
  const controller = new AbortController(); controller.abort(new Error('private cancellation detail'));
  for (const [name, options] of [['../invalid', {}], ['test-' + randomUUID().replaceAll('-', ''), {}], ['test-aborted', {signal: controller.signal}]]) {
    await assert.rejects(withLocalCredential(name, () => assert.fail('callback must not run'), options), error => {
      assert.equal(error.message, 'Local credential unavailable. Run private setup under the worker Windows account.');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
