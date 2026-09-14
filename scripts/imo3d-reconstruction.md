# IMO 3D image reconstruction worker

The worker processes the uploaded panorama pixels locally. Its input schema has
image IDs, image paths and floor assignments, with optional locally inferred
`roomProfiles` and `roomObservations`. It does not accept supplied camera
positions, original tour links, camera heights in metres, or a floor plan.
The worker first runs local boundary and semantic inference; see
`docs/imo3d/image-derived-floorplans.md` for the complete pipeline.

## Environment

Use a dedicated Python 3.12 or later environment with the packages pinned in
`imo3d-reconstruction-requirements.txt`. Set `IMO3D_PYTHON` to its executable and
`IMO3D_CV_PATH` to the installed package directory when using a target directory.
For local development, `work/reconstruction-runtime.json` can contain
`{"python":"...","cvPath":"..."}`. The web host should enqueue work; the separate
worker calls `runPanoramaReconstruction` from `src/lib/imo3d/reconstruction.ts`.
Do not expose a Python subprocess directly to an unauthenticated HTTP request.

The TypeScript wrapper validates real image paths against the allowed asset
directories, uses argument-array spawning without a shell, supports cancellation,
bounds worker logs, and enforces a processing timeout. Images and feature caches
remain in the private project data/work directories.

## Processing

1. Normalize each 2:1 panorama to at most 2048 × 1024 pixels. Extract RootSIFT
   features from an overlapping longitude strip, preserving panorama seams.
2. Match image descriptors, then reject candidates without a spherical essential
   matrix consensus. The essential matrix uses unit sphere rays; a pinhole
   projection and ordinary positive-Z cheirality would be wrong for full 360s.
3. Recover relative camera pose with positive radial depths. Reject pure rotation,
   insufficient parallax, ambiguous pose, narrow weak matches and inconsistent
   camera tilt. This pipeline assumes level cameras on each assigned floor.
4. Average camera yaw robustly. Shared feature tracks in overlapping pairs supply
   relative baseline ratios. Solve the horizontal camera graph, rejecting
   inconsistent edges before assigning connected components.
5. Return sparse triangulated points. For geometrically constrained components,
   repeated tracks that agree in 3D can support vertical-surface candidates.
   Horizontal floor planes and duplicate feature points do not count as wall
   support. The surface classifier remains explicitly unverified.

Up to 80 images use all same-floor image pairs. Larger batches retrieve a bounded
set of candidate pairs first; acceptance still requires the same geometry checks.
The batch limit is 300 images. Progress reports `features`, `matching`, and
`layout` with `completed` and `total` counts.

## What the result means

- `scale: "relative"` always means one unknown global scale. Coordinates are not
  metres; measurements and apartment area must not be calculated from them.
- `visual_overlap` links are evidence of shared image content. They do not prove
  a collision-free walking corridor through furniture, doors, or walls.
- `relative_reconstruction` means the camera graph is constrained up to a single
  scale and coordinate gauge. `topology_only` means some baseline ratios remain
  unresolved; its drawing is an explicitly approximate connectivity diagram.
- Components have independent coordinate systems. Do not overlap them on one
  architectural floor plan or silently add links between them.
- Surface candidates can include cabinets, glazing and furniture. They are not
  classified architectural walls and should appear as estimated surfaces if shown.
- `partial` and `insufficient_overlap` are useful outcomes. More overlap at doors,
  stable exposure, textured surfaces and level camera captures improve the input.
  The worker deliberately does not fabricate missing rooms, depths or connections.

## Verification

Run `python tests/imo3d-reconstruction.test.py` using the configured worker Python.
The independent tests cover panorama ray convention, all-around cheirality,
RANSAC outliers, unrelated images, disconnected components, camera pose graph
ratios, unresolved chain detection, shared-feature scales, inconsistent scale
tracks, and rejection of floor planes as vertical surfaces.

`node scripts/imo3d-reconstruction-evaluate.mjs` processes the 35 local reference
images without poses. Only after the worker returns does it read the original
tour's camera coordinates as held-out evaluation data. It reports a single
similarity-aligned camera error and original-neighbour comparisons in
`work/reconstruction-evaluation/evaluation.json`. `--reuse` evaluates a saved
worker result without rerunning image analysis. This evaluation never updates
the sample tour or its original map.
