"""Read-only local processing preflight. No photographs or network access."""
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_runtime():
    checks = []
    try:
        load('imo3d-photo-depth')
        import numpy as np
        import cv2
        from scipy.optimize import least_squares
        from scipy.spatial import cKDTree
        sample = np.ones((4, 4), np.float32)
        assert cv2.remap(sample, sample, sample, cv2.INTER_LINEAR).shape == (4, 4)
        assert least_squares(lambda x: x - 1, [0.]).success
        assert cKDTree([[0., 0.]]).query([0., 0.])[0] == 0
        checks.append('scientific-runtime')
        from transformers.models.depth_anything.modeling_depth_anything import DepthAnythingForDepthEstimation
        from transformers import AutoModelForVision2Seq, AutoModelForObjectDetection
        load('imo3d-joint-depth')
        from depth_anything_3.cfg import create_object
        from omegaconf import OmegaConf
        from safetensors.torch import load_file
        from torchvision.models import resnet50
        checks.append('model-imports')
        required = [
            Path(os.environ.get('IMO3D_PHOTO_DEPTH_MODEL_DIR', ROOT / 'work/depth-model')) / 'model.safetensors',
            ROOT / 'work/da3-model/model.safetensors',
            ROOT / 'work/da3-model/config.json',
            Path(os.environ.get('IMO3D_LAYOUT_WEIGHTS', ROOT / 'work/layout-model/resnet50_rnn__st3d.pth')),
        ]
        for env, default in [('IMO3D_VLM_MODEL_DIR', 'SmolVLM-500M-Instruct'), ('IMO3D_OBJECT_MODEL_DIR', 'rtdetr_v2_r18vd')]:
            folder = Path(os.environ.get(env, ROOT / 'work/room-vision-models' / default))
            required.extend(folder / file for file in ['model.safetensors', 'config.json', 'manifest.json'])
        if any(not file.is_file() or file.stat().st_size == 0 for file in required):
            return {'ok': False, 'checks': checks, 'failure': 'model-files'}
        checks.append('model-files')
        return {'ok': True, 'checks': checks}
    except Exception:
        # Details remain local. Do not expose local paths or environment values.
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {'ok': False, 'checks': checks, 'failure': 'dependencies'}


if __name__ == '__main__':
    result = check_runtime()
    print(json.dumps(result), flush=True)
    sys.exit(0 if result['ok'] else 2)
