@AGENTS.md
# BMK / IMO 3D — Claude Code handover

Prepared 2026-09-24. Read this file, `docs/HANDOVER.md`, `docs/SETUP.md` and `docs/DESIGN.md` before editing. This handover changes documentation only. The active repository is `C:\Users\MiEXCITE\Desktop\5 - BMK.IMO 3D\BMK-Web`, not its former OneDrive copy.

## Project purpose

This repository contains BMK Solutions' bilingual marketing website and **IMO 3D**, an Arabic-first platform for developers, projects, apartment tours, 360-degree panoramas, room/navigation relationships, furnished floorplan drafts, measurements, hotspots, branding and enquiries. Next.js on Vercel serves the administration/public viewer/API; a dedicated Supabase project stores production data, private media and jobs; Windows device workers perform reconstruction and Gemini floorplan generation. The owner's target is a smooth Biganto/Realsee-like experience across 100+ different projects. That is the product target, not a claim that current reconstruction accuracy or performance meets it.

## Mandatory rules

1. **Do not change design, interfaces, icons, layouts or user-facing behavior, or refactor/restructure code without an explicit request.** Preserve the CSS cascade. The handover task authorizes documentation and packaging only.
2. Preserve Arabic/RTL, mobile touch controls, responsive layouts and accessibility. The marketing website supports EN/AR and light/dark themes. IMO3D is Arabic-first and not fully translated into English.
3. Never modify/delete data or settings in unrelated Vercel, Supabase or GitHub projects. Never reset production or blindly rerun migrations. Scope every mutation by project/tour, revision, input fingerprint and worker lease.
4. Preserve original panoramas, approved plans and manual edits. AI results remain reviewable drafts; do not publish incomplete geometry or overwrite approved data to make a job appear successful.
5. Generated pixels, inferred geometry and surveyed measurements are distinct. Never claim 95–100% accuracy without physical validation. The owner measured capture height as **1.27 m** for the reported setup; other captures may differ.
6. Push/deploy only when explicitly requested for the work being done. Do not relink Vercel projects, change production integrations or create a new paid service merely to simplify setup.
7. Never put real secrets in source, screenshots, chat, logs or public environment variables. Gemini is stored with Windows current-user DPAPI. Never print the credential bridge's private-pipe output.
8. Preserve exact photo-ID coverage, cancellation, freshness checks, independent image audit and repair bounds. Do not silently omit photos, invent doorways, cross walls or reuse Hamra's apartment geometry for another project.
9. Shared features apply to all projects, but each project needs its own source evidence and layout. Historical `subscription_*` table/component names do not mean the active floorplan provider is still ChatGPT; it is Gemini.
10. Follow `AGENTS.md`: read installed `node_modules/next/dist/docs/` before changing Next code. Older README/setup claims are historical where they conflict with this handover.
11. The private ZIP includes `.env` files, local data and Git history. Never upload it to GitHub, public storage or static deployment assets. Browser sessions and machine-specific credentials are not portable configuration.

## Technologies

Languages: TypeScript/TSX, JavaScript, CSS, Python, PowerShell and PostgreSQL SQL. Node's built-in `node:sqlite` supports the local adapter; cloud persistence uses scoped Supabase REST/RPC rather than a Supabase JS SDK.

Observed runtime baseline: Node **24.19.0**, npm **10.9.2**, Python **3.12.14**, PowerShell **7.6.5**, Git **2.53.0.windows.3**. Package engine requires Node >=24. Use the exact baseline first; do not silently upgrade dependencies. Exact locked npm packages are listed below in the generated appendix. Python pins are in SETUP.md and `scripts/*requirements*.txt`.

## Exact commands from repository root

```powershell
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3000
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
npm run lint
npx tsc --noEmit
npm run test:imo3d
node scripts/test-imo3d-gemini.mjs
node scripts/test-imo3d-plan-quality.mjs
node scripts/test-imo3d-cloud-routes.mjs
node scripts/test-imo3d-engine.mjs
node --test tests/imo3d-local-credentials.test.mjs tests/imo3d-cloud-worker.test.mjs tests/imo3d-cloud-upload.test.mjs tests/imo3d-worker-runtime.test.mjs tests/imo3d-supervision.test.mjs
```

