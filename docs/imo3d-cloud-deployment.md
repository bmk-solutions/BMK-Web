# IMO 3D cloud deployment

Status: the Supabase database/storage adapter and local reconstruction worker queue are implemented. Deployment verification must cover data integrity, authorization, uploads and worker processing; a successful build alone does not certify them.

Work is limited to the authorized `bmk-solutions/BMK-Web` repository. Create a
separate Supabase project and a separate Vercel project for this application.
Do not reuse, modify, reset, delete, or merge data in existing cloud projects.
Use a new Git branch for deployment preparation so existing production
integrations are not triggered before the new deployment is verified.

## Required architecture

| Component | Responsibility |
| --- | --- |
| Vercel | Next.js interface, authenticated API, authorization and small requests |
| New Supabase database | Developers, projects, tours, revisions, leads, asset metadata, branding and durable processing jobs |
| New private Supabase storage | Unchanged original photos, viewing variants, approved plan images and processing artifacts |
| Local worker | Image validation/derivatives and long Node/Python reconstruction jobs, claimed from the queue using outbound connections |

The local worker needs the configured Python runtime and models, the new
project's scoped credentials, temporary private storage, and a running
computer. The public viewer must not depend on that computer once its media
has been uploaded. New reconstruction remains queued while the worker is
offline; show that state honestly. Do not expose the desktop development server
to the internet. An OpenAI generation job additionally requires a valid API
key; deploying the application does not provide one.

The current SQLite access is synchronous and spread across API/shared modules.
Introduce an asynchronous repository for Supabase/Postgres. Preserve atomic
revision checks, multi-record transactions, cancellation and job leases; use
transactional SQL functions where necessary. Do not emulate persistence by
copying a mutable SQLite file into each Vercel function's temporary directory.
A static export also cannot supply the management API.

## Private files and clean builds

`.gitignore` and `.vercelignore` exclude the local data volume, work outputs,
custom Next build directories, logs, databases, real apartment media under
`public/imo3d`, and the real-apartment dataset
`src/lib/imo3d/example.json`. Instance-specific one-off scripts and historical
instance reviews are also excluded. No source data is deleted by these rules.
Ignore files do not protect data already committed to Git; review the staged
file list and diff before every first publication. Vercel archive rules are an
additional guard, not a substitute for repository review.

The production source no longer imports the real apartment dataset. The
optional `src/lib/imo3d/private-example.ts` loader reads it only for explicit
local development use. It is disabled when `NODE_ENV` is not `development`
or when `VERCEL` is set. No fixture read occurs during a production build.

- `IMO3D_EXAMPLE_FILE` can select an optional local fixture. Without it, the
  loader tries `private-example.json` in the private data directory, then the
  existing ignored `src/lib/imo3d/example.json` for local compatibility.
- `src/lib/imo3d/store.ts` loads the fixture only when `installExample()` is
  called. Missing or invalid input produces a clear unavailable response;
  it does not prevent the application from starting.
- `src/components/imo3d/Studio.tsx` shows the reference import card only when
  the authenticated dashboard provides the local feature. Production receives
  no sample identity or thumbnail, so there is no broken sample image.
- Generic map/navigation tests use
  `tests/fixtures/imo3d-synthetic-tour.ts`. Only the individually marked tests
  in `tests/imo3d-private-reference.test.ts` read actual reference data; each
  reports an explicit skip when that data is absent. Set
  `IMO3D_SKIP_PRIVATE_FIXTURES=1` to exercise this clean-checkout path locally.
  The test runner never copies private geometry into its generated output.
- The legacy local worker scripts still resolve `/imo3d/example/` media
  through the local `public` directory. Cloud migration must map those assets
  to protected object keys without depending on that excluded directory.

Synthetic geometry tests and application icons are not private apartment
assets. Keep them in the repository. Keep credentials in server/worker
configuration, never in browser bundles, public files or migration reports.

## Uploads, downloads and maps

The existing multipart API buffers up to 100 MiB and then runs Sharp. This
cannot remain the upload path on Vercel: its function request/response payload
limit is 4.5 MB. Use signed direct uploads to private storage and a small
finalization request. Supabase supports resumable TUS uploads with signed
upload tokens. [Vercel function limits](https://vercel.com/docs/functions/limitations)
and [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).

Authorize the upload against its project/tour, use a unique non-overwriting
object key, and bound the bucket/file size and allowed formats. Finalization
must verify stored size, image format, 2:1 ratio and decoded pixel limits before
accepting a scene. Keep original bytes unchanged. A worker can create viewing
variants; the interface must distinguish an uploaded image awaiting preparation
from an available panorama. A failed upload or finalization must not change
existing scenes.

Keep storage private. The server authorizes each asset by the owning tour or
administrator/integration scope, then issues a short-lived download URL.
Do not send service credentials to the browser. Signed URLs require an
explicit expiry policy because publication revocation cannot retract an
already-issued URL immediately. [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).

The current raster-plan status and image routes are administrator-only.
A reviewed plan selected for a published tour needs its own authorized
publication reference. Do not expose all AI jobs or their internal paths to
make one map visible. Preserve the existing draft/publication flags during
migration; deploying infrastructure does not publish the tours automatically.

## Insert-only migration

1. Make a consistent SQLite backup with the SQLite backup API while preserving
   the original local database. Record row counts, IDs, revisions, publication
   flags and asset byte hashes in a private migration manifest.
2. Verify the destination is the explicitly created empty Supabase project.
   Create isolated tables, private buckets and authorization policies there.
   Fail on unexpected existing records or objects; do not use reset commands.
3. Export records from the backup, including branding bytes and approved
   raster-plan navigation. Convert absolute local artifact paths to private
   object keys in the destination copy only. Keep the source untouched.
4. Upload objects with overwrite disabled. If resuming, accept an existing
   destination object only after verifying its expected size and hash; never
   silently overwrite a mismatch.
5. Insert records with duplicate-ID conflicts treated as errors, or verify an
   exact previous import before skipping it. Preserve logical IDs and revisions.
   Keep stable asset API references where possible. If image URLs change,
   recompute dependent scene fingerprints in the imported copy so an unchanged
   plan is not incorrectly classified as stale.
6. Verify row counts, relationships, revisions, publication state and every
   referenced object's bytes against the private manifest. Keep all originals,
   logos and approved drafts recoverable before exposing the new application.

No deletion of local or old cloud data is part of this migration. Do not
upload the SQLite database, private manifests, logs or raw apartment media to
GitHub as a migration shortcut.

## Readiness checks

From the repository root:

```sh
node scripts/imo3d-cloud-preflight.mjs
node scripts/imo3d-cloud-preflight.mjs --json
node --test tests/imo3d-cloud-preflight.test.mjs
```

The preflight is read-only: it checks source imports, tracked paths and
exclusions. It does not open project databases, read environment secrets,
contact cloud accounts or change the index. Exit code 1 means blocked or
incomplete inspection; exit code 2 means static checks cleared but live
verification is still required. It never reports `cloudReady: true`.

This is intentionally conservative source inspection, not a dependency-graph
or security proof. An isolated local adapter left in the inspected server
folder will require reviewing/updating the check when a cloud adapter is
implemented. Do not remove a blocker merely to obtain a passing result.

Perform a production build from a clean
checkout and test the actual isolated deployment: anonymous draft denial,
administrator login, preview and approved maps, image uploads near 100 MiB,
resumable interruption, assets larger than the function payload limit,
optimistic edit conflicts, worker cancellation/restart and persistence across
redeployment. Use disposable new test records for delete tests. Verify the
original source and unrelated cloud projects remain unchanged. Only then
provide the verified deployment and management links.

