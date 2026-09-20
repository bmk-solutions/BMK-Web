# Operating the device workers

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
