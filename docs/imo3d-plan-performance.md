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


## September 21 corrective validation

- Valid analyzed layouts now go directly to rendering/visual audit. Invalid candidates receive one focused layout repair, with a cached result keyed by camera hints. Full per-photo evidence is reused; scene IDs are aliased during model output and restored before validation. Analysis/repair each have an eight-minute bound. Unsupported topology still cannot pass as an architectural footprint.
- Analysis failures retain a scoped `failure.json` and report geometry/coverage errors instead of blaming subscription connectivity.
- Panorama uploads use a rolling window of three transfers and serial, current-revision commits. Starting the next transfer no longer waits for the previous batch's complete preparation.
- Cloud derivatives decode a bounded 8K raster once, retaining untouched originals. One 51,298,923-byte real panorama benchmark: 5,366 ms before / 3,992 ms after; this is a local encode benchmark, not an end-to-end upload SLA.
- Device processing downloads use three bounded slots and hash-verified, tour-scoped cached inputs. Corrupt cache data is redownloaded and validated.
- Large-tour retrieval includes nearby capture order and a cross-component search. Every accepted link still passes the existing geometry tests. A 100-photo real case improved from 189 to 236 newly reconstructed pairs; old verified pairs were preserved during its scoped repair. Connectivity remains incomplete and is not reported as a complete reconstruction.
- Vertical photo measurement is explicit: floor base, then the point directly above it. It uses the recorded lens height, rejects nonvertical/near-horizon/invalid picks, and saves estimated endpoints through the existing notebook. It is not a surveyed measurement or a promise of 95% accuracy.

Acceptance: real local tour accepted a below-horizon base and above-horizon door top, displayed and selected the saved height. The same 100-photo AI case still could not establish full wall geometry; its original photos, evidence and previous plan remain intact. Do not claim the automatic furnished floorplan is production-ready for this case.


Automatic workflow: `imo3d_start_tour_workflow` atomically queues spatial processing and a subscription floorplan for supported batches (2–100 floorplan photographs; spatial processing retains its 300-photo cap). The plan worker waits for active spatial work and then loads fresh camera hints. The admin status is visible outside the plan tab. `imo3d_cancel_tour_workflow` cancels both queues under the same tour lock and returns a renderable job, including repeated cancellation. Functions are service-role only. New migration was verified transactionally against a temporary tour; all fixture rows rolled back, source tour unchanged. Public sharing and acceptance of uncertain generated geometry remain explicit.

## Depth runtime repair, September 21

Real-model smoke tests exposed two runtime failures hidden behind partial job
success: photo depth could not import `scipy.optimize`, and every joint-depth
group failed because its selected `cv2` namespace lacked `remap`. Both scripts
now honor the same configured scientific runtime as reconstruction. They use the
already verified GPU runtime when available, probe real kernels and free memory,
and retain CPU fallback. Joint inference falls back to CPU on GPU allocation
failure. Geometry acceptance thresholds and metric classifications are unchanged.

Verification on the affected tour, using local inputs without uploading again:

- Photo depth: 100/100 inputs processed without errors, 168 seconds including
  model startup (164.43 seconds summed inference). 85 passed the stricter renderer
  coverage gate. Those 85 were added to the saved tour in revision 108; source
  preview hashes were verified, active jobs checked under a tour lock, and all
  non-depth scene fields preserved. This is not an end-to-end upload benchmark.
- Joint depth: all 72 positioned cameras processed without runtime warnings in
  263 seconds; 150,000 independently supported surface samples retained locally.
  These estimates have not been accepted as architectural walls or metric depth.
- Python geometry suites: 7 photo-depth, 14 joint-depth and 12 depth-architecture
  tests passed. Production tour preview loads after the scoped depth update.

The original automatic floorplan remains unresolved. Fixing these runtime failures
does not certify full connectivity, furnished floorplan completion, or measurement
accuracy. The retained geometric evidence must be evaluated separately.
