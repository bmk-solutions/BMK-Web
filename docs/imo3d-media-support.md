# IMO3D inside the BMK studio suite (`/media-support/tour`)

Owner decision, 2026-09-24: the 360 tour program joins the studio suite at
`https://os.bmk.solutions/media-support/tour`, on the suite's login, with its engines on the
owner's PC. This deployment (Vercel project `bmk-imo3d`) keeps serving it; the suite's zone
forwards `/media-support/tour/*` here. Branch `claude/media-support-tour`.

## Never merge this branch into `main`

`main` is the marketing site www.bmk.solutions, which Hostinger builds with `npm run build`. This
branch puts every page under `/media-support/tour`, so on that host `/`, `/about`, `/services` … would
all answer 404. `next.config.ts` therefore refuses a production build unless it runs on Vercel
(`VERCEL=1`, set by Vercel's builds and by `vercel build`) or is opted in locally with
`IMO3D_SUITE_BUILD=1`; anywhere else the build stops and the live site keeps its previous build.
A local verification build: `$env:IMO3D_SUITE_BUILD='1'; npm run build`.

## Addresses

| What | New address (through the suite) | Old address on `bmk-imo3d.vercel.app` |
|---|---|---|
| Studio (admin) | `/media-support/tour` | `/imo3d` → 307 to the new path |
| Published tour (public) | `/media-support/tour/t/<id>` | `/imo3d/t/<id>` → 307, query kept (`?embed=1`, `?scene=`) |
| API guide (public) | `/media-support/tour/imo3d/api` | `/imo3d/api` → 307 |
| ChatGPT consent page | `/media-support/tour/imo3d/connect-chatgpt` | `/imo3d/connect-chatgpt` → 307 (query kept) |
| API | `/media-support/tour/api/imo3d/...` | `/api/imo3d/...` answers unchanged (proxied) |
| Assets | `/media-support/tour/api/imo3d/assets/<id>` | `/api/imo3d/assets/<id>` → 307 |
| ChatGPT MCP + OAuth | unchanged: `https://bmk-imo3d.vercel.app/api/imo3d-chatgpt/*`, `/.well-known/oauth-*` | answered at the old paths (proxied) |

- **Why `/t/<id>`:** it is the address people share, so it is the short one. The long form inside
  the basePath (`/media-support/tour/imo3d/t/<id>`) redirects to it. The page file stays at
  `src/app/imo3d/t/[id]` and is reached through a `beforeFiles` rewrite, so no route moved.
- **Old links use 307, not 308.** Browsers cache a 308 forever; a 307 keeps the cutover reversible.
- **Why the old API and the ChatGPT endpoints are proxied, not redirected.** Next allows a rewrite
  outside the basePath only to an absolute URL, so `next.config.ts` rewrites them to this same
  deployment (`IMO3D_APP_ORIGIN`, default `https://bmk-imo3d.vercel.app`). OAuth clients and
  API-key scripts get the same answer at the same URL; nothing follows a redirect. The OAuth
  metadata (issuer, endpoints, resource) is byte-identical, so the owner's existing ChatGPT
  connection keeps working. Vercel serves an external rewrite at its CDN (no function in between),
  so each old-path call still runs one function.
- **A Vercel preview proxies the old paths to itself** (`https://$VERCEL_URL`, behind its deployment
  protection), never to production, even when `IMO3D_APP_ORIGIN` is set for every environment. A
  production build uses the public alias: its deployment URLs are protected.

## Stored paths are mapped at read time

Tour payloads in Supabase hold `/api/imo3d/assets/<id>` (and `/imo3d/example/...` in local mode).
Production rows are **not** rewritten:

- every JSON response serves those paths under the basePath (`servePayloadPaths` in
  `src/lib/imo3d/base-path.ts`, applied in `cloud/http.ts` and the local routes' JSON helpers),
  including the keys of the signed-media map, so the viewer still pairs each scene with its URL;
- the only write that carries a stored path (hotspot media) is stored canonical again
  (`hotspotUrl` → `storedAssetPath`);
- URL-shape checks (surface/mesh models, plan images) test the canonical form.

## Login

- Pages `/` (studio) and `/imo3d/connect-chatgpt` are gated in `src/proxy.ts`. The browser's suite
  cookie `ms_session` (Path=/media-support) is forwarded to
  `${MS_ZONE_ORIGIN}/media-support/api/_ms/session`; 200 `{ok,uid,email}` opens the page, a positive
  answer is cached ≤ 60 s per token. Otherwise 307 to the RELATIVE
  `/media-support/login?next=<path>`. The app never holds the suite's secret.
- The API accepts the same suite session as the administrator (`cloudIsAdmin` / `isAdmin`), plus the
  integrations' own mechanisms: project API keys and ChatGPT tokens. Without any of them admin
  endpoints answer 401 JSON.
- **The old IMO3D password login is closed.** `POST /api/imo3d/session` answers 403 without checking
  the password, and an `imo3d_session` cookie opens nothing, so the suite's logout really ends the
  owner's access. `IMO3D_PASSWORD_LOGIN=1` reopens it as a break-glass while the suite's login is
  down (its cookie is scoped to `Path=/media-support/tour`); the studio's «تغيير كلمة مرور الإدارة»
  still rotates that break-glass password.
- The studio (`/`) and the ChatGPT consent page answer `Cache-Control: private, no-store`, so no
  shared cache (the zone's CDN caches external rewrites) keeps a signed-in page.
- Writes from `MS_SUITE_ORIGIN` (default `https://os.bmk.solutions`) and the zone's own origin count
  as same-origin.
- On the old host a signed-out visitor reaches `/media-support/login`, which redirects to the suite's
  login.

## Embeds

`os.bmk.solutions` sends `X-Frame-Options: SAMEORIGIN`, so an embed code always frames this app's
own host: `embedTourURL()` in `src/lib/imo3d/suite.ts` returns
`${IMO3D_APP_ORIGIN}/media-support/tour/t/<id>` and ignores `IMO3D_PUBLIC_ORIGIN`. Old client
embeds (`/imo3d/t/<id>`) redirect on the same host and stay frameable.

## Settings (server only, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `MS_ZONE_ORIGIN` | `https://bmk-media-support.vercel.app` | Where the suite session is checked (https, or http on loopback for tests) |
| `MS_SUITE_ORIGIN` | `https://os.bmk.solutions` | Suite login target on the old host; trusted browser origin |
| `IMO3D_APP_ORIGIN` | `https://bmk-imo3d.vercel.app` | This deployment's host: embeds and the build-time rewrites of the old paths (a preview uses its own `VERCEL_URL`) |
| `IMO3D_PASSWORD_LOGIN` | unset (closed) | `1` reopens the old password login: break-glass only |
| `IMO3D_SUITE_BUILD` | unset | `1` allows a local `next build`; Vercel builds need nothing |

`IMO3D_APP_ORIGIN`, `MS_SUITE_ORIGIN` and `IMO3D_SUITE_BUILD` are read by `next.config.ts` at **build** time.
Never set `IMO3D_PUBLIC_ORIGIN` to the suite: it is the ChatGPT OAuth issuer.

## What the suite's zone must do (lead)

- `next.config`: `/media-support/tour/:path*` → `https://bmk-imo3d.vercel.app/media-support/tour/:path*`
  (and `/media-support/tour` itself), and let the prefix through its middleware untouched.
- Serve `GET /media-support/api/_ms/session` → 200 `{ok:true, uid, email}` or 401.

## Rollback

Redeploy the previous production build (`017934b`). No data changed, so nothing else is needed.

## Tests

`tests/imo3d-suite-basepath.test.ts` (in `npm run test:imo3d`): basePath helpers, read-time mapping,
hotspot write-back, the login location, the suite session against a fake zone, the proxy gate, every
old-path redirect and kept rewrite, the CDN header rule, the no-store rule on the gated pages, the
build guard, the preview self-proxy, the local-mode gate and embeds.
`tests/imo3d-cloud-routes.test.ts`: the suite session on the API, the closed password login (and its
break-glass switch), basePath API paths, suite-origin writes, embeds when the public origin is the
suite, and the cookie scope.

## The buyer's tour (2026-09-25)

| What | Where | Cache |
|---|---|---|
| Arrival payload without display depth; `deferredDepth` lists the scenes that have it | `GET /api/imo3d/tours/<id>` (anonymous) | `private, no-store` (it carries signed media URLs) |
| One scene's display depth, fetched with its panorama | `GET /api/imo3d/tours/<id>/depth/<sceneId>?r=<revision>` | published: `public, max-age=300, s-maxage=86400` |
| Plan image as WebP / ≤600 px mini (the stored PNG is untouched and still opens «بالحجم الكامل») | `GET …/ai-plan/image?job=&floor=&variant=webp\|mini` | published: `public, max-age=3600, s-maxage=86400` |
| Link-preview picture: first scene, 1200×630 JPEG | `GET /api/imo3d/tours/<id>/og-image?r=<revision>` | published: `public, max-age=3600, s-maxage=86400` |
| Share card (title, description, image, the developer's name) | `generateMetadata` in `src/app/imo3d/t/[id]/page.tsx` | server-rendered per request; neutral Arabic card when not published |

- «سجّل اهتمامك» sits in the dock on every screen size; the old footer stays hidden.
- The logo and the error page link to the studio only for a signed-in administrator (`GET session`).
- A reviewed architectural plan opens first («المخطط النظيف»); the furnished image is «المخطط المؤثث».
- Light/dark: `data-imo-theme` on `<html>` from the suite's own `bmk-theme` key, before the first paint
  (`src/lib/imo3d/theme.ts`); toggles in the studio sidebar and the viewer's options. The panorama keeps its
  dark frame; the viewer's dock, dialogs and plan panels follow the theme (`src/app/imo3d/imo3d-theme.css`).

## «سجّل اهتمامك» goes to VERA and Developer OS (2026-09-25)

The buyer's request is no longer kept here. `POST /api/imo3d/leads` forwards it, signed, to VERA
(bmk-spatial under `/imo3d`), which routes it to the linked Developer OS project, the linked developer,
or BMK's own inbox (unlinked). Code: `src/lib/imo3d/vera-integration.ts` (signer, requests, context cache),
`src/lib/imo3d/tour-lead.ts` (accept → limits → forward → masked audit), `src/lib/imo3d/tour-interest.ts`
(what the buyer's page shows), `src/lib/imo3d/cloud/vera-links.ts` (the studio's link selects).

| Variable (Production only) | Purpose |
|---|---|
| `VERA_INTEGRATION_SECRET` | VERA's «tour360» secret (≥ 32 random bytes; the same value as bmk-spatial `VERA_INTEGRATION_SECRET_TOUR360`). Unset = feature off: no button, a request answers 503 |
| `VERA_INTEGRATION_ORIGIN` | bmk-spatial's own production origin (not os.bmk.solutions); `/imo3d` is added by the code |

- Signature: headers `x-vera-app: tour360`, `x-vera-ts` (Unix **seconds**), `x-vera-nonce` (16 random
  bytes, base64url), `x-vera-signature: v1=<base64url HMAC-SHA256(secret, canonical)>`, canonical =
  `vera-int-v1\n<app>\n<ts>\n<nonce>\n<METHOD>\n<path after /imo3d>?<query as sent>\n<base64url sha256(raw body)>`.
  Fixed vectors: `tests/imo3d-vera-federation.test.ts` (VERA-SIG) carries bmk-spatial's four contract vectors
  verbatim (`tests/unit/integration-signature.test.mjs` there), so the two signers are one function.
  A Vercel preview never forwards (`VERCEL_ENV` other than `production` turns the feature off).
- The lead body carries the tour's own ids (`ref.project` = tour project, `ref.developer` = its tour developer read
  on the server, `ref.item` = tour), `unit.code`, consent `vera-consent-2026-09-25`, the public URL and
  `client.ipHash` (HMAC of the IP; VERA never sees the address). VERA normalises the phone; the tour checks it
  first with VERA's own rule (`lead-validation.ts`: Saudi shorthand → `+9665XXXXXXXX`, anything else `+`/`00` and
  E.164) and refuses in VERA's words, so one Saudi number has one form and one per-phone key.
- `GET /api/imo3d/tours/<id>` adds `interest: {enabled, developerName, projectName, whatsapp, unitOffMarket, unitStatus,
  privacyUrl, beacon}` from VERA's context (`GET /api/integrations/v1/context?project=&developer=&unit=`, cached 60 s,
  failures too). When VERA cannot answer, the last good context stands in for up to a day (stale-if-error), so a
  linked developer keeps his name in the consent and his WhatsApp button through an outage. The consent names the
  Developer OS project when a project link files the lead under it. A sold/reserved unit hides the button, shows
  «مباعة / محجوزة» under the price and offers the developer's WhatsApp where the button was (no calculator); the
  WhatsApp button counts `wa_click`. Beacons (`tour_view`, `wa_click`, `mortgage_use`) go to
  `/imo3d/api/events` only when the page is on the suite's origin, with ids only.
- Edge protection: honeypot → silent 201; per-IP 10 / 10 min and 30 / h; per-phone-per-tour 3 / h; per-tour 100 / h.
  Every key is a keyed hash, never an address or a number; without VERA the cloud answers 503 before any key is
  written. The per-phone and per-tour limits count only requests VERA accepted: a failed forward gives them back
  (`imo3d_rate_limit_refund`), so a buyer who retried through an outage is never told «أُرسل سابقًا».
- `imo3d_leads` is a masked audit (`05••••123`, tour, time, `forwarded_at`, `vera_routed`), written only after VERA
  holds the lead: `supabase/migrations/20260925120000_imo3d_lead_audit.sql` drops `name` and `note`, refuses a full
  number, deletes the old code's raw-number limit keys (`lead:+966…:<tour>`) and adds `imo3d_rate_limit_refund`.
  **Written, not applied** — apply it before (or with) the deploy of this code.
- Studio: «ربط بمشروع في Developer OS» in the project dialog, «ربط بمطوّر في Developer OS» in the developer dialog,
  the chip «غير مربوط — الطلبات تذهب إلى صندوق BMK» when requests fall back. Publishing or unpublishing re-states a
  linked project's URL in VERA's registry (best effort; the tour is saved either way). VERA's context names the linked
  developer and project without ids, so the tour finds the ids by exact name in VERA's catalogue; two entries with one
  name resolve to nothing (no write). A tour developer's own link is read with the probe project `developer-link:<id>`.
- The local SQLite adapter forwards the same way only when the secret is set; without it, it keeps its old behaviour.