`npm test` is not defined. `test:imo3d` is the npm test command. Standalone tests also exist under `tests/`; inspect their input requirements before invoking evaluators on real tours. Use a separate build output or stop a dev server before building into the same `.next` directory.

`.env.cloud.local` is NOT a Next auto-loaded filename. To deliberately run against cloud settings:

```powershell
node --env-file=.env.cloud.local node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3000
```

This accesses real cloud data; ordinary isolated local development should use `IMO3D_CLOUD=0` and a separate data directory. Do not overwrite private env files with the empty `.env.example`.

Read-only worker checks:

```powershell
node --env-file=.env.cloud.local scripts/imo3d-cloud-worker.mjs --check
node scripts/imo3d-subscription-worker.mjs --check
node scripts/imo3d-subscription-worker.mjs --check-credentials
node scripts/check-imo3d-gemini-connection.mjs
```

Deliberate startup after transfer/cutover (these consume queued work):

```powershell
# Two separate terminals, only one instance of each role:
node scripts/imo3d-device-supervisor.mjs photos
node scripts/imo3d-device-supervisor.mjs plans
```

Supervisors load `.env.cloud.local` for children. The old root `Start-IMO3D-Plan-Worker.ps1` still requires Codex; use the documented supervisor for Gemini. No worker is started by merely reading this handover.

## Folder and important-file map

| Path | Responsibility |
|---|---|
| `src/app/layout.tsx`, `globals.css` | Metadata, RTL root, global fonts/themes and marketing CSS |
| `src/app/page.tsx`, about/contact/services/packages/legal routes | Public BMK marketing pages |
| `src/content/frags.ts`, `src/components/Frag.tsx` | Prebuilt marketing HTML fragments rendered on server; not disposable generated output |
| `public/assets/js/site.js`, `WebsiteChrome.tsx` | Marketing interactions/language/theme; excludes marketing chrome from IMO3D |
| `src/app/imo3d/page.tsx`, `layout.tsx`, `imo3d.css` | Studio entry and shared styling |
| `src/app/imo3d/t/[id]/page.tsx` | Public published tour or authorized preview |
| `src/app/imo3d/api/page.tsx`, `connect-chatgpt/page.tsx` | API guide and optional ChatGPT authorization |
| `src/app/api/imo3d/[...path]/route.ts` | Main router; local/cloud adapter selection and authorization |
| `src/app/api/imo3d/` | Specialized plan, OAuth and MCP endpoints |
| `src/components/imo3d/Studio.tsx` | Login, dashboard/editor, upload, workflow progress, project/tour administration |
| `TourViewer.tsx`, `PanoramaEngine.ts`, `PanoramaMotion.ts`, `PanoramaBlobCache.ts` | Viewer state, Three.js panorama rendering, motion and media cache |
| `AIPlanPanel.tsx`, `ChatGPTDrafts.tsx` | Gemini queue/status and private plan drafts; historical component name retained |
| `FloorPlan*`, `RasterPlanMap`, `CompactApartmentMap`, `ViewerFloorPlan` | Vector/raster/3D plans, current location/heading and export |
| `ArchitecturalPlanEditor`, `ApartmentPlanEditor`, `ArchitectureReviewControls` | Manual walls/doors/room geometry and review |
| `ManualLinkEditor`, `RoomEntryViewEditor`, `SemanticRoomsEditor` | Link overrides, view orientation and room names |
| `HotspotEditor`, `HotspotOverlay`, `PhotoEditPanel` | Anchored content and reviewable AI image retouch |
| `Measurement*`, `PanoramaMeasurementControls` | Ruler interaction, units, local persistence, hide/delete/calibration |
| `DeveloperDirectory`, `ManagementDialogs`, `BrandingEditor`, `LeadInbox`, `AdminSettings` | Hierarchy, deletion/editing, branding, enquiries and password settings |
| `src/lib/imo3d/model.ts` | Central schemas/types and tour/scene payload model |
| `src/lib/imo3d/cloud/` | Production auth, scoped REST/RPC, uploads/assets/jobs/integrations |
| `src/lib/imo3d/store.ts`, `auth.ts` | Local SQLite/auth adapter; not production persistence |
| `navigation.ts`, `connection-*`, `floor-boundaries.ts` | Destination selection, links and doorway/room constraints |
| `measurement*.ts`, `panorama-measurement.ts`, `estimated-measurement.ts`, `surface-model*` | Scale/projection and estimated floor/vertical/surface geometry |
| `reconstruction.ts`, `joint-depth.ts`, `depth-architecture.ts`, `room-analysis.ts` | Node orchestration of Python processing |
| `subscription-plan-worker.ts`, `gemini-plan-provider.ts`, `gemini-transport.ts` | Queue claims/checkpoints and private Google analysis/render/review |
| `plan-quality`, `plan-recovery`, `plan-render-integrity`, `plan-registration`, `plan-image-review` | Coverage, correction, image identity/freshness and audit gates |
| `photo-edit-worker.ts`, `openai-floorplan-pipeline.ts` | Separate Codex retouch workflow and older local OpenAI plan path |
| `scripts/` | Worker/credential/model setup, tests, migration helpers and evaluations |
| `supabase/migrations/` | Ordered schema/RPC history; existing production already migrated |
| `tests/`, `tests/fixtures/` | TS/JS/Python/PowerShell tests and synthetic fixtures |
| `public/` | Brand, marketing media, tours, optimized images; private examples under ignored `public/imo3d/` |
| `.imo3d-data/` | Ignored local SQLite, originals/derivatives, analysis artifacts; not fresh cloud backup |
| `work/` | Private model runtimes/weights, source caches, job outputs, audit logs and deployment helpers; do not treat entire directory as disposable |
| `.git/`, `.vercel/`, `.claude/` | History, project association, assistant settings; some settings are machine-dependent |
| `.env.cloud.local`, `.env.local`, `.env.example` | Private runtime settings and blank public template |
| `package*.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs` | Dependency lock and tooling configuration |
| `docs/` | Handover, operations and dated audits; newest verified state takes precedence |

