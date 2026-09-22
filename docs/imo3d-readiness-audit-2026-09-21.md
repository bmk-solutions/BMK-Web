# IMO3D processing and multi-project audit — 2026-09-21

## Shipped changes

- Processing now runs a local dependency/model-file preflight before fetching a tour or downloading its photographs. It exercises OpenCV remapping, SciPy optimization and spatial indexing, and imports the actual depth/vision runtimes. A broken environment fails explicitly without an automatic retry loop or tour mutation.
- The preflight is cancellable, bounded to 45 seconds, and does not receive cloud credentials. `--check` distinguishes local runtime health from cloud connectivity. Model-file presence is not a full weight-integrity or accuracy test.
- Dashboard and tour-list routes use a service-only, read-only SQL projection. Depth arrays and photo-edit records are removed in PostgreSQL, rather than transported to Vercel and discarded there. Full tour reads remain available to authorized editors/viewers.
- Depth/architecture warnings now keep a processing job in review instead of reporting completed.

## Verification

- Core tests: 464 passed. Cloud route tests: 66 passed. Cloud worker, upload and runtime tests: 29 passed. Production build and TypeScript passed.
- Actual local runtime preflight passed after restarting the idle photo worker.
- SQL transaction test: 100 synthetic projects, 100 scenes each. Verified project scope, scene ordering, empty scope behavior, denied anonymous/authenticated RPC access, unchanged real payloads, and rollback of all fixtures. Query including transport took 2.3 seconds. This is not a 100-project concurrent image-processing load test.
- Current database: 4 tours, 209 scenes, 807 derivative/other asset records, 174 original records. No duplicate scene IDs, missing navigation targets, foreign media references or orphan original records were found by the audit.
- Storage metadata: all 981 referenced objects exist and their recorded sizes match. This is not a full byte download/hash audit of every object.
- Current dashboard payload projection: 11,111,420 bytes reduced to 646,090 bytes (database JSON text sizes, before HTTP compression).
- Browser smoke test on the affected tour: floor-to-top wall selection produced an estimated 2.47 m, hide/show retained it, selection and deletion removed the test measurement. No physical dimension was available to validate that estimate.

## Remaining acceptance limits

The latest 100-photo tour has 72 positioned photographs, 8 photographs without navigation links, and 85 accepted display-depth maps. These are rendering estimates, not calibrated metric depth. Successful execution does not establish complete spatial reconstruction.

The repaired joint-depth runtime produced 150,000 points without runtime errors. Offline architecture evaluation found 16 wall planes and 5 opening candidates, but no closed room outlines. A complete furnished floorplan therefore remains unverified. Preserve existing plans and photographs; do not fabricate walls, force links through walls, or promote these outputs to surveyed geometry.

The 1.27 m capture-height setting supports estimated planar/vertical measurement. It does not certify arbitrary point-to-point dimensions, 95% accuracy, or Biganto-equivalent reconstruction. Ground-truth validation and adequate overlapping capture/geometry are still required for those claims.

One local device processes the queues. Its availability, model capacity and subscription limits remain operational dependencies. Dashboard scale tests do not establish processing throughput for 100 simultaneous projects.


## Floorplan processing follow-up — 2026-09-22

