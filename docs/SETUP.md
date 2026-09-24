# Setup on a new computer

Prepared2026-09-24. Windows x64 is the supported transfer target for the existing credential/device-worker configuration. macOS/Linux requires a different credential/runtime setup. This is not a static-only application.

## Software baseline

| Program | Exact source-machine version / requirement | Purpose |
|---|---|---|
| Node.js x64 |24.19.0; package engine >=24 | Next, workers, built-in SQLite |
| npm |10.9.2 | Reproducible `npm ci` |
| Python x64 |3.12.14 | Reconstruction/depth/vision; not needed for marketing-only preview |
| PowerShell |7.6.5; built-in Windows PowerShell5.1 for DPAPI/WPF | Shell and masked credential form |
| Git |2.53.0.windows.3 observed | Included history and authenticated future push |
| Chromium/WebGL browser | No exact version lock | Panorama and mobile QA |
| ZIP64-capable extractor | No version lock | Large files/long paths; use NTFS/exFAT, not FAT32 |
| Claude Code | Owner's supported installed release; not verified/installed in this task | New developer tool, not production dependency |
| Codex | Optional compatible signed-in installation | Separate current photo-retouch workflow; not Gemini plan generation |

Use exact observed runtimes first, not Node18/20/22. No global Next/TypeScript install is needed. CPU processing is supported; optional GPU runtime must match new GPU/drivers. Python folders in the ZIP contain Windows native binaries and are not universally portable. Have space for both archive and extraction plus new processing outputs. Avoid OneDrive/network-sync folders for live SQLite and worker outputs.

## Accounts and services

| Service | Required access | Scope |
|---|---|---|
| GitHub | `bmk-solutions/BMK-Web`, fresh local authentication | Preserve history/branch; no force push |
| Vercel | Existing `bmk-imo3d`, team `beyttechbmk-5008s-projects` | `.vercel/project.json` preserves association; do not relink |
| Supabase | Existing project `xdjjrzzboxazrgcyfxxd`, private server settings | Existing DB/storage/RPCs; no reset or automatic migration/import |
| Google AI Studio / Gemini | Owner's key entered in masked local form; valid API billing/quota | Last real image quota0; auth/model-list success alone insufficient |
| ChatGPT/Codex | New-device login only if using existing photo retouch/MCP | Login sessions were not transferred |
| Public model hosts | Explicit downloads if rebuilding pinned artifacts | Existing weights/manifests are bundled; inference normally offline |
| Google Fonts | Browser access for remote font CSS | Alexandria, Space Grotesk, Space Mono and Inter |

`SUPABASE_SERVICE_ROLE_KEY` must never enter browser code. `.env.example` is empty and not operational configuration. `.env.local` can contain expiring Vercel OIDC material; it is not portable authentication. No server password/API key is written into these docs.

## From zero to local preview

1. Verify `project-handover.zip` against the adjacent SHA-256/report, then extract `BMK-Web` to a nonsynced location, e.g. `C:\Projects\BMK-Web`. Keep archive private. It contains Git and ignored local data unavailable from a GitHub clone alone.
2. Open the actual repository folder. Read CLAUDE/HANDOVER/DESIGN/SETUP. Check `git status --short` and `git log -1`; handover commit is included but not automatically pushed.
3. Install baseline runtimes and check them:

```powershell
node --version
npm --version
python --version
git --version
npm ci
```

4. Choose isolated LOCAL mode or authorized CLOUD mode. Next auto-loads `.env.local`, NOT `.env.cloud.local`. Do not copy `.env.example` over existing private settings. For local testing, provision a private local admin secret at least32 characters long using protected local configuration; do not echo it to logs. Set a separate data directory so bundled historical SQLite is untouched:

```powershell
$env:IMO3D_CLOUD='0'
$env:IMO3D_DATA_DIR=Join-Path $PWD 'work/new-machine-local-data'
$env:IMO3D_PUBLIC_ORIGIN='http://127.0.0.1:3000'
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Visit `http://127.0.0.1:3000/imo3d`. Empty local mode does not show cloud projects. Normal marketing site is `/`.

5. If authorized to access production data from local dev, use a fresh terminal, review private cloud settings and launch explicitly:

```powershell
node --env-file=.env.cloud.local node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3000
```

If `IMO3D_PUBLIC_ORIGIN` is production, make a private local override matching localhost for auth/CSRF; do not change Vercel's value. Cloud mode accesses real records, including delete actions. Use a separate authorized test project.

6. Build/check without deployment:

```powershell
npm run build
npx tsc --noEmit
npm run lint
npm run test:imo3d
node scripts/test-imo3d-gemini.mjs
node scripts/test-imo3d-plan-quality.mjs
node scripts/test-imo3d-cloud-routes.mjs
node scripts/test-imo3d-engine.mjs
node --test tests/imo3d-local-credentials.test.mjs tests/imo3d-worker-runtime.test.mjs tests/imo3d-supervision.test.mjs
npm run start -- --hostname 127.0.0.1 --port 3000
```

