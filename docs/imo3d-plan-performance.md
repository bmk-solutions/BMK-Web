# Subscription floorplan processing

The photographed panel is the floorplan job, not the photo upload. On 21 September
2026 the affected tour had all 100 scenes stored, and its separate room/spatial job
was already at review/100%. The floorplan worker had prepared 100 evidence sheets
and was waiting on a single Codex call using `gpt-6-astra` with `xhigh` reasoning.
The old next step regenerated the complete per-photo evidence in a second call.
The stopped job's buffered event log additionally revealed five WebSocket reconnect
attempts before falling back to HTTPS. This transport failure had been invisible
to the admin panel and to live diagnostics.

## Changes

- Prepare up to three evidence sheets concurrently, preserving attachment/scene order.
- Keep every input photograph in the analysis and independent review. Use `high`
  reasoning for floorplan calls, leaving photo retouching's existing effort intact.
- Use an invocation-scoped `imo3d_https` provider at the official ChatGPT Codex
  endpoint with `requires_openai_auth=true` and `supports_websockets=false`. This
  retains existing subscription sign-in, uses no API key, and avoids the repeated
  WebSocket startup failures. Built-in provider IDs cannot be overridden in the
  installed Codex version. The user's global Codex configuration is untouched.
- The independent review returns corrected geometry and only changed photo evidence.
  Merge corrections deterministically; still require exact source-photo coverage,
  valid room polygons/openings, and supported geometry before rendering.
- Atomically checkpoint analysis, validated review, and validated render output in
  private `work/subscription-plan-cache`. Keys include tour, input fingerprint and
  pipeline version. Retrying unchanged inputs resumes completed stages. A missing
  generated file is regenerated; a changed image/floor cannot reuse stale results.
- Stream bounded local diagnostic logs immediately and record per-call duration.
  Calls are bounded to 30 minutes for analysis and 20 minutes for review/render,
  rather than silently waiting for the two-hour whole-job deadline. A timeout is
  reported as such; it is not a successful or complete result.
- The admin panel shows stage and elapsed request time, and offers tour preview
  independently of floorplan drafting. It does not fabricate a completion percentage.

No source photo, published floorplan or other project's settings are replaced.
Draft publication remains an explicit review step. AI geometry remains an estimate.

## Verification

Cloud regression tests cover bounded preparation of 100 inputs, stable ordering,
failure drainage, isolated/invalid checkpoint handling, correction merging, exact
photo coverage and rejection of unsupported geometry. Production build/typecheck
also required. This change does not establish an end-to-end processing-time SLA;
subscription inference and image-generation latency still vary.