The generated appendix lists the actual tracked source/routes/scripts for discovery. Start with HANDOVER's unresolved issues, then SETUP's non-mutating checks. Successful imports/tests are not proof of live geometry accuracy.

## Exact npm lockfile versions

| Package | Version |
|---|---|
| `clsx` | `2.1.1` |
| `lenis` | `1.3.23` |
| `motion` | `12.40.0` |
| `next` | `16.2.7` |
| `react` | `19.2.4` |
| `react-dom` | `19.2.4` |
| `sharp` | `0.34.3` |
| `three` | `0.180.0` |
| `zod` | `4.1.5` |
| `@tailwindcss/postcss` | `4.3.0` |
| `@types/node` | `24.13.3` |
| `@types/react` | `19.2.17` |
| `@types/react-dom` | `19.2.3` |
| `@types/three` | `0.180.0` |
| `eslint` | `9.39.4` |
| `eslint-config-next` | `16.2.7` |
| `tailwindcss` | `4.3.0` |
| `typescript` | `5.9.3` |

## Source file inventory

All paths below are relative to the repository root; parent-folder responsibilities are described above. Filename families describe their focused behavior, and similarly named tests verify those modules.

### `src/app`

```text
src/app/.well-known/oauth-authorization-server/route.ts
src/app/.well-known/oauth-protected-resource/route.ts
src/app/about/page.tsx
src/app/api/imo3d/[...path]/route.ts
src/app/api/imo3d/branding-assets/[id]/route.ts
src/app/api/imo3d/developers/[[...id]]/route.ts
src/app/api/imo3d/projects/[id]/branding/route.ts
src/app/api/imo3d/projects/[id]/keys/route.ts
src/app/api/imo3d/projects/[id]/route.ts
src/app/api/imo3d/projects/[id]/usage/route.ts
src/app/api/imo3d/tours/[id]/ai-plan/image/route.ts
src/app/api/imo3d/tours/[id]/ai-plan/route.ts
src/app/api/imo3d/tours/[id]/architecture/route.ts
src/app/api/imo3d/tours/[id]/boundaries/route.ts
src/app/api/imo3d/tours/[id]/connections/route.ts
src/app/api/imo3d/tours/[id]/route.ts
src/app/api/imo3d/tours/[id]/scenes/[sceneId]/route.ts
src/app/api/imo3d-chatgpt/[action]/route.ts
src/app/contact/page.tsx
src/app/globals.css
src/app/icon.svg
src/app/imo3d/api/page.tsx
src/app/imo3d/connect-chatgpt/page.tsx
src/app/imo3d/imo3d.css
src/app/imo3d/layout.tsx
src/app/imo3d/page.tsx
src/app/imo3d/t/[id]/page.tsx
src/app/layout.tsx
src/app/packages/page.tsx
src/app/page.tsx
src/app/privacy/page.tsx
src/app/refund-policy/page.tsx
src/app/robots.ts
src/app/services/page.tsx
src/app/sitemap.ts
src/app/terms/page.tsx
```