Stop dev before sharing its output with build/start, or deliberately set `IMO3D_BUILD_DIR`. Keep generated Next type paths consistent. No `npm test` script exists. Extra Python/PowerShell tests are in `tests/`; use matching runtimes and synthetic fixtures.

## Worker paths and model dependencies

`work/reconstruction-runtime.json` contains absolute old-machine `python` and `cvPath`. Overrides: `IMO3D_PYTHON`, `IMO3D_CV_PATH`. Update only private machine configuration after selecting new paths; do not change source code merely to migrate usernames. Snapshot currently points to `work/reconstruction-python-user`; older verified directories are also included. Package metadata and old runtime success are not proof the copied target works now.

Pinned sources:

- `scripts/imo3d-reconstruction-requirements.txt`: numpy2.5.3, opencv-python-headless4.13.0.92, scipy1.17.1.
- `scripts/imo3d-room-vision-requirements.txt`: transformers4.51.3, tokenizers0.21.4, huggingface-hub0.30.2, safetensors0.5.3, regex2024.11.6, requests2.32.3, PyYAML6.0.2, tqdm4.67.1, pillow12.3.0.
- `scripts/requirements-imo3d-joint-depth.txt`: torch2.14.0+cpu, numpy2.5.2, OpenCV4.13.0.92, Pillow12.3.0, safetensors0.5.3, einops0.8.1, addict2.4.0, omegaconf2.3.0, antlr4-python3-runtime4.9.3, PyYAML6.0.2.
- Layout runtime uses torchvision0.29.0+cpu with torch2.14.0+cpu. Room vision also uses onnxruntime1.22.1. Full observed per-target metadata appended below.

If rebuilding missing dependencies, keep targets separate rather than global installs:

```powershell
python -m pip install --target work/reconstruction-python-verified -r scripts/imo3d-reconstruction-requirements.txt
python -m pip install --target work/layout-python-verified --index-url https://download.pytorch.org/whl/cpu torch==2.14.0+cpu torchvision==0.29.0+cpu
python -m pip install --target work/room-vision-python-verified onnxruntime==1.22.1 tokenizers==0.21.4
python -m pip install --target work/vlm-python-verified -r scripts/imo3d-room-vision-requirements.txt
python scripts/setup-imo3d-room-vision.py
python scripts/setup-imo3d-joint-depth.py
```

These pins describe the source environment, not a fresh-download guarantee. If unavailable/conflicting, report the exact failure rather than silently changing model/dependency versions. Model weights/custom runtime source are bundled. Not all older layout/depth installation steps are fully automated; retain included `work/layout-model`, `depth-model`, `da3-model`, `room-vision-models` and their license/hash manifests.

Required preflight files include `layout-model/resnet50_rnn__st3d.pth`, `depth-model/model.safetensors`, `da3-model/{config.json,model.safetensors}` and `room-vision-models/{SmolVLM-500M-Instruct,rtdetr_v2_r18vd}` with manifests. `work/gpu-python` may take import priority when present; verify hardware compatibility before use.

```powershell
$env:IMO3D_PYTHON=(Get-Command python).Source
$env:IMO3D_CV_PATH=Join-Path $PWD 'work/reconstruction-python-verified'
python scripts/imo3d-runtime-check.py
node --env-file=.env.cloud.local scripts/imo3d-cloud-worker.mjs --check
python scripts/setup-imo3d-joint-depth.py --verify-only
```

These are local dependency/model checks, not geometry quality tests. Resolve failed imports/native operations before downloading real tour jobs. `--verify-only` does not download new weights.

## Gemini key on the new device

Old key path: `%LOCALAPPDATA%\BMK-IMO3D\secrets\gemini-api-key.dpapi`. It is encrypted for the original Windows user/device and cannot be made portable by copying. The owner must retrieve the key from their Google account/password manager and enter it directly in the masked form, never in chat.

```powershell
powershell.exe -NoProfile -STA -File scripts/setup-imo3d-gemini-credential.ps1
node scripts/imo3d-subscription-worker.mjs --check
node scripts/imo3d-subscription-worker.mjs --check-credentials
node scripts/check-imo3d-gemini-connection.mjs
```

The form writes new current-user DPAPI storage. Credential check prints availability only; connection check lists models only. Neither verifies paid generation quota. Do not invoke `-PrivatePipe` from a terminal. If policy blocks the form, use an explicitly approved local method; no machine policy change or persistent bypass is authorized by this handover.

## Cutover and automatic processing

Automatic per-project generation starts after upload within supported limits. Manual startup refers to the long-lived worker process, not a button for each project.

Before moving processing to the new computer, inspect old worker/queue state. Do not start duplicates, kill active work, or requeue cancelled jobs. Old plans scheduled task was disabled; old photo task may remain enabled. Windows tasks, authentication and power settings are not portable repo files.

Two separate terminals after `.env.cloud.local` and runtime paths are ready:

