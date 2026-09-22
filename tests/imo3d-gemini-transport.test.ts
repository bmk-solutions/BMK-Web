import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {z} from 'zod';
import {createGeminiTransport, GeminiTransportError, GEMINI_ENDPOINT, GEMINI_REQUEST_BYTES,
  GEMINI_ANALYSIS_MODEL, GEMINI_IMAGE_MODEL, type GeminiCallOptions} from '../src/lib/imo3d/gemini-transport';

const secret = 'synthetic_private_test_value_000001';
const schema = z.object({sceneIds: z.array(z.string())});
const base = {apiKey: secret, prompt: 'Inspect every supplied photograph.', schema};
const completed = (content: unknown[]) => ({status: 'completed', steps: [{type: 'model_output', content}]});
const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), {
  status, headers: {'content-type': 'application/json', ...headers},
});
const validResponse = () => jsonResponse(completed([{type: 'text', text: '{"sceneIds":[]}'}]));
const png = () => sharp({create: {width: 8, height: 4, channels: 3, background: '#3d7772'}}).png().toBuffer();
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof GeminiTransportError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('all 100 images arrive in order with hashes, fixed official endpoint and header-only key', async () => {
  const bytes = await png();
  const ids = Array.from({length: 100}, (_, i) => `scene-${i}`);
  let calls = 0;
  const transport = createGeminiTransport(async (url, init) => {
    calls++;
    assert.equal(url, GEMINI_ENDPOINT);
    assert.equal(new URL(url).search, '');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), secret);
    assert.equal(String(init.body).includes(secret), false);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, GEMINI_ANALYSIS_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.background, false);
    assert.equal(body.input.filter((p: {type: string}) => p.type === 'image').length, 100);
    assert.equal(body.input.filter((p: {type: string}) => p.type === 'image')
      .every((p: {data: string}) => p.data === bytes.toString('base64')), true);
    assert.deepEqual(body.input.filter((p: {type: string; text: string}) => p.type === 'text').slice(1)
      .map((p: {text: string}) => p.text), ids.map(id => `Image ID: ${id}`));
    assert.equal(body.response_format.mime_type, 'application/json');
    assert.ok(body.response_format.schema.properties.sceneIds);
    return jsonResponse(completed([{type: 'text', text: JSON.stringify({sceneIds: ids})}]));
  });
  const result = await transport.structuredJson({...base, apiKey: Buffer.from(secret),
    images: ids.map(id => ({id, bytes, mimeType: 'image/png'}))});
  assert.equal(calls, 1);
  assert.deepEqual(result.data.sceneIds, ids);
  assert.deepEqual(result.sources.map(s => s.id), ids);
  assert.match(result.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sources[0].sha256, result.sources[99].sha256);
});

test('raw JSON schema requires and invokes a local validator', async () => {
  let parsed = 0;
  const transport = createGeminiTransport(async () => validResponse());
  const result = await transport.structuredJson({...base, schema: {
    jsonSchema: {type: 'object', properties: {sceneIds: {type: 'array', items: {type: 'string'}}}, required: ['sceneIds']},
    parse(value: unknown) {parsed++; return schema.parse(value);},
  }});
  assert.deepEqual(result.data, {sceneIds: []});
  assert.equal(parsed, 1);
  await rejectsCode(transport.structuredJson({...base, schema: {jsonSchema: {type: 'object'}} as never}), 'INVALID_ARGUMENT');
});

test('rejects local schema mismatch and truncation rather than returning partial success', async () => {
  for (const response of [completed([{type: 'text', text: '{"sceneIds":[2]}'}]), completed([{type: 'text', text: '{"sceneIds":['}])]) {
    await rejectsCode(createGeminiTransport(async () => jsonResponse(response)).structuredJson(base), 'SCHEMA_MISMATCH');
  }
  await rejectsCode(createGeminiTransport(async () => jsonResponse({...completed([{type: 'text', text: '{"sceneIds":[]}'}]),
    status: 'incomplete'})).structuredJson(base), 'INCOMPLETE_RESPONSE');
});

