# IMO 3D — engineering handover

Prepared 2026-09-24. This is documentation and packaging, **not a new release or a claim of complete readiness**. No application code or cloud data is changed by this task. Historical checks below are dated evidence, not tests rerun today.

## Project identity

- Repository: https://github.com/bmk-solutions/BMK-Web.git ; branch `codex/imo3d-cloud`.
- Source commit at start: `cd25546`. New documentation commit: **Handover to Claude Code**; get its hash from `git log -1` after unpacking.
- Admin: https://bmk-imo3d.vercel.app/imo3d . Tours: `/imo3d/t/<id>`.
- Vercel: `bmk-imo3d`, `prj_Gwa7jEo6TC9imvtXDPJgkPl0AtKf`, team `beyttechbmk-5008s-projects`. Do not relink other projects.
- Dedicated Supabase ref: `xdjjrzzboxazrgcyfxxd`; private media and `imo3d_`-prefixed tables/RPCs.
- Last previously verified web deploy: `dpl_B4ESGLoRaJXG5PbHLY8Dbi415njB`, source `017934b`, READY on 2026-09-22. `cd25546` adds local-worker diagnostics/docs, not web behavior. No deployment is performed in this handover.
- Al Hamra reference: `6e8f6cef-d849-45c3-9a7f-0c4c6ce3e968`.
- Unresolved 100-photo acceptance case Al Awaly al marwa: `7eb13a95-ae87-4ba0-a39f-8a052e7848e1`.

## Implemented functionality and what “working” means

These shared components have prior source/test/browser evidence. They are not a blanket claim that every real apartment or provider request succeeds.

| Area | Delivered behavior | Boundary |
|---|---|---|
| Administration | Password login/change/show-hide, developers, projects, multiple tours, rename/delete, branding and usage | Auth/schema/management tests; no passwords in docs |
| Persistence | Async Supabase adapter, optimistic revisions, private storage, scoped authorization, signed URLs, draft isolation | Existing isolated production project; local SQLite is separate |
| Upload | Signed direct resumable uploads, finalization/validation, unchanged originals, viewing variants, progress/cancel | User's slow 100-image workflow remains a real performance acceptance concern |
| Automatic workflow | Upload completion starts photo processing and plan queue; durable jobs, heartbeat/leases, stale detection, cancellation | Photo jobs allow 2–300 scenes, automatic plan queue is currently capped at100 |
| Viewer | Panorama look/drag/touch/zoom/keyboard, preloading/cache, near/far picking, room/door constraints, heading cone and maps | Continuous Biganto-quality reconstructed walking is not proven |
| Presentation | Downward pitch restriction, mobile controls, transparent unit summary under map, optional price, custom entry direction, plan hide/expand | Shared project behavior; no permission for redesign in handover |
| Plans | Editable room/floor names, boundaries/doors, drafts, floor selection, raster/vector/3D/export when evidence supports it | Image generation does not imply complete architectural geometry |
| Measurements | m/cm/in/ft, floor/vertical/surface estimates, hide/show, selection/delete/clear, persistent local notebook | Previous wall-top estimate2.47m and hide/delete checked; no measured ground truth |
| Hotspots | Text, image, audio/video, link, scene/tour, product, alternative image and area labels; marker styling | Not volumetric video fusion or arbitrary 3D surface reconstruction |
| AI retouch | Selected-region/tripod removal, compare/approve/restore, original preservation | One real Hamra draft existed; separate photo editing still uses Codex, not Gemini |
| Gemini plans | Photo analysis, layout synthesis, furnished image generation, metadata review and independent audit | Mock verification passed; real generation blocked by Google quota/service failures |
| Integrations/leads | Project API keys, optional ChatGPT OAuth/MCP, lead inbox, share/embed | ChatGPT integration is separate from current Gemini plan generation |
| Marketing | BMK EN/AR pages, light/dark, media and contact composition | Old README architecture/font/static-hosting statements are partially obsolete |

## Known defects, incomplete work and blockers

