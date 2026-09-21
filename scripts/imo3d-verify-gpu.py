"""Verify an isolated official PyTorch CUDA runtime before enabling room inference."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
runtime = root / "work" / "gpu-python"
if not runtime.is_dir():
    raise SystemExit("Install the documented GPU runtime in work/gpu-python first.")
sys.path.insert(0, str(runtime))
import torch
import torchvision

if not torch.cuda.is_available():
    raise SystemExit("CUDA is unavailable; the CPU fallback remains enabled.")
x = torch.randn((512, 512), device="cuda")
y = x @ x
torch.cuda.synchronize()
if not bool(torch.isfinite(y).all()):
    raise SystemExit("GPU kernel verification failed.")
info = {"torch": torch.__version__, "torchvision": torchvision.__version__,
        "device": torch.cuda.get_device_name(0), "capability": torch.cuda.get_device_capability(0)}
(runtime / ".imo3d-verified.json").write_text(json.dumps(info), encoding="utf-8")
print(json.dumps(info))