### `src/components`

```text
src/components/Frag.tsx
src/components/imo3d/AdminSettings.tsx
src/components/imo3d/AIPlanPanel.tsx
src/components/imo3d/apartment-plan-editor.css
src/components/imo3d/ApartmentPlanEditor.tsx
src/components/imo3d/architectural-editor.css
src/components/imo3d/architectural-plan.css
src/components/imo3d/ArchitecturalModel3D.tsx
src/components/imo3d/ArchitecturalPlanEditor.tsx
src/components/imo3d/ArchitecturalPlanView.tsx
src/components/imo3d/ArchitectureReviewControls.tsx
src/components/imo3d/brand-logo.css
src/components/imo3d/branding.css
src/components/imo3d/BrandingEditor.tsx
src/components/imo3d/BrandLogo.tsx
src/components/imo3d/ChatGPTDrafts.tsx
src/components/imo3d/ChatGPTSettings.tsx
src/components/imo3d/client.ts
src/components/imo3d/compact-apartment-map.css
src/components/imo3d/CompactApartmentMap.tsx
src/components/imo3d/DeveloperDirectory.tsx
src/components/imo3d/Dialog.tsx
src/components/imo3d/floorplan-doorways.ts
src/components/imo3d/floorplan-download.ts
src/components/imo3d/floorplan-export-controls.css
src/components/imo3d/floorplan-geometry.ts
src/components/imo3d/floorplan-mesh-download.ts
src/components/imo3d/floorplan-pointer.ts
src/components/imo3d/floorplan-selection.ts
src/components/imo3d/floorplan.css
src/components/imo3d/FloorPlan.tsx
src/components/imo3d/floorplan3d-geometry.ts
src/components/imo3d/floorplan3d.css
src/components/imo3d/FloorPlan3D.tsx
src/components/imo3d/FloorPlan3DRenderer.ts
src/components/imo3d/FloorPlanExportControls.tsx
src/components/imo3d/FloorSelector.tsx
src/components/imo3d/HotspotEditor.tsx
src/components/imo3d/HotspotOverlay.tsx
src/components/imo3d/hotspots.css
src/components/imo3d/Icon.tsx
src/components/imo3d/integration-keys.css
src/components/imo3d/IntegrationKeys.tsx
src/components/imo3d/interactive-floorplan.css
src/components/imo3d/InteractiveFloorPlan.tsx
src/components/imo3d/LeadInbox.tsx
src/components/imo3d/liquid-glass.css
src/components/imo3d/logo-pixels.ts
src/components/imo3d/ManagementDialogs.tsx
src/components/imo3d/manual-links.css
src/components/imo3d/ManualLinkEditor.tsx
src/components/imo3d/measurement-scale-panel.css
src/components/imo3d/measurement.css
src/components/imo3d/MeasurementDialog.tsx
src/components/imo3d/MeasurementNotebook.tsx
src/components/imo3d/MeasurementScalePanel.tsx
src/components/imo3d/MeasurementUnitPicker.tsx
src/components/imo3d/panorama-measurement.css
src/components/imo3d/panorama-upload.ts
src/components/imo3d/PanoramaBlobCache.ts
src/components/imo3d/PanoramaEngine.ts
src/components/imo3d/PanoramaMeasurementControls.tsx
src/components/imo3d/PanoramaMotion.ts
src/components/imo3d/PanoramaPlacement.tsx
src/components/imo3d/PanoramaQuality.ts
src/components/imo3d/password-input.css
src/components/imo3d/PasswordInput.tsx
src/components/imo3d/PhotoEditPanel.tsx
src/components/imo3d/PhotographicFloorModel.ts
src/components/imo3d/PlanRoomNames.tsx
src/components/imo3d/project-usage.css
src/components/imo3d/ProjectUsageDialog.tsx
src/components/imo3d/raster-navigation.ts
src/components/imo3d/RasterPlanMap.tsx
src/components/imo3d/room-entry-view.css
src/components/imo3d/room-functions.css
src/components/imo3d/room-labels.ts
src/components/imo3d/RoomEntryViewEditor.tsx
src/components/imo3d/semantic-rooms-editor.css
src/components/imo3d/SemanticRoomsEditor.tsx
src/components/imo3d/studio-workflows.css
src/components/imo3d/Studio.tsx
src/components/imo3d/TexturedApartmentModel.ts
src/components/imo3d/TourPreviewDialog.tsx
src/components/imo3d/TourViewer.tsx
src/components/imo3d/viewer-clean.css
src/components/imo3d/viewer-floorplan.css
src/components/imo3d/viewer-mobile.css
src/components/imo3d/viewer-plan-cache.ts
src/components/imo3d/viewer-presentation.css
src/components/imo3d/ViewerFloorPlan.tsx
src/components/WebsiteChrome.tsx
```

