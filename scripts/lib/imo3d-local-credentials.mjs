// Local Windows server/worker only. Never import into a client/browser bundle.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bridge = fileURLToPath(new URL('../imo3d-local-credential-bridge.ps1', import.meta.url));
const maximumBytes = 32768;
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(name);
const failure = () => new Error('Local credential unavailable. Run private setup under the worker Windows account.');

function readPrivatePipe(name, {signal, timeoutMs = 15000} = {}) {
  if (process.platform !== 'win32' || !validName(name)) return Promise.reject(failure());
  if (signal?.aborted) return Promise.reject(failure());
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return Promise.reject(failure());
  // No inherited provider keys or child-global mutations; Windows DPAPI uses the login identity.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridge, '-Name', name, '-PrivatePipe'],
      {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env});
    let chunks = [], length = 0, finished = false;
    const dispose = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
    const finish = (buffer) => {
      if (finished) { buffer?.fill(0); return; }
      finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      dispose();
      if (buffer) resolve(buffer); else reject(failure());
    };
    const abort = () => { child.kill(); finish(); };
    const timer = setTimeout(abort, Math.max(1, Math.min(30000, timeoutMs)));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      if (finished) { chunk.fill(0); return; }
      length += chunk.length;
      chunks.push(chunk);
      if (length > maximumBytes) abort();
    });
    child.once('error', () => finish());
    child.once('close', code => {
      if (finished) return;
      if (code !== 0 || length === 0) { finish(); return; }
      finish(Buffer.concat(chunks, length));
    });
  });
}

/** Keep the key inside this callback. Never log, serialize, return, or retain it.
 * Owned buffers are wiped on completion; caller-created copies cannot be wiped here.
 */
export async function withLocalCredential(name, use, options = {}) {
  if (typeof use !== 'function') throw failure();
  const bytes = await readPrivatePipe(name, options);
  try { return await use(bytes); }
  finally { bytes.fill(0); }
}
