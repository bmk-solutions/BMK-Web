# Optional offline panorama matching

`imo3d-dense-matching.py` produces candidate spherical correspondences for the
reconstruction process. It does not assign camera poses, create navigation links,
merge coordinate frames, or certify room boundaries. The caller must verify
geometry and can retain its existing SIFT result whenever this helper is unavailable.

The helper is a separate process so its CUDA libraries cannot replace the CPU
reconstruction runtime. It searches these existing local package directories, in order:

1. `work/gpu-python` — CUDA-enabled PyTorch and its dependencies.
2. `work/registration-learned-python` — Kornia 0.8.2, kornia_rs 0.1.10, einops 0.8.1.
3. `work/reconstruction-python-user` — the existing OpenCV runtime.

The validated runtime uses PyTorch 2.11. Runtime versions enter every cache key.
There is no package installation, model download, API request, or CPU inference
fallback in the helper. An unavailable GPU or less than 1.5 GiB of free VRAM causes
a clean optional-capability failure before model allocation.

The checkpoint must already exist as `loftr_indoor_ds_new.ckpt` in
`work/registration-models/` (preferred), or the existing
`work/registration-recovery/` directory. Required SHA-256:

`be9ff88b323ec27889114719f668ae41aff7034b56a4c4acbd46b8b180b87ed3`

It is loaded with `weights_only=True`. LoFTR is constructed with `pretrained=None`
and `coarse.temp_bug_fix=True`; this prevents automatic model retrieval.

## Contract

Run `python scripts/imo3d-dense-matching.py --input input.json --output result.json`.

Input contains `scenes: [{id, path}]`, up to 32 candidate index pairs in `pairs`,
and explicit `outputDir` and `cacheDir` directories. Originals are read only.
An optional `heartbeatFile` must lie inside `outputDir`. The parent should touch
it at least once per second and impose its own subprocess timeout. A heartbeat
older than 15 seconds stops the helper at the next model/pair/face boundary.

Successful output is `{status: "ready", pairs: [{i, j, cacheFile}], cacheDir}`.
`cacheFile` is a 64-character hexadecimal SHA-256 basename plus `.npz`, never a
path. Pair indices are canonicalized to `i < j`. Each NPZ contains unit-vector
`rays1`, `rays2`, one-to-one correspondences, and `confidence >= 0.5`. Arrays are
finite and limited to 20,000 matches per pair. Metadata binds the ordered source
content hashes, model checksum, algorithm/runtime versions, face geometry,
confidence threshold, and deduplication quantization. Invalid caches are recomputed.

Exit 0 means ready. Exit 2 returns `{status: "unavailable", reason, pairs: []}`;
exit 3 indicates an expired or missing parent heartbeat. The caller must preserve
the previous reconstruction for every non-ready result, timeout, or subprocess failure.

## Tests

`python tests/imo3d-dense-matching.test.py` uses synthetic rays and files. It checks
cache binding and corruption, bounded decompression, confidence-first one-to-one
matching, request limits, runtime/GPU fallback, heartbeat cancellation, cache reuse,
and preservation of original file bytes and timestamps. It performs no GPU inference.
