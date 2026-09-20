# Spherical camera refinement experiment

`imo3d-bundle-adjust.py` refines level-camera horizontal positions and yaw against shared spherical image features. It operates offline and writes candidates under `work/`; it never updates a tour, database, cloud storage, or deployment.

It restores accepted feature correspondences, removes tracks that identify multiple pixels in the same camera, triangulates only training observations, and reserves one deterministic, distributed observation from tracks with at least four views. Camera origin and one baseline fix the similarity gauge. This does not establish metres.

Acceptance requires solver convergence and improvement on held-out median angular error, no worse held-out 90th percentile, and no increase in errors above five degrees. `unsupportedSceneIds` must be treated as unresolved. A candidate is not a production-ready surface reconstruction: dense visibility, occlusions, free space, global observability and scale require separate validation.

Example (use the existing project Python environment containing numpy/scipy/OpenCV):

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'work/reconstruction-python-user'
$env:IMO3D_CV_PATH = $env:PYTHONPATH
python scripts/imo3d-bundle-adjust.py --reconstruction work/independent-reconstruction/candidate-result.json --features work/independent-reconstruction/original-run/features --output work/spherical-bundle-review-balanced --max-evaluations 4000
python tests/imo3d-bundle-adjust.test.py
```

The feature cache must match the original private JPEGs under `.imo3d-data/assets`. Track caches are keyed by image/feature fingerprints and the accepted pair list. Never commit the images, private tracks, poses, or generated point clouds.
