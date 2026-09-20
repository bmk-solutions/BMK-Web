# Dedicated hosted processing

Vercel serves the application; Supabase stores durable jobs and private assets.
Neither the existing deployment nor a successful build starts a permanent image
processor. The two worker commands below must run on an independently provisioned
host. This document is preparation, not evidence of a live hosted worker.

## Required host setup

- A private persistent Linux host, Node 24 and a dedicated unprivileged `imo3d` user.
- This repository installed with `npm ci`; no desktop databases or credentials in Git.
- An isolated environment file readable only by the worker user, containing this
  application's `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and matching
  `IMO3D_CLOUD_PROJECT_REF`.
- A host-native Python environment selected with an absolute `IMO3D_PYTHON` path.
  Provision the reconstruction, vision, boundary and depth dependencies and model
  weights required by the Python scripts. Windows package directories cannot be
  copied as a substitute for Linux dependencies.
- A supported Codex installation selected with `IMO3D_CODEX_BIN`, with a private
  persistent `CODEX_HOME`. Authenticate on the host. Do not bake session tokens
  into the deployment, send them through the browser, or put them in GitHub.
- Verify image generation is actually available to that Codex installation using
  a synthetic image-generation job before accepting apartment jobs. Authentication
  alone does not demonstrate that the required image-generation tool is available.

## Commands (run from the repository root)

```sh
node --env-file=/etc/imo3d/worker.env scripts/imo3d-cloud-worker.mjs --check
node --env-file=/etc/imo3d/worker.env scripts/imo3d-cloud-worker.mjs
node --env-file=/etc/imo3d/worker.env scripts/imo3d-subscription-worker.mjs
```

Use separate supervised processes with restart-on-failure and a persistent private
work directory. Do not run them inside a Vercel request or expose a public shell
endpoint. `--check` checks presence only, not model inference or cloud access.

## Acceptance before switching off the desktop workers

1. Confirm credentials identify only the existing IMO3D Supabase project.
2. Verify all Python imports and model checksums on the Linux host.
3. Complete a synthetic reconstruction job and an actual image-generation job.
4. Stop desktop workers, then submit a new test tour through the public dashboard.
5. Verify processing, draft review, camera registration and publication still work
   with the desktop powered off; verify retry and lease recovery after a restart.
6. Keep previous approved plans unchanged on errors or unsupported geometry.

Image-generated furniture and inferred depth are not evidence of calibrated
metric measurements. Retain the estimation label until scale is independently
established. Do not lower geometry validation to make a failed job look complete.