### `src/lib`

```text
src/lib/imo3d/admin-password.ts
src/lib/imo3d/ai-plan-jobs.ts
src/lib/imo3d/ai-plan-launcher.ts
src/lib/imo3d/architecture-storage.ts
src/lib/imo3d/architecture-visibility.ts
src/lib/imo3d/architecture.ts
src/lib/imo3d/auth.ts
src/lib/imo3d/boundary-shapes.ts
src/lib/imo3d/branding-policy.ts
src/lib/imo3d/branding.ts
src/lib/imo3d/cloud/auth.ts
src/lib/imo3d/cloud/branding-uploads.ts
src/lib/imo3d/cloud/chatgpt-auth.ts
src/lib/imo3d/cloud/chatgpt-mcp.ts
src/lib/imo3d/cloud/client.ts
src/lib/imo3d/cloud/geometry.ts
src/lib/imo3d/cloud/handlers.ts
src/lib/imo3d/cloud/hotspot-media.ts
src/lib/imo3d/cloud/http.ts
src/lib/imo3d/cloud/jobs.ts
src/lib/imo3d/cloud/management.ts
src/lib/imo3d/cloud/media.ts
src/lib/imo3d/cloud/photo-edits.ts
src/lib/imo3d/cloud/repository.ts
src/lib/imo3d/cloud/subscription-plans.ts
src/lib/imo3d/cloud/types.ts
src/lib/imo3d/cloud/upload-policy.ts
src/lib/imo3d/cloud/uploads.ts
src/lib/imo3d/connection-editing.ts
src/lib/imo3d/connection-overrides.ts
src/lib/imo3d/connection-storage.ts
src/lib/imo3d/depth-architecture.ts
src/lib/imo3d/developer-management.ts
src/lib/imo3d/display-depth.ts
src/lib/imo3d/estimated-measurement.ts
src/lib/imo3d/example.json
src/lib/imo3d/floor-assignment.ts
src/lib/imo3d/floor-boundaries.ts
src/lib/imo3d/floorplan-export.ts
src/lib/imo3d/furnished-plan.ts
src/lib/imo3d/gemini-plan-provider.ts
src/lib/imo3d/gemini-transport.ts
src/lib/imo3d/hotspots.ts
src/lib/imo3d/integrations.ts
src/lib/imo3d/joint-depth.ts
src/lib/imo3d/joint-geometry-evidence.ts
src/lib/imo3d/lead-query.ts
src/lib/imo3d/lead-validation.ts
src/lib/imo3d/management-request.ts
src/lib/imo3d/measurement-notebook.ts
src/lib/imo3d/measurement-projection.ts
src/lib/imo3d/measurement-units.ts
src/lib/imo3d/measurement.ts
src/lib/imo3d/mesh-model.ts
src/lib/imo3d/model.ts
src/lib/imo3d/navigation.ts
src/lib/imo3d/openai-floorplan-pipeline.ts
src/lib/imo3d/panorama-measurement.ts
src/lib/imo3d/photo-edit-projection.ts
src/lib/imo3d/photo-edit-worker.ts
src/lib/imo3d/photo-edits.ts
src/lib/imo3d/plan-checkpoints.ts
src/lib/imo3d/plan-image-review.ts
src/lib/imo3d/plan-labels.ts
src/lib/imo3d/plan-quality.ts
src/lib/imo3d/plan-recovery.ts
src/lib/imo3d/plan-registration.ts
src/lib/imo3d/plan-render-integrity.ts
src/lib/imo3d/plan-spatial-evidence.ts
src/lib/imo3d/private-asset-cleanup.ts
src/lib/imo3d/private-example.ts
src/lib/imo3d/processing-cleanup.ts
src/lib/imo3d/processing-jobs.ts
src/lib/imo3d/processing-launcher.ts
src/lib/imo3d/processing-model.ts
src/lib/imo3d/project-management.ts
src/lib/imo3d/project-usage.ts
src/lib/imo3d/reconstruction-layout.ts
src/lib/imo3d/reconstruction.ts
src/lib/imo3d/room-analysis.ts
src/lib/imo3d/room-semantics.ts
src/lib/imo3d/scene-deletion.ts
src/lib/imo3d/scene-removal.ts
src/lib/imo3d/spatial.ts
src/lib/imo3d/store.ts
src/lib/imo3d/subscription-plan-worker.ts
src/lib/imo3d/surface-model-cleanup.ts
src/lib/imo3d/surface-model.ts
src/lib/imo3d/tour-merge.ts
src/lib/imo3d/usage-estimate.ts
src/lib/imo3d/view-presentation.ts
```

