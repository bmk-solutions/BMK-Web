# Operating the device workers

> **2026-09-24, studio suite:** the workers now run on the owner's PC from a deploy folder built
> from a commit, plans on the local Codex. See `scripts/device/README.md`; the scheduled tasks below
> describe the previous machine.

The public site and existing tours run on Vercel and Supabase. New photo and
subscription-plan jobs run on the designated Windows computer. Any signed-in
administrator can submit jobs from another computer or phone.

## Installed supervision

The designated device has two Windows scheduled tasks:

- `BMK IMO3D photos worker`
- `BMK IMO3D plans worker`

They run at the designated user's Windows sign-in, under that user without
administrator privileges. They start hidden and supervise separate worker
processes. Task concurrency and a per-repository mutex prevent duplicate
supervisors. The supervisor retries a stopped worker with a 2–60 second backoff.
The Windows task itself has three one-minute restart attempts if its wrapper
fails. No password is stored in the task action.

The device must remain awake, signed in and connected during new processing.
Tasks are registered for sign-in, not for processing before Windows sign-in.
No global sleep or power settings were changed. Authentication expiry, missing
models, subscription limits and insufficient photo evidence require attention;
restarting cannot solve those conditions.

The absolute Node, PowerShell and repository paths in the task actions must be
updated if the repository is moved or the installed runtimes are removed.
Cloud credentials remain in the ignored `.env.cloud.local`, not in task arguments
or version control. Codex subprocesses receive no Supabase or admin credentials.

## Inspection

```powershell
Get-ScheduledTask -TaskName 'BMK IMO3D * worker'
Get-Content work/device-workers/photos.log -Tail 20
Get-Content work/device-workers/plans.log -Tail 20
```

Logs rotate after 8 MiB to dated private files under `work/device-workers`.
Older logs are retained; no automatic deletion of project data is performed.
Plan worker heartbeat is stored in `imo3d_plan_workers`. An online heartbeat
means a process is polling; it does not certify an individual generated plan.

Before stopping or updating a worker, check its queue for active work. After
maintenance verify a fresh plan heartbeat and the photo worker's idle status.
Avoid starting a second manual worker while the tasks are running.

## Release acceptance boundaries

Verify uploads, private/public permissions, viewer behavior and a synthetic
generation on the actual installation. Unit tests do not replace those checks.
Keep inferred metric values visibly estimated. Preserve approved plans when new
analysis fails. A furnished image is not independently measured room geometry.
Each new generated layout must remain reviewable before publication.

## Engine presence (heartbeats read by the studio)

Both roles write a row in `imo3d_plan_workers` (`id`, `seen_at`); the studio calls a role online when
its row is younger than 90 s. No column was added: the provider is a second row.

| Row | Written by | Read as |
|---|---|---|
| `subscription` | plans role, every poll and every 20 s during a job | plans worker online |
| `subscription:codex` / `subscription:gemini-local` | plans role, beside the row above | «عامل Codex» / «عامل Gemini» in the studio; no row = «عامل المخططات» |
| `photos` | photos role, every 30 s beside its job loop (`startPresence`), best effort | a queued upload older than 90 s with a stale row, and no processing job holding a live lease, shows «محرك الصور على جهازك غير متصل…» |

A role that has never written its row is `unknown`, not offline: a folder built before this change keeps
working and is simply not reported. The rows appear once `device-live` is rebuilt from a commit that
contains this change (`build-device-live.ps1 -Commit <sha>`, workers stopped first). Photo retouch runs in
the plans role, so the retouch panel reads the plans row.

**Rolling `device-live` back to a build older than 2fa98e2.** The rows stay behind and go stale while the
old build keeps working, so after the rollback (workers stopped first) delete them:
`DELETE FROM public.imo3d_plan_workers WHERE id IN ('photos','subscription:codex','subscription:gemini-local');`
(`subscription` itself stays: every build writes it). The studio is also safe if this step is missed: a
stale `photos` row is not called offline while any processing job holds a live lease (the old engine is
working and takes the queued upload next), and a stale `subscription:<provider>` row is ignored, so the
panel falls back to «عامل المخططات».

