# Gemini plan processing

`src/lib/imo3d/gemini-transport.ts` is a Node/server module. The local subscription-plan worker now injects `createGeminiPlanProvider` for plan evidence analysis, geometry synthesis, furnished image generation, metadata review and independent image audit. The separate photo-edit workflow keeps its existing provider. Secrets are read through the private Windows credential callback, never sent to the browser or committed.

## Interface

- `geminiStructuredJson({apiKey, prompt, images, schema, signal, ...})` returns `{data, sources}`. Supply a Zod schema, or `{jsonSchema, parse}` with a required local validator. The installed Zod version has no `fromJSONSchema`; a raw schema is never accepted without local validation.
- `geminiGenerateImage({apiKey, prompt, images, signal, imageSize, aspectRatio, includeText, ...})` returns `{png, width, height, text, sources}`. Omit images for generation; provide the original/reference images for editing. The result is still an unapproved draft, not evidence of geometric accuracy.
- Each image is `{id, bytes, mimeType}`; supported input formats are PNG, JPEG and WebP. `sources` binds the exact submitted bytes to IDs using SHA-256. All supplied images stay in order; duplicate IDs and oversized requests fail explicitly. There is no implicit resizing, selection, batching or remote image download.
- `apiKey` accepts a string or private `Uint8Array`. The local credential utility can pass its buffer inside `withLocalCredential('gemini-api-key', async secret => ...)`. Never store or return that argument. JavaScript/HTTP headers necessarily contain a transient string, so buffer zeroing cannot guarantee erasure of every runtime copy.

Defaults are `gemini-3.8-flash` for analysis and `gemini-3.1-flash-image` for images; `model` can override them without changing the host or path. These IDs and request fields were checked against Google's current model documentation on 2026-09-22. [Analysis model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [image model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image).

On 2026-09-22, the separate credential utility successfully authenticated a read-only `GET models` request and found both configured model IDs in the complete model list. That check sent no photographs and generated no content. It verifies authentication and advertised model availability only; generation permission, quotas, billing, real-call latency and output quality remain untested.

The transport uses `POST https://generativelanguage.googleapis.com/v1beta/interactions`, an API-key header, synchronous non-streaming output and `store:false`. It rejects redirects and never uses a query-string secret. Final content comes only from completed `model_output` steps. Errors expose fixed codes and numeric HTTP status, never response bodies, prompts, headers or nested errors. Disabling interaction storage is not a claim about all provider data retention. [Interactions API](https://ai.google.dev/api/interactions-api).

Structured output uses `response_format` with `application/json` and the supplied schema, followed by local validation. An incomplete or malformed response is rejected. [Structured output](https://ai.google.dev/gemini-api/docs/structured-output).

The request limit is a conservative 20,000,000 UTF-8 bytes including base64 images, prompt and schema. Larger inputs need an explicit future batching/Files API design that accounts for every original photo; this transport fails instead of dropping photos. [Image inputs](https://ai.google.dev/gemini-api/docs/image-understanding).

Image output can request image-only or text plus image. The current image format schema documents JPEG as the explicit MIME override; the transport leaves that option unset, validates returned PNG/JPEG/WebP bytes, fully decodes a single image and produces a fresh PNG. It rejects output URLs, multiple images, corrupt pixels, animation, MIME mismatches and excessive dimensions. [Image generation and editing](https://ai.google.dev/gemini-api/docs/image-generation).

## Limits and cancellation

The overall deadline defaults to 180 seconds and is capped at 300 seconds. Retry count defaults to one and is capped at two; only explicit HTTP 429 or 5xx is retried, with abortable backoff. A valid `Retry-After` is never shortened. If its delay cannot fit inside the remaining deadline, the original sanitized HTTP failure is returned without another call. HTTP errors may still have incurred provider work. Ambiguous network errors and timeouts are not retried automatically. Request cancellation stops local waiting/network work; it cannot guarantee a provider refunds or stops computation already accepted.

Responses are capped at 40 MB while streaming, image bytes at 25 MB, decoded output at 20 million pixels. Original panoramas permit up to 150 million pixels and undergo full pixel decoding before any request; the submitted bytes remain unchanged. No return from this module should bypass existing photo coverage, floor/room validation, geometry, source freshness, image audit, lease or draft-approval gates in the worker.

## Verification

Run `node scripts/test-imo3d-gemini.mjs`. Tests inject fetch and use generated synthetic fixtures only: all-photo coverage, secret handling, schema validation, deadlines, cancellation, bounded retry/size handling and image decode. They do not verify account access, live latency, billing, model quality or apartment geometry.

## Activation verification — 2026-09-22

The masked credential is configured and decryptable, and the read-only model listing succeeded. Actual tiny text generation returned HTTP 503 for gemini-3.8-flash; a supported image model request returned HTTP 429 with an explicit quota limit of 0. Therefore successful image generation, final plan quality and live generation latency have **not** been verified. Google account quota/billing must be made available before a furnished plan can succeed. No image was published or old plan overwritten. A manually cancelled plan job was not restarted.

All new plan jobs use Gemini on this processing computer. Source photo evidence and validated geometry checkpoints remain reusable; generated-image checkpoints are namespaced by provider to prevent claiming a previous provider's image as a new Gemini rendering. Every original photo remains accounted for. Apartment-wide review copies may be resized explicitly to fit the request limit after per-photo evidence passes; no source is silently removed. Outputs remain private review drafts behind the original completeness, freshness, cancellation, independent audit and publication gates.

The UI shows Gemini and reports quota/service failures with actionable messages. The key does not need to be copied to Vercel, Supabase or other visitor devices. The processing computer must remain online.

### Final device mode

The user explicitly chose manual operation instead of a persistent scheduled-task ExecutionPolicy Bypass. The existing plans scheduled task was restored to its original PowerShell action and disabled; photo-processing tasks were not changed. The manually launched plan supervisor successfully loads the encrypted credential and its Supabase heartbeat is online. Worker startup now provides a non-network `--check-credentials` mode and only sanitized failure diagnostics. No machine-wide execution policy changed.

Production deployment `dpl_B4ESGLoRaJXG5PbHLY8Dbi415njB` reached READY and aliases `https://bmk-imo3d.vercel.app`. Gemini/provider tests:30; quality/recovery:46; cloud routes:80; private credential loader:4. TypeScript, scoped lint and production build passed. Actual Gemini drawing remains unverified because the account's image quota is0.
