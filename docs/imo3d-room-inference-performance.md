# Local room recognition acceleration

The workstation has an NVIDIA RTX 5060 Ti (8 GB). Its earlier model environment used PyTorch 2.14 CPU-only, running five image captions plus four-view object detection per panorama on the CPU. The new recognizer supports a separately verified CUDA runtime, keeps the same models, prompts, float32 precision and four perspective views, and falls back to CPU when CUDA is unavailable or less than 3 GiB of GPU memory is free.

Setup on this Python 3.12 Windows worker (official PyTorch distribution):

```powershell
python -m pip install --target work/gpu-python torch==2.11.0 torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
python scripts/imo3d-verify-gpu.py
```

The verifier must pass a real GPU matrix operation before writing the local readiness marker. No existing CPU environment is replaced. The marker/runtime stay private under ignored `work/`. `IMO3D_ROOM_DEVICE=cpu` forces CPU; `cuda` requires GPU; default `auto` probes kernels and available memory. These are local worker settings, not Vercel environment variables.

The image is decoded once, and the panorama resized once for all four crops. Complete cached captions/object detections bypass decoding and inference, while current evidence validation is rerun. Caches live in the private workstation directory `work/room-vision-cache`; keys include content hashes and model versions. Boundary and depth models use their own validated subdirectories. New image bytes invalidate their cache. This does not certify metric accuracy.

Verification: CUDA kernel on the actual RTX 5060 Ti; one actual panorama with all four views and no cache completed in 15.36 seconds including model startup, with one observation and no errors. This is a single-image smoke result, not a guarantee for a 100-image batch. CPU baseline timing was not measured under equivalent conditions. Python tests cover device selection, memory checks, cached-evidence reuse and corrupt cache rejection. TypeScript tests accept local CUDA envelopes with unchanged scene ID and metric safeguards.

References: https://docs.pytorch.org/get-started/previous-versions/ and https://download.pytorch.org/whl/cu128/.