## Plan: make `device-live` self-contained (design only, 2026-09-25 — nothing changed yet)

**Problem (measured by the 2026-09-25 study).** `D:\BMK\tour360\device-live` pins only `scripts\` and
`src\` to a commit. Everything else points back into places that change or vanish without warning:

| Dependency | Points at today | What breaks it |
|---|---|---|
| secrets | `envFile` = `<dev checkout>\.env.cloud.local` (also on the live worker command line) | moving, renaming or cleaning the dev checkout |
| Python | `python` = `%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\...\python.exe` | any Codex app update or cache clean |
| `node_modules` | junction to `<dev checkout>\node_modules` | `npm install` / `npm ci` or a branch switch in the dev checkout |
| 15 runtimes (14 present) | junctions `work\<name>` to `<dev checkout>\work\<name>` (models, venvs) | cleaning `work\`, moving the checkout |

**Target layout** — one stable root, no path into the dev checkout or an application cache:

```
D:\BMK\tour360\
  runtimes\<name>\                 the runtime folders, MOVED once from <dev checkout>\work
  runtimes\manifest.json           name, byte size, file count, sha256 of each top-level file
  python\                          a CPython 3.12 that belongs to the deploy (pinned version + sha256)
  secrets\.env.cloud.local         the env file, owner-only ACL
  node_modules\<lockfile-sha>\     npm ci --omit=dev from the commit's package-lock.json
  device-live\                     scripts\ + src\ from the commit; junctions only into the folders above
```

**Steps** — each reversible; run with both workers stopped and no job running:

1. `build-device-live.ps1` gains `-RuntimeRoot D:\BMK\tour360` and stops reading `$repo\work` and
   `$repo\node_modules`. The lockfile joins the archived files; the script runs
   `npm ci --omit=dev --ignore-scripts` into `node_modules\<lockfile-sha>` (reused when it exists),
   then `npm rebuild sharp` for the native binary, and junctions `device-live\node_modules` to it.
2. A one-time `scripts\device\move-runtimes.ps1` MOVES (the models are several GB; no copies) each
   `work\<runtime>` into `runtimes\<runtime>`, leaves a junction behind in the dev checkout so local
   tests keep working, and writes `runtimes\manifest.json`.
3. Python: install a pinned CPython 3.12 into `D:\BMK\tour360\python`; re-create the venvs that were built
   on the Codex Python against it (their `pyvenv.cfg` `home` must point there); `device.json.python` is that
   path. `check-device.ps1` refuses any `python` under `.cache\`.
4. Secrets: copy `.env.cloud.local` once to `secrets\` and restrict it
   (`icacls <file> /inheritance:r /grant:r "%USERNAME%:F"`); `device.json.envFile` points there. The dev
   checkout keeps its own copy for development; a key rotation updates both (documented, not synced —
   a sync would be one more path into the dev tree).
5. `run-device-worker.ps1` checks every path in `device.json` and every runtime in the manifest (exists,
   top-level hashes match) before it starts a worker. On a failure it does not crash-loop: it writes the
   heartbeat row `photos:engine-broken` or `subscription:engine-broken` (same table, no schema change),
   logs which check failed, waits 5 minutes and checks again. The studio then says «محرك الجهاز يحتاج
   إصلاحًا» instead of «غير متصل».
6. Acceptance: with the workers running, rename the dev checkout and the
   `%USERPROFILE%\.cache\codex-runtimes` folder to backup names; both roles keep heartbeating and claiming;
   restore both names. Then one owner-approved small tour through upload, linking and plan.

**Rollback** at any step: rebuild with the previous `build-device-live.ps1` (junctions into the dev
checkout), which still resolves because step 2 leaves junctions behind.