- Fresh subscription analyses now inspect 12 panoramas per batch, with two bounded requests at a time. Each batch is checked for exact scene coverage and checkpointed. Restarting after one failed batch retains completed batches; cancellation stops scheduling further batches. Apartment layout synthesis follows the combined evidence, instead of requiring a single response to describe 100 panoramas and draw the layout.
- Focused geometry repair attaches representative photographs from each known room and retains the complete per-photo transcript. Furnished image boards use room representatives so individual views are larger. A soft attachment budget never drops an identified room solely to meet the budget.
- The photo worker preserves validated reconstruction boundary hypotheses after its authoritative cloud commit. The plan worker can now inspect those hypotheses alongside photographs. Different components keep independent coordinate frames; stale image/camera/project checkpoints are rejected. These hypotheses are not surveyed walls or calibrated depth.
- Geometry checkpoints are keyed to the camera/geometry input; rendered checkpoints are keyed to their actual floor analysis. An old render cannot be silently reused for a changed layout.
- The administrator draft card explicitly identifies partial layouts and lists rooms whose geometry remains unresolved.
- Verified: 73 cloud tests, 19 worker tests, scoped lint, TypeScript/production build. An actual 12-photo batch completed with exact scene coverage in 57 seconds. An isolated 40-photo focused geometry probe completed in 150 seconds; it proposed only 5 located spaces and failed complete scene coverage. It was not published or accepted as a complete plan. These timings are measured examples, not a throughput guarantee.
- The previous full 100-image probe exceeded its eight-minute phase deadline. A scoped production repair completed in 450 seconds with all 100 scene IDs covered, 17 identified spaces and 7 placed room polygons. This remains a partial layout, not the complete apartment.
- Its rendering stage exposed image-tool failures reading 5.7–6.5 MB PNG evidence boards. The pipeline now creates bounded JPEG references (maximum 900 KB); the four actual boards were 436–562 KB and a sampled board loaded successfully through the image viewer. The failed rendering attempt was cancelled and resumed from its validated geometry cache, without reanalysing the 100 photographs. End-to-end furnished output still requires review.
- Fixed a stale polling error in the admin plan panel: successful status refreshes clear connection errors without clearing errors from a failed user action. Existing photographs, approved drawings and unrelated projects remain unchanged.


### Furnished render and room-click acceptance follow-up

- Job `95a9eea3-420d-49fd-986a-641d961ab7e3` reused checked geometry and completed the furnished rendering/review phase in 560,773 ms. The final PNG was inspected. It remains a **partial 7/17-space draft**, with unregistered cameras, unresolved connections and approximate proportions; it was saved privately, not approved or substituted into a published tour. This is not acceptance of the complete apartment.
- Both compact and full plan status now display the actual outcome, including counts for partial drafts, rather than calling every finished image ready. Status reads retrieve only draft layout metadata when determining completeness.
- Pointer navigation uses the actual floor/wall hit location to choose the closest eligible capture, rather than using screen-height heuristics when a surface hit exists. Missing direct graph edges do not prevent same-room selection. Wall clicks cannot leave the room. Floor exits retain reciprocal doorway-direction checks; unknown surfaces can only fall back to a forward capture in the same known room. One-sided semantic room IDs cannot merge rooms through a shared generic label. Calibrated depth retains its visibility checks.
- Validation: 467 core tests and 75 cloud tests passed. Read-only evaluation of the four existing tours (209 scenes) checked 8,684 positioned wall-hit pairs, with no cross-room wall destinations. This verifies the selector against stored room identities, not the correctness of every inferred room boundary or camera pose.
- A proposed service-only plan-status database projection could not be applied: the PostgreSQL management connection failed with resolver/connection errors. The active handler still uses the existing read path; no uninstalled RPC dependency is deployed. The unshipped SQL prototype is retained locally at `work/pending-plan-context.sql`. Existing tour payloads were not mutated by that attempt. A smaller database payload is **not** claimed as delivered.
- User confirmed no architectural drawing is available for this tour. Complete geometry recovery and reliable arbitrary 3D measurement remain unverified; successful tests or a furnished partial image do not establish platform-wide readiness.


### Sequential workflow and complete-geometry gate — 2026-09-22

- Studio now separates upload, per-photo inspection, spatial linking, plan review and sharing. Source snapshots bind completed inspection to scene ID, original image and floor. Editing a display-only retouch does not invalidate original evidence; replacing a source or changing its floor does. A completed worker task no longer displays its execution percentage as complete geometric coverage.
- The subscription worker now checks every photographed space, same-floor photo/audit coverage, valid nonoverlapping polygons, traversable doorway connectivity and unresolved audit issues before furnished rendering. Partial geometry triggers up to two checkpointed recovery reviews: targeted room/context photos, then every source photo. Reviews use increased reasoning and bounded 25-minute phase deadlines. Cached partial geometry no longer bypasses completeness checks. Cancellation is checked before launching another review, and shrinking the room inventory cannot silently make a proposal pass.
- Corrected evidence entries can repair missing or wrong-floor records. Changed reconstruction context invalidates cached reviews. Incomplete analysis is retained locally and leaves the existing plan intact. Rendered image audits must also be consistent; guide walls are continuous architectural strokes, with actual doorway gaps preserved.
- Broader per-camera matching and rectified panorama descriptors retain the existing geometric acceptance criteria. On the real 100-photo tour, global validation improved the shared frame from 72 to 93 photographs, accepted 242 image pairs, and left 7 unmatched. Runtime was 668.67 seconds including the first rectified-feature cache creation. Mean bearing error was 0.129 degrees; this is not a metric-accuracy claim.
- A real all-100-photo extended geometry review produced 17/17 placed spaces and 33 openings. Structural validation and photograph coverage passed, with one traversable access graph. Its audit still flags the identity of a secondary closed door and the relationship between glazed planting features; visual acceptance is ongoing. It has not been promoted to an approved architectural plan.
- Validation at this checkpoint: 481 core tests, 75 cloud tests, 27 quality/recovery tests, 25 Python geometry tests and 3 processing-evidence tests; scoped lint, TypeScript and production build passed. These checks do not certify 100% engineering accuracy or processing capacity for 100 concurrent projects.


