import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGeminiConnection} from '../scripts/check-imo3d-gemini-connection.mjs';

const secret = 'synthetic_private_model_list_key';
const names = ['gemini-3.8-flash', 'gemini-3.1-flash-image'];
const page = (models, nextPageToken) => new Response(JSON.stringify({models: models.map(name => ({name: `models/${name}`})), ...(nextPageToken ? {nextPageToken} : {})}), {headers: {'content-type': 'application/json'}});
const credential = async (name, use) => {
  assert.equal(name, 'gemini-api-key');
  const bytes = Buffer.from(secret);
  try { return await use(bytes); } finally { bytes.fill(0); }
};
const check = (fetchImpl, options = {}) => checkGeminiConnection({withCredential: credential, fetchImpl, ...options});

test('imports have no side effect; GET only, fixed origin/path, header-only key, no request body or redirects', async () => {
  let calls = 0;
  const result = await check(async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(parsed.pathname, '/v1beta/models');
    assert.equal(parsed.searchParams.get('pageSize'), '1000');
    assert.equal(url.includes(secret), false);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.get('x-goog-api-key'), secret);
    return page(names, 'unneeded-next-page');
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {authenticated: true, status: 'ok', complete: true, models: Object.fromEntries(names.map(name => [name, true]))});
});

test('paginated availability is bounded and missing is false only after a complete listing', async () => {
  let calls = 0;
  const result = await check(async url => {
    calls++;
    if (calls === 1) return page([names[0]], 'opaque+/token');
    assert.equal(new URL(url).searchParams.get('pageToken'), 'opaque+/token');
    return page([]);
  });
  assert.equal(calls, 2); assert.equal(result.models[names[0]], true); assert.equal(result.models[names[1]], false);
  let limitedCalls = 0;
  const limited = await check(async () => page([], 'next-' + ++limitedCalls));
  assert.equal(limitedCalls, 3); assert.equal(limited.status, 'pagination_incomplete');
  assert.equal(limited.authenticated, true); assert.equal(limited.complete, false); assert.equal(limited.models[names[0]], null);
});

test('repeated page tokens stop without unbounded requests', async () => {
  let calls = 0;
  const result = await check(async () => { calls++; return page([], 'same-token'); });
  assert.equal(calls, 2); assert.equal(result.status, 'pagination_incomplete');
});

test('HTTP failures never read/log error bodies and return sanitized fixed status', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'quota_or_rate_limit'], [500, 'provider_unavailable'], [400, 'request_rejected']]) {
    const result = await check(async () => new Response(secret, {status}));
    assert.equal(result.status, expected); assert.equal(result.authenticated, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('malformed, oversized and invalid pages fail closed without response content', async () => {
  for (const response of [new Response(secret), new Response('x'.repeat(1024 * 1024 + 1)),
    new Response('{}', {headers: {'content-length': String(1024 * 1024 + 1)}}),
    new Response(JSON.stringify({models: [{name: 123}]})), new Response(JSON.stringify({models: [], nextPageToken: {secret}}))]) {
    const result = await check(async () => response);
    assert.equal(result.status, 'invalid_response'); assert.equal(result.authenticated, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('credential/network errors, timeout and cancellation cannot disclose causes or hang', async () => {
  let requests = 0;
  const missing = await checkGeminiConnection({withCredential: async () => { throw new Error(secret); }, fetchImpl: async () => { requests++; }});
  assert.equal(missing.status, 'credential_unavailable'); assert.equal(requests, 0);
  const network = await check(async () => { throw new Error(secret); });
  assert.equal(network.status, 'network_error'); assert.equal(JSON.stringify(network).includes(secret), false);
  const timeout = await check(() => new Promise(() => {}), {timeoutMs: 20});
  assert.equal(timeout.status, 'timeout');
  const hungBody = await check(async () => new Response(new ReadableStream({cancel: () => new Promise(() => {})})), {timeoutMs: 20});
  assert.equal(hungBody.status, 'timeout');
  const controller = new AbortController(); controller.abort(new Error(secret));
  const cancelled = await check(async () => { requests++; }, {signal: controller.signal});
  assert.equal(cancelled.status, 'cancelled'); assert.equal(requests, 0);
});