test('does not parse echoed input or thought summaries as model JSON', async () => {
  const response = {status: 'completed', steps: [
    {type: 'user_input', content: [{type: 'text', text: 'private source'}]},
    {type: 'thought', summary: [{type: 'text', text: 'not final JSON'}]},
    {type: 'model_output', content: [{type: 'text', text: '{"sceneIds":[]}' }]},
  ]};
  assert.deepEqual((await createGeminiTransport(async () => jsonResponse(response)).structuredJson(base)).data, {sceneIds: []});
  await rejectsCode(createGeminiTransport(async () => jsonResponse({...response, steps: response.steps.slice(0, 2)})).structuredJson(base), 'INVALID_RESPONSE');
});

test('rejects oversized source set without calling fetch or dropping photos', async () => {
  let calls = 0;
  const transport = createGeminiTransport(async () => {calls++; return validResponse();});
  await rejectsCode(transport.structuredJson({...base, images: [
    {id: 'oversized', mimeType: 'image/jpeg', bytes: new Uint8Array(15_000_000)},
  ]}), 'REQUEST_TOO_LARGE');
  assert.equal(calls, 0);
});

test('20 MB bound includes UTF-8, escaping and schema overhead', async () => {
  let calls = 0;
  const transport = createGeminiTransport(async () => {calls++; return validResponse();});
  await rejectsCode(transport.structuredJson({...base, prompt: 'أ'.repeat(GEMINI_REQUEST_BYTES / 2)}), 'REQUEST_TOO_LARGE');
  await rejectsCode(transport.structuredJson({...base, prompt: '\\'.repeat(GEMINI_REQUEST_BYTES / 2)}), 'REQUEST_TOO_LARGE');
  await rejectsCode(transport.structuredJson({...base, schema: {
    jsonSchema: {type: 'object', description: 'x'.repeat(GEMINI_REQUEST_BYTES)}, parse: (value: unknown) => value,
  }}), 'REQUEST_TOO_LARGE');
  assert.equal(calls, 0);
});

test('rejects duplicate IDs, corrupt bytes, and claimed MIME mismatch before any request', async () => {
  const bytes = await png();
  let calls = 0;
  const transport = createGeminiTransport(async () => {calls++; return validResponse();});
  await rejectsCode(transport.structuredJson({...base, images: [
    {id: 'same', bytes, mimeType: 'image/png'}, {id: 'same', bytes, mimeType: 'image/png'},
  ]}), 'INVALID_ARGUMENT');
  await rejectsCode(transport.structuredJson({...base, images: [{id: 'a', bytes: Buffer.from('secret image path ' + secret), mimeType: 'image/png'}]}), 'INVALID_INPUT_IMAGE');
  await rejectsCode(transport.structuredJson({...base, images: [{id: 'a', bytes, mimeType: 'image/jpeg'}]}), 'INVALID_INPUT_IMAGE');
  assert.equal(calls, 0);
});

test('valid image headers with truncated pixels fail before the paid request', async () => {
  const full = await png();
  const truncated = full.subarray(0, 65);
  assert.equal((await sharp(truncated).metadata()).format, 'png');
  let calls = 0;
  await rejectsCode(createGeminiTransport(async () => {calls++; return validResponse();}).structuredJson({...base,
    images: [{id: 'truncated', mimeType: 'image/png', bytes: truncated}],
  }), 'INVALID_INPUT_IMAGE');
  assert.equal(calls, 0);
});

test('allows configurable documented model IDs but cannot change host/path with a model', async () => {
  const transport = createGeminiTransport(async (url, init) => {
    assert.equal(url, GEMINI_ENDPOINT);
    assert.equal(JSON.parse(String(init.body)).model, 'gemini-3-pro-preview');
    return validResponse();
  });
  await transport.structuredJson({...base, model: 'gemini-3-pro-preview'});
  await rejectsCode(transport.structuredJson({...base, model: 'https://untrusted.example/key'}), 'INVALID_ARGUMENT');
});

test('429 and 5xx retry is bounded and honors successful result', async () => {
  let attempts = 0;
  const transport = createGeminiTransport(async () => {
    attempts++;
    return attempts < 3 ? jsonResponse({error: {message: secret}}, attempts === 1 ? 429 : 503, {'retry-after': '0'}) : validResponse();
  });
  await transport.structuredJson({...base, maxRetries: 2});
  assert.equal(attempts, 3);
  attempts = 0;
  const exhausted = createGeminiTransport(async () => {attempts++; return jsonResponse({secret}, 503, {'retry-after': '0'});});
  await rejectsCode(exhausted.structuredJson({...base, maxRetries: 1}), 'HTTP');
  assert.equal(attempts, 2);
});