1. **Google quota:** on2026-09-22 private authentication/model listing worked, but a tiny actual image-model request returned HTTP429 with quota **limit0**. Analysis probes returned503 or timeout. No real Gemini furnished plan was accepted/published. Recheck account quota/billing/model access; a heartbeat/key test is not a generation test. This is the last observed status, not a fresh account query on handover day.
2. **Incomplete geometry:** Al Awaly analysis covered100 photos and identified17 spaces, but only7 room polygons were placed. A partial7/17 furnished draft was saved privately, not approved. Later correction/review still found missing fresh photo coverage and furniture/geometry defects. Do not invent missing walls or copy Hamra geometry to pass review.
3. **Registration:** historical production milestones were72/100, later78 common-frame cameras,96 in local frames and4 unmatched. An isolated improved evaluation reached95 common-frame cameras; it was not verified as a completed production rerun. Counts are historical, not a fresh query.
4. **Measurements:** owner supplied floor-to-lens height1.27m. Planar/vertical estimates require assumptions. Arbitrary wall/door/ceiling measurements and95% accuracy remain unvalidated. Repeated user complaints concerned door height and wall length. Keep estimated/unsupported states honest; validate physically.
5. **Navigation:** far movement and room restrictions exist, but accurate continuous FPV-like parallax needs trustworthy poses/depth/occlusion. Crossfade/warping alone is not equivalent. Test same-room clicks on walls and travel through actual doors.
6. **Performance:** user reported75-minute upload, multi-hour total workflow,50–60-minute waits and failed drawing. Direct transfer, bounded batching, checkpoints, cached evidence and compact boards were added. No full-workflow latency SLA is established. Previous measured examples:12-photo analysis57s;40-photo focused probe150s;partial render561s. These are not guarantees.
7. **Scale:** SQL projections were tested with100projects×100scenes, not100 simultaneous reconstructions. One local device remains an availability/throughput bottleneck. No new paid server is authorized by handover.
8. **Count mismatch:** upload/photo workflow supports300 photos, automatic plan generation is capped at100. Product handling for larger tours needs explicit resolution. Cancelled jobs must stay cancelled.
9. **Startup:** plans scheduled task was disabled after owner chose manual worker-process startup instead of persistent ExecutionPolicy Bypass. Owner clarified that per-project generation must still run automatically after upload. These are different requirements. Last manual worker heartbeat was online2026-09-22; do not assume current online state. Photo task was unchanged.
10. **Portability:** runtime JSON contains absolute old paths; GPU/native packages may not match new hardware. DPAPI does not migrate by copying its encrypted blob. Browser-local measurement storage, unsaved edits and sessions do not travel with the repo. Root legacy worker launcher still expects Codex.
11. **Documentation drift:** README calls the app static and says no env needed; wrong for IMO3D. Older docs describe planned adapters or old providers. Prefer this handover, current source and `docs/gemini-transport.md`, while retaining historical records.
12. **Review gates:** automatic generation yields a draft. It must not silently approve uncertain geometry. Preserve originals/old approved plans when a new run fails.

Last known user-cancelled job: `95ad2746-de30-487c-b7ff-d47bbb96d8f4`. Do not restart it as a setup test.

## Technical decisions and reasons

- Vercel handles web/API; Supabase stores data/private assets/queue; long native Python/model tasks run on Windows. A deployed web app is not a permanent reconstruction worker.
- Signed direct uploads avoid sending large panoramas through Vercel function payload limits. Finalization validates ownership/format/size. Original media remain immutable.
- Transactional SQL RPCs, optimistic revisions, source fingerprints and leases preserve data isolation and prevent stale jobs overwriting edits.
- Per-photo analysis batches account for every ID; resume checkpoints avoid repeating successful expensive work. Render keys include provider/layout evidence to avoid pretending a cached Codex picture is a new Gemini output.
- Generated pixels, geometry hypotheses, camera registration and metric scale are kept distinct. Independent review and one bounded corrective render are intentional quality controls.
- Gemini was explicitly chosen after slow/unreliable subscription/Codex plan generation. Private Windows DPAPI callback supplies the key to a fixed official Google host. Separate Codex photo retouch/optional MCP remains.
- Hamra's shared interaction/features generalize, its apartment geometry does not. Each apartment needs its own analysis/layout.
- Measurements persist in tour-scoped browser localStorage. Hide does not delete; cross-device synchronization is not implemented merely by hosting the website.
- Marketing and IMO3D share a repository but separate routing/chrome. Do not disturb the marketing site during platform fixes.

## Next steps in order

1. Follow SETUP without deploying, importing or consuming production jobs. Verify archive integrity, runtime paths, private key entry and non-mutating preflight.
2. Resolve Google quota/billing with owner authorization, then perform one small bounded live request. Do not ask for the key in chat or enable new paid commitments silently.
3. Use a new authorized small test tour for full upload→photos/linking→layout→furnished image→independent review→private draft; record timings and failures. Preserve cancelled/approved existing work.
4. Finish real Al Awaly registration and geometry coverage, observe room/door/occlusion constraints, preserve uncertain states. Do not bypass audit gates.
5. Validate wall/door/ceiling measurements against measured references; quantify error, test point selection/hide/delete and persistence.
6. Verify mobile/desktop near/far movement, map cone/toggle, scene entry orientation, hotspots/password UX and cancellation.
7. Benchmark large interrupted uploads, retries, multi-project isolation, offline workers and >100-photo plan handling. Deploy only after owner asks and acceptance evidence exists.

## Summary of available prior sessions