### `src/content`

```text
src/content/_chrome.html
src/content/_footer.html
src/content/_header.html
src/content/about.html
src/content/ai-reports.html
src/content/banner-about.html
src/content/banner-packages.html
src/content/banner-services.html
src/content/beneficiaries.html
src/content/clients.html
src/content/contact-page.html
src/content/cta.html
src/content/deliverables.html
src/content/faq.html
src/content/footer.html
src/content/frags.ts
src/content/header.html
src/content/hero.html
src/content/how-we-work.html
src/content/marquee.html
src/content/packages.html
src/content/platform.html
src/content/positioning-about.html
src/content/preloader.html
src/content/privacy.html
src/content/project-lifecycle.html
src/content/refund-policy.html
src/content/scroll-video-showreel.html
src/content/selected-work.html
src/content/services-teaser.html
src/content/terms.html
src/content/the-six-services-accordion.html
src/content/value-7-types.html
src/content/vision-mission.html
```

### `scripts`

```text
scripts/brand-assets.mjs
scripts/check-imo3d-gemini-connection.mjs
scripts/imo3d-ai-plan-worker.mjs
scripts/imo3d-align-al-hamra-room-labels.mjs
scripts/imo3d-approximate-plan.py
scripts/imo3d-argus-preflight.py
scripts/imo3d-attach-draft.mjs
scripts/imo3d-boundary-evaluate.py
scripts/imo3d-bundle-adjust.md
scripts/imo3d-bundle-adjust.py
scripts/imo3d-candidate-preview.mjs
scripts/imo3d-cloud-preflight.mjs
scripts/imo3d-cloud-worker.mjs
scripts/imo3d-dense-matching.md
scripts/imo3d-dense-matching.py
scripts/imo3d-depth-architecture.py
scripts/imo3d-device-supervisor.mjs
scripts/imo3d-draft-contact-sheets.mjs
scripts/imo3d-export-cloud.mjs
scripts/imo3d-glb-pack.py
scripts/imo3d-horizon-layout.py
scripts/imo3d-import-cloud.mjs
scripts/imo3d-import-image-draft.mjs
scripts/imo3d-joint-depth-artifacts.json
scripts/imo3d-joint-depth.py
scripts/imo3d-local-credential-bridge.ps1
scripts/imo3d-photo-depth.py
scripts/imo3d-pose-refinement-evaluate.py
scripts/imo3d-preview.mjs
scripts/imo3d-private-credentials.md
scripts/imo3d-reconstruction-evaluate.mjs
scripts/imo3d-reconstruction-requirements.txt
scripts/imo3d-reconstruction.md
scripts/imo3d-reconstruction.py
scripts/imo3d-register-al-hamra-draft.mjs
scripts/imo3d-room-envelope.py
scripts/imo3d-room-vision-requirements.txt
scripts/imo3d-room-vision.py
scripts/imo3d-runtime-check.py
scripts/imo3d-subscription-worker.mjs
scripts/imo3d-verify-gpu.py
scripts/imo3d-wall-fit.py
scripts/imo3d-worker.mjs
scripts/lib/imo3d-cloud-isolation.mjs
scripts/lib/imo3d-cloud-worker.mjs
scripts/lib/imo3d-local-credentials.mjs
scripts/lib/imo3d-local-credentials.psm1
scripts/lib/imo3d-processing-evidence.mjs
scripts/lib/imo3d-supervision.mjs
scripts/lib/imo3d-worker-runtime.mjs
scripts/optimize-media.mjs
scripts/requirements-imo3d-joint-depth.txt
scripts/setup-imo3d-gemini-credential.ps1
scripts/setup-imo3d-joint-depth.py
scripts/setup-imo3d-room-vision.py
scripts/shoot.mjs
scripts/start-imo3d-device-worker.ps1
scripts/test-imo3d-cloud-routes.mjs
scripts/test-imo3d-engine.mjs
scripts/test-imo3d-gemini.mjs
scripts/test-imo3d-plan-quality.mjs
scripts/test-imo3d-room-analysis-smoke.mjs
scripts/test-imo3d.mjs
```