```powershell
node scripts/imo3d-device-supervisor.mjs photos
node scripts/imo3d-device-supervisor.mjs plans
```

Keep the device awake, online and signed in. Logs: `work/device-workers/photos.log` and `plans.log`. Supervisors load private cloud env for their children and restart failures with bounded backoff. One instance per role. Optional existing PowerShell wrapper adds a mutex after policy/path validation:

```powershell
pwsh -NoProfile -File scripts/start-imo3d-device-worker.ps1 -Role plans -NodePath (Get-Command node).Source
```

`scripts/imo3d-cloud-worker.mjs --once` consumes real work; it is not a harmless setup test. Vercel/published tours work without this PC, but heavy queued processing waits when it is offline. Gemini last observed image quota was0 and needs resolution before live drawing succeeds.

## Data and files not automatically portable

- Production DB/storage remain in Supabase. This ZIP is a local snapshot, not a fresh full remote backup. Do not import the bundled SQLite over production records or rerun migrations blindly.
- Local SQLite WAL/SHM are included as original files. A separate consistent SQLite backup is placed inside ZIP `handover-snapshots/` with a manifest/quick-check; use that coherent backup for recovery.
- Four external generated images are bundled under `handover-external-assets/` with source mapping in HANDOVER. Historical JSON absolute paths were not rewritten; preserve validation boundaries.
- Google Fonts are remote dependencies, not local source fonts. Existing logos/media are under `public/`. Old Alkaz marketing-source directory is absent; optimized outputs are included. No required Figma file was found.
- Browser-local measurements, unsaved browser state, cookies, global CLI login, Windows tasks and GPU drivers require separate re-login/setup. Do not dump the old browser profile to migrate passwords.
- The original encrypted Gemini blob is not useful on a different account/device; re-enter the key safely.

## Later Git and deployment

Handover commit is local and included in `.git`, not pushed/deployed. Sign in to GitHub/Vercel on the new machine rather than relying on copied expiring credentials. Verify remote/branch before push; Git push may trigger configured deployments. Never publish the private ZIP. Owner's explicit deploy approval is required for future changes.

## Acceptance checklist

Verify login/password change, developer/project isolation, upload/resume/cancel, all-source counts, worker offline behavior, actual Gemini quota/output, no stale overwrite, private vs published plan access, room labels/entry views, same-room wall clicks, far doorway navigation, measurement delete/hide and physically checked dimensions, hotspots, Arabic/RTL/mobile controls. Use authorized disposable records. HANDOVER documents unresolved engineering; successful build/imports do not mean100% production readiness.

## Installed Python distribution metadata at handover

These are isolated target inventories, not a guarantee that an import or clean download succeeds. Missing metadata in user/GPU targets requires preflight.

### `work/reconstruction-python-user`

| Distribution | Version |
|---|---|

### `work/reconstruction-python-verified`

| Distribution | Version |
|---|---|
| `numpy` | `2.5.3` |
| `opencv-python-headless` | `4.13.0.92` |
| `scipy` | `1.17.1` |

### `work/layout-python-verified`

| Distribution | Version |
|---|---|
| `filelock` | `3.32.3` |
| `fsspec` | `2026.7.0` |
| `Jinja2` | `3.1.6` |
| `MarkupSafe` | `3.0.3` |
| `mpmath` | `1.3.0` |
| `networkx` | `3.6.1` |
| `numpy` | `2.5.2` |
| `pillow` | `12.3.0` |
| `setuptools` | `78.1.0` |
| `sympy` | `1.14.0` |
| `torch` | `2.14.0+cpu` |
| `torchvision` | `0.29.0+cpu` |
| `typing_extensions` | `4.16.0` |

### `work/vlm-python-verified`

| Distribution | Version |
|---|---|
| `certifi` | `2025.1.31` |
| `charset-normalizer` | `3.4.1` |
| `huggingface-hub` | `0.30.2` |
| `idna` | `3.10` |
| `PyYAML` | `6.0.2` |
| `regex` | `2024.11.6` |
| `requests` | `2.32.3` |
| `safetensors` | `0.5.3` |
| `tqdm` | `4.67.1` |
| `transformers` | `4.51.3` |
| `urllib3` | `2.3.0` |

### `work/room-vision-python-verified`

| Distribution | Version |
|---|---|
| `coloredlogs` | `15.0.1` |
| `flatbuffers` | `25.2.10` |
| `humanfriendly` | `10.0` |
| `onnxruntime` | `1.22.1` |
| `packaging` | `25.0` |
| `protobuf` | `6.32.1` |
| `sympy` | `1.14.0` |
| `tokenizers` | `0.21.4` |

### `work/da3-python`

| Distribution | Version |
|---|---|
| `addict` | `2.4.0` |
| `antlr4-python3-runtime` | `4.9.3` |
| `einops` | `0.8.1` |
| `omegaconf` | `2.3.0` |

### `work/gpu-python`

| Distribution | Version |
|---|---|