test('never retries invalid credentials, redirects or ambiguous network failures', async () => {
  for (const status of [301, 400, 401, 403, 404]) {
    let calls = 0;
    await rejectsCode(createGeminiTransport(async () => {calls++; return jsonResponse({error: secret}, status);}).structuredJson(base), 'HTTP');
    assert.equal(calls, 1);
  }
  let calls = 0;
  await rejectsCode(createGeminiTransport(async () => {calls++; throw Error(`Request with ${secret} failed`);}).structuredJson(base), 'NETWORK');
  assert.equal(calls, 1);
});

test('all failure payloads stay private, including schema exceptions', async () => {
  const transport = createGeminiTransport(async () => validResponse());
  await rejectsCode(transport.structuredJson({...base, schema: {jsonSchema: {type: 'object'}, parse() {throw Error(secret);}}}), 'SCHEMA_MISMATCH');
  await rejectsCode(createGeminiTransport(async () => new Response(secret, {headers: {'content-type': 'application/json'}})).structuredJson(base), 'INVALID_RESPONSE');
});

test('abort before call never reaches network; caller reason is not leaked', async () => {
  const controller = new AbortController();
  controller.abort(Error(secret));
  let calls = 0;
  await rejectsCode(createGeminiTransport(async () => {calls++; return validResponse();}).structuredJson({...base, signal: controller.signal}), 'ABORTED');
  assert.equal(calls, 0);
});

test('timeout and caller cancellation abort in-flight fetch', async () => {
  const transport = createGeminiTransport(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Error(secret)), {once: true});
  }));
  await rejectsCode(transport.structuredJson({...base, timeoutMs: 15}), 'TIMEOUT');
  const controller = new AbortController();
  const pending = transport.structuredJson({...base, signal: controller.signal});
  setTimeout(() => controller.abort(secret), 10);
  await rejectsCode(pending, 'ABORTED');
});

test('deadline still returns if an injected transport cannot honor abort', async () => {
  const transport = createGeminiTransport(async () => new Promise<Response>(() => {}));
  await rejectsCode(transport.structuredJson({...base, timeoutMs: 15}), 'TIMEOUT');
});

test('abort interrupts retry backoff rather than performing another paid request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = createGeminiTransport(async () => {
    calls++;
    setTimeout(() => controller.abort(secret), 10);
    return jsonResponse({error: secret}, 429, {'retry-after': '30'});
  });
  await rejectsCode(transport.structuredJson({...base, signal: controller.signal}), 'ABORTED');
  assert.equal(calls, 1);
});

test('provider cooldown longer than the remaining deadline never triggers an early retry', async () => {
  for (const retryAfter of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
    let calls = 0;
    const transport = createGeminiTransport(async () => {
      calls++;
      return jsonResponse({error: secret}, 429, {'retry-after': retryAfter});
    });
    await assert.rejects(transport.structuredJson({...base, timeoutMs: 50, maxRetries: 2}), error => {
      assert.ok(error instanceof GeminiTransportError);
      assert.equal(error.code, 'HTTP');
      assert.equal(error.status, 429);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('response deadline includes stalled body streams and cancels them', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({cancel() {cancelled = true;}});
  await rejectsCode(createGeminiTransport(async () => new Response(stream, {headers: {'content-type': 'application/json'}}))
    .structuredJson({...base, timeoutMs: 15}), 'TIMEOUT');
  assert.equal(cancelled, true);
});

test('bounds streamed response even with missing or dishonest content-length', async () => {
  for (const advertised of [undefined, '1', '50000000']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(new Uint8Array(40_000_001));},
      cancel() {cancelled = true;},
    });
    await rejectsCode(createGeminiTransport(async () => new Response(stream, {headers: {
      'content-type': 'application/json', ...(advertised ? {'content-length': advertised} : {}),
    }})).structuredJson(base), 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  }
});

test('image editing sends every reference and returns fully decoded canonical PNG', async () => {
  const input = await png();
  const jpeg = await sharp(input).jpeg().toBuffer();
  const transport = createGeminiTransport(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, GEMINI_IMAGE_MODEL);
    assert.equal(body.input.filter((p: {type: string}) => p.type === 'image').length, 2);
    assert.deepEqual(body.response_format, [{type: 'text'}, {type: 'image', delivery: 'inline', image_size: '4K', aspect_ratio: '3:2'}]);
    return jsonResponse(completed([{type: 'image', mime_type: 'image/jpeg', data: jpeg.toString('base64')}, {type: 'text', text: 'Draft only.'}]));
  });
  const result = await transport.generateImage({...base, imageSize: '4K', aspectRatio: '3:2', includeText: true,
    images: [{id: 'source', bytes: input, mimeType: 'image/png'}, {id: 'geometry', bytes: input, mimeType: 'image/png'}]});
  assert.deepEqual(result.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await sharp(result.png).metadata()).format, 'png');
  assert.equal(result.width, 8);
  assert.equal(result.height, 4);
  assert.equal(result.sources.length, 2);
  assert.equal(result.text, 'Draft only.');
});

