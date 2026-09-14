# Local worker for the cloud application

This worker connects outward to the application's new Supabase project. It
opens no network listener and does not require an inbound connection to the
computer. Vercel enqueues reconstruction work; this process performs the heavy
Node/Python work locally and commits the result only if its lease, source-image
fingerprint and tour revision still match.

Implementation status: reconstruction transport, isolation and lifecycle are
covered by synthetic tests, including real child-process start and cancellation.
No live Supabase job or real-photo cloud reconstruction is certified by those
tests. Complete the isolated deployment checks before calling the service ready.

## Requirements

- Node.js 24 or newer and this repository's installed dependencies.
- The existing local reconstruction runtime and models configured in
  `work/reconstruction-runtime.json`, or its supported `IMO3D_PYTHON` override.
  The worker does not install packages, download models or use remote inference
  for reconstruction. Its child process runs with offline model settings.
- The newly created application-specific Supabase project, its private
  `imo3d-private` bucket and the reviewed cloud database migration.
- The computer remains on while processing new jobs. Previously uploaded tours
  and media remain independently available from the cloud application.

## Private configuration

Create an ignored `.env.imo3d-worker` file in this repository with these names:

```dotenv
SUPABASE_URL=https://YOUR_NEW_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_NEW_PROJECT_SERVER_KEY
IMO3D_CLOUD_PROJECT_REF=YOUR_NEW_PROJECT_REF
```

Use only the dedicated new project. The explicit project reference must match
its URL. Never copy credentials from an existing unrelated project or commit
this file. The service key stays in this local process; it is removed from the
child reconstruction process's environment along with the OpenAI key.

```sh
node --env-file=.env.imo3d-worker scripts/imo3d-cloud-worker.mjs --check
node --env-file=.env.imo3d-worker scripts/imo3d-cloud-worker.mjs --once
node --env-file=.env.imo3d-worker scripts/imo3d-cloud-worker.mjs
```

`--check` checks configuration presence and the local Python executable without
contacting Supabase. It does not validate credentials, models or reconstruction
quality. `--once` claims at most one job and returns. The normal command polls
continuously, backing off after connection failures. Use Ctrl+C to stop the
foreground worker; an active isolated job is cancelled locally and a retry is
requested when its cloud lease is still valid.

## Data isolation and commits

Every attempt creates a fresh directory under
`work/cloud-worker/<job>/<attempt>/`. Only the claimed cloud tour and its scoped
asset metadata enter that attempt's SQLite database. Required originals and
preview images are downloaded into its `assets` directory and checked against
the recorded size and SHA-256 when present. Imported scenes without an original
record use their existing full image as the best available input. No missing
original is silently claimed to exist.

The existing local `scripts/imo3d-worker.mjs` receives `IMO3D_DATA_DIR` pointing
only to that attempt. It never receives the application's original local data
directory. The wrapper also rejects a nonempty mirror database, traversal paths,
cross-tour assets and conflicting local filenames. Local input images and
project metadata must remain unchanged in the returned processing result.

The wrapper maintains a 30-second remote lease with five-second heartbeats.
Lease loss or cancellation aborts the child work. Before saving, new surface
assets are uploaded under unique attempt-specific keys with overwrite disabled.
`imo3d_commit_job` checks the lease, source hash and expected tour revision, then
inserts asset records and commits the tour/job result in one transaction. Its
revision check prevents an older processing result from replacing newer edits.
A review result stays a review result; processing does not publish the tour.

Attempt logs and artifacts are retained privately for diagnosis. An upload
followed by a revision conflict can leave an unreferenced object in the new
private bucket. The worker does not delete existing cloud or local data to
clean it up. Any later retention policy must be separately scoped and verified.

This process currently consumes reconstruction `processing_jobs`. The separate
OpenAI image-plan queue requires its own worker support and API configuration;
this command does not make AI generation available by itself.

## Validation

```sh
node --test tests/imo3d-cloud-worker.test.mjs
```

Tests use invented image bytes and isolated SQLite files under `work`. They
cover fallback inputs, ownership/path checks, hash/size verification, fresh
attempts, source data preservation, lease loss, cancellation, revision conflicts,
non-overwriting storage requests, streamed download limits and child lifecycle.
They never contact a real cloud project or process the user's photos.