- Began with BMK marketing site, then built IMO3D and used Al Hamra as the first apartment reference.
- Moved active code from OneDrive to Desktop and deployed a separate GitHub/Vercel/Supabase project, preserving unrelated projects/data.
- Added developer/project/tour hierarchy, passwords/settings, branding/leads, room/floor labels, entry directions, mobile controls and optional price.
- Studied Biganto/Beyonity movement/maps/measurement and authenticated Realsee hotspot/retouch UI. Full reference-quality reconstruction remains a target, not achieved parity.
- Iterated far/same-room/doorway navigation, cursor, preload, map direction/readability and unit details; added measurement units/persistence/delete/hide and owner-provided1.27m height.
- Explored layout/depth/room semantics/dense matching and manual architecture review. Preserved uncertainty rather than marking inference surveyed.
- Added durable cloud queues, direct private uploads, cancellation/leases, separate workers and lighter dashboard projections.
- Automated upload→analysis→linking→plan queue. Added bounded batches/checkpoints, small JPEG evidence boards and render integrity/correction after long failed attempts.
- Added hotspots and original-preserving regional retouch with compare/approve/restore.
- Added private Gemini key entry/authentication probe, switched cloud floorplan provider to Gemini and deployed UI. Actual image request met quota0; photo retouch provider remains separate.
- Owner chose manual process startup while requiring automatic per-upload generation.
-2026-09-24: documentation/full private archive requested, with no application code edits or cloud changes.

## Prior verification and limits

Recorded2026-09-22: Gemini30 tests, quality/recovery46, cloud routes80, credential loader4; TypeScript/scoped lint/build passed. Earlier records include489 core tests and geometry/helper suites. These are historical results, not rerun during documentation-only work. `docs/imo3d-readiness-audit-2026-09-21.md` contains evolving dated follow-ups. Live Gemini output and physical metric accuracy are still unverified.

## External files and transfer boundary

**هل يعتمد المشروع على أي ملفات خارج مجلده؟ نعم.** Node/Python/PowerShell executables are external; Gemini key is Windows user-bound; production data live in Supabase; Google Fonts are remote; four generated-image source files were found in Codex's external image directory. Those four are included under `handover-external-assets/` inside the ZIP, with mapping appended below. No whole user profile, browser session or plaintext Gemini key is exported.

Legacy source directory `C:/Users/Alkaz/OneDrive/Work/2- BMK Soutions` is missing here; optimized public assets are included. Historical image JSON paths are not rewritten. Developer must use the mapping without weakening path-validation boundaries.

The ZIP intentionally includes private `.env.local`, `.env.cloud.local`, `.git`, `.vercel`, work logs/caches/models and local photographs. It is an **unencrypted private ZIP**: transfer through owner-controlled encrypted storage/channel only. Never publish it. It is not a current complete remote Supabase backup.

## External image transfer mapping

| Original path | ZIP entry | Referencing local evidence |
|---|---|---|
| `C:\Users\MiEXCITE\.codex\generated_images\01a0a484-41d1-7641-a436-c451860b9eff\exec-ffd2382a-dbe4-4595-adfc-4a08577caa72.png` | `handover-external-assets/01-exec-ffd2382a-dbe4-4595-adfc-4a08577caa72.png` | `work\subscription-plans\a17358ba-9ef5-4e80-9ff6-42cecaa82a49\review-0.json` |
| `C:\Users\MiEXCITE\.codex\generated_images\01a0c897-1b1a-72a2-9102-09c64ae87939\exec-f1811bd4-09bf-4368-9400-821efcd632cf.png` | `handover-external-assets/02-exec-f1811bd4-09bf-4368-9400-821efcd632cf.png` | `work\subscription-plans\95a9eea3-420d-49fd-986a-641d961ab7e3\review-0.json`, `work\subscription-plan-cache\80e5af8a91a638e116e941c0fa2b5b9f88c2384ddeaf92060c76c44ee21f8262\render-v2-0-e809cc92fc296202.json` |
| `C:\Users\MiEXCITE\.codex\generated_images\01a0c938-5556-7c02-83b2-10f2fb8fb3d1\exec-093ff0a5-b852-4d81-952b-1428dc5247b4.png` | `handover-external-assets/03-exec-093ff0a5-b852-4d81-952b-1428dc5247b4.png` | `work\subscription-plans\a0971bec-fa02-4b01-b5d2-db0481a1f1a2\review-0.json`, `work\subscription-plan-cache\80e5af8a91a638e116e941c0fa2b5b9f88c2384ddeaf92060c76c44ee21f8262\render-v5-0-49360073623d81a1-candidate.json` |
| `C:\Users\MiEXCITE\.codex\generated_images\01a0c955-da62-7640-8dbe-8d836ca139b0\exec-9af999e0-1f0c-4a35-b86f-701ab1bc2886.png` | `handover-external-assets/04-exec-9af999e0-1f0c-4a35-b86f-701ab1bc2886.png` | `work\subscription-plans\6847ffbd-3f40-4e3e-a532-52310485fe29\repair-image-0.json` |

## Package layout

`BMK-Web/` contains the complete selected project files including hidden files and `.git`; `handover-external-assets/` contains the four external images; `handover-snapshots/` contains a consistent local SQLite backup; `handover-package-manifest.json` records counts, exclusions and source snapshot. Adjacent Desktop SHA-256/report validates the final ZIP.

Exclusions: directory names `node_modules`, `dist`, `build`, `.next`, `venv`, `.venv`, `__pycache__`, and `.next-*` at any depth. Other `work/` contents are retained rather than silently dropping photos, evidence, model weights or native runtime sources. Junctions/symlinks are recorded in a manifest and archived as link entries without traversing external targets; test junctions are not required at runtime. Do not blindly recreate old absolute junction targets on the new machine.
