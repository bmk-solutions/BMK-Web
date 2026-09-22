/** Node/server-only Gemini transport. Credentials are supplied by the private local worker. */
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_ANALYSIS_MODEL = 'gemini-3.8-flash';
export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const GEMINI_REQUEST_BYTES = 20_000_000;
const RESPONSE_BYTES = 40_000_000;
const IMAGE_BYTES = 25_000_000;
const INPUT_PIXELS = 150_000_000;
const OUTPUT_PIXELS = 20_000_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

type ErrorCode = 'SERVER_ONLY' | 'INVALID_ARGUMENT' | 'REQUEST_TOO_LARGE' | 'INVALID_INPUT_IMAGE' |
  'ABORTED' | 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'RESPONSE_TOO_LARGE' | 'INVALID_RESPONSE' |
  'INCOMPLETE_RESPONSE' | 'SCHEMA_MISMATCH' | 'INVALID_OUTPUT_IMAGE';

/** Contains only enumerated diagnostics. Never retain a provider body, secret, prompt or cause. */
export class GeminiTransportError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  constructor(code: ErrorCode, status?: number) {
    super(`GEMINI_${code}${status === undefined ? '' : `_${status}`}`);
    this.name = 'GeminiTransportError';
    this.code = code;
    this.status = status;
  }
}

export type GeminiImageInput = {
  /** Stable scene or reference ID, included beside this image; duplicate IDs are rejected. */
  id: string;
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
};
export type GeminiSourceEvidence = {id: string; sha256: string};
export type GeminiSchema<T> = z.ZodType<T> | {
  jsonSchema: Record<string, unknown>;
  /** Required because the provider's schema guarantee is not a substitute for local validation. */
  parse: (value: unknown) => T;
};
export type GeminiCallOptions = {
  apiKey: string | Uint8Array;
  prompt: string;
  images?: readonly GeminiImageInput[];
  model?: string;
  signal?: AbortSignal;
  /** One deadline covering preparation, retries, streamed response and decode. Maximum 5 minutes. */
  timeoutMs?: number;
  /** Retries only explicit HTTP 429/5xx, never ambiguous network failures. Maximum two. */
  maxRetries?: number;
};
export type GeminiJsonOptions<T> = GeminiCallOptions & {schema: GeminiSchema<T>; maxOutputTokens?: number};
export type GeminiImageOptions = GeminiCallOptions & {
  imageSize?: '512' | '1K' | '2K' | '4K';
  aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | '1:8' | '8:1' | '1:4' | '4:1';
  includeText?: boolean;
};
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type CallContext = {signal: AbortSignal; check: () => void; remainingMs: () => number};
type Prepared = {input: unknown[]; sources: GeminiSourceEvidence[]};

function fail(code: ErrorCode): never {throw new GeminiTransportError(code);}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, fallback: number, low: number, high: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) fail('INVALID_ARGUMENT');
  return value;
}
function model(value: string | undefined, fallback: string) {
  const chosen = value ?? fallback;
  if (!/^gemini-[a-z0-9][a-z0-9.-]{1,90}$/.test(chosen)) fail('INVALID_ARGUMENT');
  return chosen;
}