### Complete interior draft and closed-door rendering — 2026-09-22

- Initial global layout synthesis now attaches every source panorama board with the full completed per-photo transcript, using a bounded 25-minute reasoning phase. On the actual 100-photo tour, the all-photo recovery completed in 1,268,958 ms and proposed 17/17 interior spaces and 33 observed openings. This is an estimated interior layout, not a surveyed exterior contour or a metric guarantee.
- A separate 164-second final audit reviewed the corrected guide and 19 targeted panorama boards, plus the inherited complete 100-photo evidence. It found no additional contradictory or missing photographed access route. Closed secondary-door identity, reflective planting-feature depth and concealed exterior contour remain explicit limitations. Original audits and the exact fresh-versus-inherited review scope are retained locally. Geometry and all 100 per-photo evidence records were unchanged by that audit.
- Opening masks now cut only their declared room hosts. Unknown door destinations remain closed leaves with backing walls in the furnishing guide; adjacent parallel walls cannot be accidentally erased into a false passage. Confirmed shared doors remain open. The render checkpoint version changed so an older guide rendering cannot bypass this correction.
- The exact-source reviewed analysis was saved to the local checkpoint with previous checkpoint backups. This did not alter the cloud tour, source photographs, existing furnished image or approved plan. Furnished rendering and fresh production camera processing still require end-to-end acceptance.
- Verification: 483 core tests, 75 cloud tests, 27 quality/recovery tests, scoped ESLint, TypeScript and production build passed.


### Workflow races, independent image audit and optional dense matching

- Same-photo workflow retries now enqueue a fresh plan instead of reusing a known partial draft. An active same-source plan blocks restarting photo geometry until it finishes or is cancelled. New uploads invalidate only the matching obsolete plan ID/input hash. The plan worker checks camera-state freshness and active photo processing before upload and finish. Existing scoped RPCs are used; no new database dependency was assumed installed.
- A separate post-generation image audit checks the PNG against the guide and source evidence, including room topology, openings, label anchors, camera claims and absence of baked-in text. The rendered checkpoint binds that audit to SHA-256 of the exact PNG bytes and the geometry context. This remains model review of an estimated draft, not metric ground-truth validation.
- Door destination and observed leaf state are now independent fields. Only explicitly observed closed leaves are drawn closed by the furnishing-guide policy; unknown or exterior destinations do not imply closed doors. Existing stored layouts remain valid.
- Optional offline LoFTR correspondence recovery is isolated from the ordinary reconstruction runtime. It has bounded candidate count, GPU memory checks, local checksum-verified weights, content/runtime-bound cache, parent heartbeat and subprocess deadline. Missing capability falls back to the existing sparse geometry without fabricating edges or downloading at runtime.
- Full 100-photo local run with dense matching took 593.31 seconds and retained 95 camera positions. A discovered reversed-bearing optimizer stationary point was reproduced synthetically and corrected only in the unresolved initialization nullspace, preserving baseline ratios and acceptance thresholds. Exact final-graph revalidation retained 245 edges and 96 cameras, median bearing error 0.12795 degrees. Four photographs (zero-based 7,8,59,60) remain unmatched. This remains relative/topology-only reconstruction.
- Verification: 484 core tests, 80 cloud tests, 30 quality/recovery/render-integrity tests, 30 reconstruction tests and 12 isolated dense-helper tests passed; TypeScript, scoped lint and production build passed. A fresh production workflow was queued to confirm the complete worker/UI path; that end-to-end outcome is recorded below only after completion.
