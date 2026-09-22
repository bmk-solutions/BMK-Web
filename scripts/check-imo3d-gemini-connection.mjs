// Read-only model listing. Importing this module does not read a key or make a request.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {withLocalCredential} from './lib/imo3d-local-credentials.mjs';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';
const expectedModels = ['gemini-3.8-flash', 'gemini-3.1-flash-image'];
const maximumPages = 3;
const maximumPageBytes = 1024 * 1024;
const stopped = () => new Error('stopped');

async function abortable(promise, signal) {
  if (signal.aborted) throw stopped();
  let abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(stopped());
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function readPage(response, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > maximumPageBytes) throw stopped();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > maximumPageBytes) throw stopped();
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, length);
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only synthetic credentials/fetches should be injected by tests. No provider body or raw error is returned. */
export async function checkGeminiConnection({withCredential = withLocalCredential, fetchImpl = globalThis.fetch,
  timeoutMs = 15000, signal: callerSignal} = {}) {
  const result = {authenticated: false, status: 'credential_unavailable', complete: false,
    models: Object.fromEntries(expectedModels.map(name => [name, null]))};
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, {once: true});
  if (callerSignal?.aborted) cancel();
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 15000;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, boundedTimeout);
  const signal = controller.signal;
  try {
    if (signal.aborted) throw stopped();
    await abortable(withCredential('gemini-api-key', async bytes => {
      if (!(bytes instanceof Uint8Array)) throw stopped();
      let key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
      if (!/^[\x21-\x7e]{8,8192}$/.test(key)) { result.status = 'invalid_credential'; throw stopped(); }
      const headers = new Headers({'x-goog-api-key': key, Accept: 'application/json'});
      key = undefined;
      const seenTokens = new Set();
      let pageToken;
      try {
        for (let page = 0; page < maximumPages; page++) {
          if (signal.aborted) throw stopped();
          const url = new URL(endpoint);
          url.searchParams.set('pageSize', '1000');
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          result.status = 'network_error';
          const response = await abortable(fetchImpl(url.href, {method: 'GET', headers, redirect: 'error',
            credentials: 'omit', cache: 'no-store', signal}), signal);
          if (!response.ok) {
            result.status = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
              : response.status === 429 ? 'quota_or_rate_limit' : response.status >= 500 ? 'provider_unavailable' : 'request_rejected';
            void response.body?.cancel().catch(() => {});
            return;
          }
          result.status = 'invalid_response';
          const body = await readPage(response, signal);
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.error !== undefined) throw stopped();
          const models = body.models ?? [];
          if (!Array.isArray(models) || models.length > 1000 || models.some(model => !model || typeof model.name !== 'string' || model.name.length > 256)) throw stopped();
          const token = body.nextPageToken;
          if (token !== undefined && (typeof token !== 'string' || token.length > 4096)) throw stopped();
          result.authenticated = true;
          for (const name of expectedModels) if (models.some(model => model.name === `models/${name}`)) result.models[name] = true;
          if (!token || expectedModels.every(name => result.models[name] === true)) {
            for (const name of expectedModels) result.models[name] ??= false;
            result.complete = true; result.status = 'ok'; return;
          }
          result.status = 'pagination_incomplete';
          if (seenTokens.has(token)) return;
          seenTokens.add(token); pageToken = token;
        }
      } finally { headers.delete('x-goog-api-key'); }
    }, {signal, timeoutMs: boundedTimeout}), signal);
  } catch {
    if (callerSignal?.aborted) result.status = 'cancelled';
    else if (timedOut) result.status = 'timeout';
    // Preserve only an enumerated status, never error text, headers, key fragments or response bodies.
  } finally {
    clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await checkGeminiConnection();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.authenticated && result.status === 'ok' ? 0 : 2;
}