### `supabase`

```text
supabase/migrations/20260913191500_imo3d_cloud.sql
supabase/migrations/20260913193000_imo3d_uploads.sql
supabase/migrations/20260913194500_imo3d_brand_uploads.sql
supabase/migrations/20260913195500_imo3d_upload_spatial.sql
supabase/migrations/20260914010000_imo3d_admin_credentials.sql
supabase/migrations/20260915010000_imo3d_chatgpt.sql
supabase/migrations/20260915110000_imo3d_subscription_plans.sql
supabase/migrations/20260915120000_imo3d_reviewed_plan.sql
supabase/migrations/20260921150000_imo3d_automatic_workflow.sql
supabase/migrations/20260921200000_imo3d_tour_summaries.sql
supabase/verification/imo3d_cloud_rollback_check.sql
```

### `tests`

```text
tests/fixtures/imo3d-synthetic-tour.ts
tests/imo3d-ai-plan-jobs.test.ts
tests/imo3d-approximate-plan.test.py
tests/imo3d-architecture-storage.test.ts
tests/imo3d-architecture.test.ts
tests/imo3d-boundaries.test.ts
tests/imo3d-branding.test.ts
tests/imo3d-bundle-adjust.test.py
tests/imo3d-cloud-client.test.mjs
tests/imo3d-cloud-export.test.mjs
tests/imo3d-cloud-import.test.mjs
tests/imo3d-cloud-preflight.test.mjs
tests/imo3d-cloud-routes.test.ts
tests/imo3d-cloud-upload.test.mjs
tests/imo3d-cloud-worker.test.mjs
tests/imo3d-connections.test.ts
tests/imo3d-dense-matching.test.py
tests/imo3d-depth-architecture.test.py
tests/imo3d-depth-architecture.test.ts
tests/imo3d-developers.test.ts
tests/imo3d-floor-assignment.test.ts
tests/imo3d-floorplan-doorways.test.ts
tests/imo3d-floorplan-download.test.ts
tests/imo3d-floorplan-export.test.ts
tests/imo3d-floorplan-pointer.test.ts
tests/imo3d-floorplan-selection.test.ts
tests/imo3d-floorplan.test.ts
tests/imo3d-floorplan3d.test.ts
tests/imo3d-gemini-connection.test.mjs
tests/imo3d-gemini-plan-provider.test.ts
tests/imo3d-gemini-transport.test.ts
tests/imo3d-glb-pack.test.py
tests/imo3d-hotspots.test.ts
tests/imo3d-integrations.test.ts
tests/imo3d-joint-depth.test.ts
tests/imo3d-joint-geometry-evidence.test.ts
tests/imo3d-lead-query.test.ts
tests/imo3d-local-credentials.test.mjs
tests/imo3d-local-credentials.test.ps1
tests/imo3d-logo-pixels.test.ts
tests/imo3d-measurement-notebook.test.ts
tests/imo3d-measurement-projection.test.ts
tests/imo3d-measurement.test.ts
tests/imo3d-navigation.test.ts
tests/imo3d-openai-floorplan-pipeline.test.ts
tests/imo3d-panorama-measurement.test.ts
tests/imo3d-photo-depth.test.py
tests/imo3d-photographic-floor-model.test.ts
tests/imo3d-plan-image-review.test.ts
tests/imo3d-plan-output-schema.test.ts
tests/imo3d-plan-quality.test.ts
tests/imo3d-plan-recovery.test.ts
tests/imo3d-plan-registration.test.ts
tests/imo3d-plan-render-integrity.test.ts
tests/imo3d-pose-refinement.test.py
tests/imo3d-private-example.test.ts
tests/imo3d-private-reference.test.ts
tests/imo3d-processing-cleanup.test.ts
tests/imo3d-processing-coverage.test.ts
tests/imo3d-processing-evidence.test.mjs
tests/imo3d-processing-jobs.test.ts
tests/imo3d-project-management.test.ts
tests/imo3d-project-usage.test.ts
tests/imo3d-raster-navigation.test.ts
tests/imo3d-reconstruction-layout.test.ts
tests/imo3d-reconstruction-progress.test.ts
tests/imo3d-reconstruction.test.py
tests/imo3d-room-analysis.test.ts
tests/imo3d-room-envelope.test.py
tests/imo3d-room-semantics.test.ts
tests/imo3d-room-vision.test.py
tests/imo3d-scene-deletion.test.ts
tests/imo3d-spatial.test.ts
tests/imo3d-supervision.test.mjs
tests/imo3d-surface-model-cleanup.test.ts
tests/imo3d-surface-model.test.ts
tests/imo3d-tour-summary.test.ts
tests/imo3d-view-presentation.test.ts
tests/imo3d-wall-fit.test.py
tests/imo3d-worker-runtime.test.mjs
tests/imo3d-workflow-validation.test.ts
tests/test_imo3d_geometry_evidence.py
tests/test_imo3d_joint_depth.py
tests/test_setup_imo3d_joint_depth.py
```