async function bounded<T>(options: GeminiCallOptions, task: (ctx: CallContext) => Promise<T>): Promise<T> {
  if (typeof window !== 'undefined') fail('SERVER_ONLY');
  const timeoutMs = integer(options.timeoutMs, 180_000, 1, MAX_TIMEOUT_MS);
  const startedAt = performance.now();
  const timerController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timerController.signal]) : timerController.signal;
  const check = () => {
    if (options.signal?.aborted) fail('ABORTED');
    if (timerController.signal.aborted) fail('TIMEOUT');
  };
  const timer = setTimeout(() => timerController.abort(), timeoutMs);
  let abort: (() => void) | undefined;
  try {
    check();
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new GeminiTransportError(options.signal?.aborted ? 'ABORTED' : 'TIMEOUT'));
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
    });
    // Native fetch observes the same signal. The race also bounds a slow codec or
    // injected transport that cannot cancel; later stages still check the signal.
    const result = await Promise.race([task({signal, check, remainingMs: () => Math.max(0, timeoutMs - (performance.now() - startedAt))}), aborted]);
    check();
    return result;
  } catch (error) {
    check();
    if (error instanceof GeminiTransportError) throw error;
    // Never surface messages from fetch, codecs, schemas or an AbortSignal.reason.
    return fail('INVALID_RESPONSE');
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function prepare(options: GeminiCallOptions, ctx: CallContext): Promise<Prepared> {
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) fail('INVALID_ARGUMENT');
  const images = options.images ?? [];
  if (!Array.isArray(images) || images.length > 1000) fail('INVALID_ARGUMENT');
  // Conservative lower bound avoids encoding or decoding an obviously oversized request.
  let approximateBytes = Buffer.byteLength(options.prompt, 'utf8');
  const ids = new Set<string>();
  for (const image of images) {
    if (!image || typeof image.id !== 'string' || !/^[\w.:-]{1,160}$/.test(image.id) || ids.has(image.id) ||
        !(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0 ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) fail('INVALID_ARGUMENT');
    ids.add(image.id);
    approximateBytes += 4 * Math.ceil(image.bytes.byteLength / 3);
    if (approximateBytes > GEMINI_REQUEST_BYTES) fail('REQUEST_TOO_LARGE');
  }
  if (approximateBytes > GEMINI_REQUEST_BYTES) fail('REQUEST_TOO_LARGE');
  const input: unknown[] = [{type: 'text', text: options.prompt}];
  const sources: GeminiSourceEvidence[] = [];
  for (const image of images) {
    ctx.check();
    // Snapshot callers' mutable buffers before asynchronous work. No resizing or dropped images.
    const bytes = Buffer.from(image.bytes);
    try {
      const decoder = sharp(bytes, {limitInputPixels: INPUT_PIXELS, failOn: 'warning'});
      const meta = await decoder.metadata();
      if (`image/${meta.format}` !== image.mimeType || !meta.width || !meta.height || (meta.pages ?? 1) !== 1) fail('INVALID_INPUT_IMAGE');
      // Reading headers alone accepts valid-looking files with truncated pixels.
      // Statistics force a full decode without allocating an uncompressed output
      // buffer or changing the exact original bytes submitted below.
      await decoder.stats();
    } catch { fail('INVALID_INPUT_IMAGE'); }
    ctx.check();
    input.push({type: 'text', text: `Image ID: ${image.id}`});
    input.push({type: 'image', mime_type: image.mimeType, data: bytes.toString('base64')});
    sources.push({id: image.id, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  return {input, sources};
}

async function wait(delay: number, ctx: CallContext) {
  ctx.check();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {ctx.signal.removeEventListener('abort', abort); resolve();}, delay);
    const abort = () => {clearTimeout(timer); reject(new GeminiTransportError('ABORTED'));};
    ctx.signal.addEventListener('abort', abort, {once: true});
    if (ctx.signal.aborted) abort();
  });
  ctx.check();
}
function retryDelay(response: Response, attempt: number) {
  const value = response.headers.get('retry-after');
  const seconds = value === null ? NaN : Number(value);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : NaN;
  return Math.max(250, Number.isFinite(requested) ? requested : 500 * 2 ** attempt);
}

async function readResponse(response: Response, ctx: CallContext) {
  if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    fail('RESPONSE_TOO_LARGE');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    await response.body?.cancel().catch(() => {});
    fail('INVALID_RESPONSE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  ctx.signal.addEventListener('abort', abort, {once: true});
  try {
    while (true) {
      ctx.check();
      const {done, value} = await reader.read();
      ctx.check();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    let parsed: unknown;
    try {parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));} catch {fail('INVALID_RESPONSE');}
    if (!record(parsed)) fail('INVALID_RESPONSE');
    return parsed;
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function outputs(response: Record<string, unknown>) {
  if (response.status !== 'completed') fail('INCOMPLETE_RESPONSE');
  if (!Array.isArray(response.steps)) fail('INVALID_RESPONSE');
  // Do not mistake thought summaries, echoed inputs or tool messages for final output.
  const parts = response.steps.filter(step => record(step) && step.type === 'model_output')
    .flatMap(step => Array.isArray(step.content) ? step.content : []);
  if (!parts.length || parts.some(part => !record(part))) fail('INVALID_RESPONSE');
  return parts as Record<string, unknown>[];
}

async function send(body: Record<string, unknown>, options: GeminiCallOptions, ctx: CallContext, fetcher: Fetch) {
  const maxRetries = integer(options.maxRetries, 1, 0, MAX_RETRIES);
  let key: string;
  if (typeof options.apiKey === 'string') key = options.apiKey;
  else if (options.apiKey instanceof Uint8Array) key = Buffer.from(options.apiKey).toString('utf8');
  else fail('INVALID_ARGUMENT');
  if (!/^[\x21-\x7e]{8,8192}$/.test(key)) fail('INVALID_ARGUMENT');
  let serialized: string;
  try {serialized = JSON.stringify({...body, store: false, stream: false, background: false});}
  catch {fail('INVALID_ARGUMENT');}
  if (Buffer.byteLength(serialized, 'utf8') > GEMINI_REQUEST_BYTES) fail('REQUEST_TOO_LARGE');
  for (let attempt = 0; ; attempt++) {
    ctx.check();
    let response: Response;
    try {
      response = await fetcher(GEMINI_ENDPOINT, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: ctx.signal,
        headers: {'content-type': 'application/json', 'x-goog-api-key': key}, body: serialized,
      });
    } catch {ctx.check(); fail('NETWORK');}
    ctx.check();
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      await response.body?.cancel().catch(() => {});
      if (attempt < maxRetries) {
        const delay = retryDelay(response, attempt);
        // Do not shorten a provider's cooldown and immediately repeat a paid call.
        // The caller may reschedule this status under its separate queue policy.
        if (delay >= ctx.remainingMs()) throw new GeminiTransportError('HTTP', response.status);
        await wait(delay, ctx);
        continue;
      }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GeminiTransportError('HTTP', response.status);
    }
    return outputs(await readResponse(response, ctx));
  }
}

function schemaParts<T>(schema: GeminiSchema<T>) {
  try {
    if (schema instanceof z.ZodType) {
      return {jsonSchema: z.toJSONSchema(schema), parse: (value: unknown) => schema.parse(value)};
    }
    if (!record(schema) || !record(schema.jsonSchema) || typeof schema.parse !== 'function') fail('INVALID_ARGUMENT');
    return schema;
  } catch {fail('INVALID_ARGUMENT');}
}

/** Dependency injection is for mock tests; production callers should use the exported functions. */
export function createGeminiTransport(fetcher: Fetch = (url, init) => fetch(url, init)) {
  return {
    async structuredJson<T>(options: GeminiJsonOptions<T>): Promise<{data: T; sources: GeminiSourceEvidence[]}> {
      return bounded(options, async ctx => {
        const chosenModel = model(options.model, GEMINI_ANALYSIS_MODEL);
        const schema = schemaParts(options.schema);
        const prepared = await prepare(options, ctx);
        const parts = await send({
          model: chosenModel, input: prepared.input,
          response_format: {type: 'text', mime_type: 'application/json', schema: schema.jsonSchema},
          generation_config: {max_output_tokens: integer(options.maxOutputTokens, 16384, 1, 65536)},
        }, options, ctx, fetcher);
        if (parts.some(part => part.type !== 'text' || typeof part.text !== 'string')) fail('INVALID_RESPONSE');
        let data: T;
        try {data = schema.parse(JSON.parse(parts.map(part => part.text).join('')));} catch {fail('SCHEMA_MISMATCH');}
        ctx.check();
        return {data, sources: prepared.sources};
      });
    },
    async generateImage(options: GeminiImageOptions): Promise<{png: Buffer; width: number; height: number; text: string; sources: GeminiSourceEvidence[]}> {
      return bounded(options, async ctx => {
        const chosenModel = model(options.model, GEMINI_IMAGE_MODEL);
        const sizes = ['512', '1K', '2K', '4K'];
        const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:8', '8:1', '1:4', '4:1'];
        if ((options.imageSize && !sizes.includes(options.imageSize)) ||
            (options.aspectRatio && !ratios.includes(options.aspectRatio)) ||
            (options.includeText !== undefined && typeof options.includeText !== 'boolean')) fail('INVALID_ARGUMENT');
        const prepared = await prepare(options, ctx);
        // ImageResponseFormat currently documents JPEG as the only explicit MIME override.
        // Omit it and safely decode the returned PNG/JPEG/WebP to a canonical PNG ourselves.
        const format = {type: 'image', delivery: 'inline', image_size: options.imageSize ?? '2K',
          ...(options.aspectRatio ? {aspect_ratio: options.aspectRatio} : {})};
        const parts = await send({model: chosenModel, input: prepared.input,
          response_format: options.includeText ? [{type: 'text'}, format] : format}, options, ctx, fetcher);
        if (parts.some(part => part.type !== 'text' && part.type !== 'image')) fail('INVALID_RESPONSE');
        const images = parts.filter(part => part.type === 'image');
        // Never silently choose among several potentially contradictory plans.
        if (images.length !== 1) fail('INVALID_OUTPUT_IMAGE');
        const image = images[0];
        if (typeof image.data !== 'string' || !image.data.length || image.data.length > Math.ceil(IMAGE_BYTES / 3) * 4 ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(String(image.mime_type))) fail('INVALID_OUTPUT_IMAGE');
        const bytes = Buffer.from(image.data, 'base64');
        if (!bytes.length || bytes.byteLength > IMAGE_BYTES || bytes.toString('base64') !== image.data) fail('INVALID_OUTPUT_IMAGE');
        let png: Buffer;
        let width: number;
        let height: number;
        try {
          const decoder = sharp(bytes, {limitInputPixels: OUTPUT_PIXELS, failOn: 'warning'});
          const meta = await decoder.metadata();
          if (`image/${meta.format}` !== image.mime_type || !meta.width || !meta.height || (meta.pages ?? 1) !== 1) fail('INVALID_OUTPUT_IMAGE');
          width = meta.width;
          height = meta.height;
          // Full decode catches corrupt/truncated pixels; fresh PNG drops untrusted metadata.
          png = await decoder.png().toBuffer();
          if (png.length > IMAGE_BYTES) fail('INVALID_OUTPUT_IMAGE');
        } catch {fail('INVALID_OUTPUT_IMAGE');}
        ctx.check();
        const textParts = parts.filter(part => part.type === 'text');
        if (textParts.some(part => typeof part.text !== 'string')) fail('INVALID_RESPONSE');
        return {png, width, height, text: textParts.map(part => part.text).join(''), sources: prepared.sources};
      });
    },
  };
}

const transport = createGeminiTransport();
export const geminiStructuredJson = transport.structuredJson;
export const geminiGenerateImage = transport.generateImage;
