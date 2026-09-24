# Device workers on the owner's PC (studio suite, 2026-09-24)

The engines run on this PC; Vercel and Supabase keep the pages, APIs and files. The PC only polls
outward (claim, lease, heartbeat, commit), so nothing listens for the internet. The old PC's
(MiEXCITE) workers are stopped; run only ONE photos and ONE plans worker at a time.

| Role | Engine | Settings the scripts give it |
|---|---|---|
| `photos` | Python + OpenCV/SciPy + models on the GPU (`scripts/imo3d-cloud-worker.mjs`) | `IMO3D_PYTHON` = the Codex runtime's Python 3.12, `IMO3D_CV_PATH` = `<deploy>\work\reconstruction-python-user` |
| `plans` | the local Codex (`codex exec`, the owner's ChatGPT subscription) for plans and photo retouch (`scripts/imo3d-subscription-worker.mjs`) | `IMO3D_PLAN_PROVIDER=codex` (Gemini is not injected), `IMO3D_CODEX_BIN` = newest `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin` by modification time, re-read at every start |

Both get `IMO3D_ENV_FILE` = this repository's `.env.cloud.local` (the only copy of the secrets).
Child processes never receive them: Python gets a scrubbed environment, Codex an allow-list.

## Deploy folder (built from a commit, like the studio's `studio-live`)

```powershell
# from this repository; refuses while a worker runs from the folder
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\device\build-device-live.ps1 -Commit <sha>
```

`D:\BMK\tour360\device-live` then holds the commit's `scripts\` and `src\`, `device.json` (commit,
paths), `work\reconstruction-runtime.json` for this PC, and junctions (no copies) to this
repository's `node_modules` and bundled runtimes under `work\`. The previous build is kept as
`device-live.old`; junctions are unlinked before any folder is removed.

## Operate (from the deploy folder)

```powershell
$d='D:\BMK\tour360\device-live\scripts\device'
powershell -NoProfile -ExecutionPolicy Bypass -File $d\check-device.ps1           # read-only: runtime + Codex sign-in, claims nothing
powershell -NoProfile -ExecutionPolicy Bypass -File $d\ensure-device-workers.ps1  # start both roles hidden (WMI, survives the caller)
powershell -NoProfile -ExecutionPolicy Bypass -File $d\stop-device-workers.ps1    # stop (check the queue first)
powershell -NoProfile -ExecutionPolicy Bypass -File $d\startup-entry.ps1          # start at sign-in (Startup folder, no admin); -Remove to undo
Get-Content D:\BMK\tour360\device-live\work\device-workers\plans.log -Tail 20
```

`ensure-device-workers.ps1` is idempotent; each role runs through the repository's
`start-imo3d-device-worker.ps1` (one supervisor per role, named mutex) and the supervisor restarts
its worker with a 2-60 s backoff. Nothing here starts on its own: the cutover decides when.