test('new image generation allows no source images and image-only response', async () => {
  const image = await png();
  const transport = createGeminiTransport(async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)).response_format, {type: 'image', delivery: 'inline', image_size: '2K'});
    return jsonResponse(completed([{type: 'image', mime_type: 'image/png', data: image.toString('base64')}]));
  });
  const result = await transport.generateImage(base);
  assert.equal(result.text, '');
  assert.deepEqual(result.sources, []);
});

test('does not fetch output URLs or silently choose multiple generated images', async () => {
  const image = {type: 'image', mime_type: 'image/png', data: (await png()).toString('base64')};
  for (const parts of [[{type: 'image', mime_type: 'image/png', uri: 'https://untrusted.example/image'}], [image, image], [{type: 'text', text: 'Refused'}]]) {
    let calls = 0;
    await rejectsCode(createGeminiTransport(async () => {calls++; return jsonResponse(completed(parts));}).generateImage(base), 'INVALID_OUTPUT_IMAGE');
    assert.equal(calls, 1);
  }
});

test('rejects bad base64, truncated pixels, wrong MIME, and oversized image dimensions', async () => {
  const image = await png();
  const oversized = await sharp({create: {width: 5000, height: 5000, channels: 3, background: '#fff'}}).png().toBuffer();
  for (const item of [
    {mime_type: 'image/png', data: 'not-base64!'},
    {mime_type: 'image/png', data: image.subarray(0, 65).toString('base64')},
    {mime_type: 'image/jpeg', data: image.toString('base64')},
    {mime_type: 'image/png', data: oversized.toString('base64')},
    {mime_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64')},
  ]) await rejectsCode(createGeminiTransport(async () => jsonResponse(completed([{type: 'image', ...item}]))).generateImage(base), 'INVALID_OUTPUT_IMAGE');
});

test('invalid configuration never silently raises budgets or sends a key', async () => {
  let calls = 0;
  const transport = createGeminiTransport(async () => {calls++; return validResponse();});
  for (const options of [{timeoutMs: 300001}, {maxRetries: 3}, {apiKey: 'bad\r\nheader'}, {timeoutMs: NaN}, {maxRetries: -1}]) {
    await rejectsCode(transport.structuredJson({...base, ...options}), 'INVALID_ARGUMENT');
  }
  await rejectsCode(transport.generateImage({...base, imageSize: '8K' as never}), 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
});

test('browser invocation is blocked before accessing a secret or making requests', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {}});
  try {
    await rejectsCode(createGeminiTransport(async () => validResponse()).structuredJson(base), 'SERVER_ONLY');
  } finally {
    if (old) Object.defineProperty(globalThis, 'window', old);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

// Compile-time transport boundary must accept the private loader's owned buffer directly.
const acceptsPrivateBuffer: GeminiCallOptions = {apiKey: Buffer.alloc(32), prompt: 'unused'};
void acceptsPrivateBuffer;

test('accepts opaque current authorization keys but rejects header injection', async () => {
 const transport=createGeminiTransport(async()=>validResponse());
 await transport.structuredJson({...base,apiKey:'synthetic.authorization-key='+ 'x'.repeat(600)});
 await rejectsCode(transport.structuredJson({...base,apiKey:'synthetic-key\r\nx-evil: value'}),'INVALID_ARGUMENT');
});
