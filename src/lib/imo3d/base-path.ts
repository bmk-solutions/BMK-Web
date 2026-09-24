/**
 * The BMK studio suite serves this app at os.bmk.solutions/media-support/tour (next.config
 * `basePath`). Browser code and emitted links must carry that prefix; `next/link` adds it on
 * its own, `fetch`, `<a href>`, `<img src>`, iframes and `window.location` do not.
 *
 * Stored tour payloads keep their canonical form (`/api/imo3d/assets/<id>`) in the database
 * and in every server-side check. Responses apply the prefix on the way out
 * (`servePayloadPaths`) and the few inputs that carry a stored path strip it on the way in
 * (`storedAssetPath`), so production rows are never rewritten.
 *
 * Isomorphic: no Node or browser APIs.
 */
export const IMO3D_BASE_PATH = '/media-support/tour';

const storedPath = /^\/(?:api\/imo3d|imo3d\/example)\/[^\s"'<>\\]*$/;

export function hasBasePath(path: string) {
  return path === IMO3D_BASE_PATH || path.startsWith(IMO3D_BASE_PATH + '/') || path.startsWith(IMO3D_BASE_PATH + '?');
}

/** A path inside this app as the browser must request it. URLs and prefixed paths pass through unchanged. */
export function withBasePath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || hasBasePath(path)) return path;
  return path === '/' ? IMO3D_BASE_PATH : IMO3D_BASE_PATH + path;
}

/** The app-relative path of a request path that may or may not carry the prefix. */
export function withoutBasePath(path: string) {
  if (!hasBasePath(path)) return path;
  const rest = path.slice(IMO3D_BASE_PATH.length);
  return rest.startsWith('/') ? rest : '/' + rest;
}

/**
 * The suite's login page as a RELATIVE location (the suite serves it on the same host as this
 * app's pages). `next` must stay inside this app; anything else returns to the studio home.
 */
export function suiteLoginPath(next: string) {
  const inside = hasBasePath(next) && !next.startsWith('//') && !/[\\\s]/.test(next);
  return '/media-support/login?next=' + encodeURIComponent(inside ? next : IMO3D_BASE_PATH);
}

/** A stored asset path as served to the browser. Anything else is returned unchanged. */
export function servedAssetPath(value: string) {
  return storedPath.test(value) ? IMO3D_BASE_PATH + value : value;
}

/** The canonical stored form of a served asset path. Anything else is returned unchanged. */
export function storedAssetPath(value: string) {
  if (!value.startsWith(IMO3D_BASE_PATH + '/')) return value;
  const rest = value.slice(IMO3D_BASE_PATH.length);
  return storedPath.test(rest) ? rest : value;
}

/** Deep copy of a JSON payload with every stored asset path (values and object keys) served under the basePath. */
export function servePayloadPaths<T>(value: T): T {
  return mapPaths(value) as T;
}

function mapPaths(value: unknown): unknown {
  if (typeof value === 'string') return servedAssetPath(value);
  if (Array.isArray(value)) return value.map(mapPaths);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result: Record<string, unknown> = {};
  // defineProperty keeps an own "__proto__" key a plain property, as JSON.parse produced it.
  for (const [key, item] of Object.entries(value)) Object.defineProperty(result, servedAssetPath(key), {value: mapPaths(item), enumerable: true, writable: true, configurable: true});
  return result;
}
