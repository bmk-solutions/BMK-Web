# Furnished plans using the owner's ChatGPT subscription

The web button queues a private job for that tour in the isolated IMO 3D Supabase project. A local Node worker runs the installed Codex CLI with the owner's existing ChatGPT sign-in. No OpenAI Platform API key is used. Images are sent to OpenAI; this is locally orchestrated cloud inference, not offline inference.

Run `Start-IMO3D-Plan-Worker.ps1` from this repository. The worker runs hidden until stopped or the computer shuts down. After reboot, start it again. Keep the device awake and connected. There is no promise of unlimited capacity: subscription usage limits, sign-in expiration and provider availability apply. No account upgrade, scheduled task, global settings or system startup modification is performed.

Prerequisites: Node, the installed Codex CLI supporting image generation, ChatGPT sign-in, and the private `.env.cloud.local` for this IMO 3D instance. CLI auth stays on the computer; database/session/API secrets are filtered out of the model subprocess environment. The worker has only this job's derived images in its task directory, attaches those images directly, ignores user Codex config, disables apps/plugins/in-app browser, uses a read-only sandbox and prohibits shell/browser/API actions. It never supplies server credentials in prompts.

1. Upload all 2–100 panoramas, then press **تحليل الصور وإنشاء مخطط**. Upload batches do not themselves trigger subscription work.
2. The worker attaches a six-view evidence sheet for every scene to GPT-6 Astra with xhigh reasoning. A schema validates complete scene/floor coverage, room geometry and openings. A result classified as topology-only or insufficient stops before image generation: a connected room diagram is not recovered apartment geometry. The model's image-supported classification is still a judgment requiring review, not a geometric certificate. No fixed Al Hamra room template is reused.
3. Image generation uses the floor's guide and four evidence boards, within the tool's five-reference limit. The bitmap contains furnishings but no room text. The review returns names and anchors against the final bitmap.
4. The result is a separate private draft. Names are an editable layer; saving names creates another draft referencing the same immutable base image.
5. A separate administrator action selects the reviewed image for the tour. It snapshots the rendered names into an immutable PNG and updates only that floor's viewer reference, with a concurrency check. It does not publish a private tour. Raster navigation registration is not automatically invented for a newly generated image. Quality-held test drafts cannot be renamed or selected for the viewer.

Jobs are claimed atomically, leased, cancellable and bound to the exact scene set. On disconnect, invalid output or changed images they fail closed. There is no automatic credit-consuming retry. Final draft rows and completion status commit atomically; approved viewer references are not modified. The existing viewer keeps its registered plan while generation is in progress.

Artifacts and event traces are under ignored `work/subscription-plans/<jobId>`. Prompts, validated analysis, guide, generated PNG and review remain available for diagnosis. Generated output paths must be fresh files under Codex's image-generation directory before copying into the project. No source images, old drafts or other cloud projects are deleted.

Photo analysis and visual review do not establish survey accuracy. Missing overlap, unseen boundaries or ambiguous doors remain limitations. Furniture and geometry must be reviewed before using a draft as the published plan.

## Acceptance status — 15 September 2026

The Al Hamra pilot exercised all 40 photos and successfully generated and stored a furnished image, but its schematic room placement was wrong. That test draft is quality-held and cannot be selected. A second run using explicit GPT-6 Astra xhigh identified the eight spaces and their connections but returned topology-only with no supported room polygons; the worker correctly stopped with `GEOMETRY_UNRESOLVED`. The original tour and previous drafts remained unchanged. Queue, authorization, rendering, name editing and deployment checks passed, but automatic recovery of a satisfactory apartment footprint has **not** passed acceptance. Do not advertise this pipeline as a reliable substitute for architectural reconstruction, or bypass the geometry gate to manufacture a successful demonstration.
