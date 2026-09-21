"""Offline relative panorama depth for display; never survey or measurement depth."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
for part in reversed(["vlm-python-verified", "layout-python-verified", "room-vision-python-verified", "reconstruction-python-verified"]):
    sys.path.insert(0, str(ROOT / "work" / part))
# Use the same configured scientific runtime as reconstruction. A stale bundled
# scipy namespace can otherwise mask the working scipy.optimize installation.
try:
    runtime = json.loads((ROOT / "work" / "reconstruction-runtime.json").read_text(encoding="utf-8-sig"))
except (OSError, ValueError):
    runtime = {}
cv_runtime = os.environ.get("IMO3D_CV_PATH") or runtime.get("cvPath")
if cv_runtime and Path(cv_runtime).is_dir():
    sys.path.insert(0, str(cv_runtime))
gpu_runtime = ROOT / "work" / "gpu-python"
if (gpu_runtime / ".imo3d-verified.json").is_file():
    sys.path.insert(0, str(gpu_runtime))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
import numpy as np
import cv2
from PIL import Image

MODEL_SHA256 = "3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70"
VERSION = "photo-depth-overlap-v2-128"


def camera_rays(yaw, pitch, size):
    yaw, pitch = math.radians(yaw), math.radians(pitch)
    forward = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), math.cos(yaw) * math.cos(pitch)])
    right = np.array([math.cos(yaw), 0, -math.sin(yaw)])
    up = np.cross(forward, right)
    axis = (np.arange(size, dtype=np.float32) + .5) / size * 2 - 1
    x, y = np.meshgrid(axis, axis)
    raw = forward + x[..., None] * right - y[..., None] * up
    norm = np.linalg.norm(raw, axis=-1)
    return raw / norm[..., None], norm, (forward, right, up)


def affine_fit(x, y, tolerance=.075, minimum_fraction=.5):
    valid = np.isfinite(x) & np.isfinite(y) & (y > .01)
    x, y = np.asarray(x)[valid], np.asarray(y)[valid]
    if len(x) < 160 or np.quantile(x, .9) - np.quantile(x, .1) < 1e-4:
        return None
    rng = np.random.default_rng(7)
    index = rng.choice(len(x), min(3500, len(x)), replace=False)
    x, y = x[index], y[index]
    threshold = tolerance * np.maximum(y, .4)
    best = None
    for _ in range(100):
        i, j = rng.choice(len(x), 2, replace=False)
        if abs(x[i] - x[j]) < 1e-5:
            continue
        a = (y[i] - y[j]) / (x[i] - x[j])
        if not np.isfinite(a) or a <= 0:
            continue
        b = y[i] - a * x[i]
        mask = np.abs(a * x + b - y) < threshold
        if best is None or mask.sum() > best.sum():
            best = mask
    if best is None or best.mean() < minimum_fraction or best.sum() < 120:
        return None
    a, b = np.linalg.lstsq(np.stack([x[best], np.ones(best.sum())], axis=1), y[best], rcond=None)[0]
    residual = np.abs(a * x[best] + b - y[best]) / np.maximum(y[best], .1)
    if a <= 0 or not np.isfinite(a + b) or np.median(residual) > .12:
        return None
    return {"a": float(a), "b": float(b), "fraction": float(best.mean()), "residual": float(np.median(residual)), "support": int(best.sum())}


def sampled_face(face, rays):
    forward, right, up = face["basis"]
    front = rays @ forward
    horizontal = (rays @ right) / np.maximum(front, .001)
    vertical = -(rays @ up) / np.maximum(front, .001)
    size = face["prediction"].shape[0]
    x = ((horizontal + 1) * size / 2 - .5).astype(np.float32)
    y = ((vertical + 1) * size / 2 - .5).astype(np.float32)
    prediction = cv2.remap(face["prediction"], x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=float("nan"))
    valid = (front > .05) & (np.abs(horizontal) < .94) & (np.abs(vertical) < .94) & np.isfinite(prediction)
    fit = face.get("fit")
    if fit is None:
        return prediction, valid, front
    # Model output is affine inverse optical-Z; radial inverse distance adds
    # the optical-axis cosine for this panorama ray.
    inverse = (fit["a"] * prediction + fit["b"]) * front
    valid &= (inverse > 1 / 20) & (inverse < 1 / .12)
    return inverse, valid, front


def anchor_faces(faces, profile):
    for face in faces:
        rays = face["rays"]
        longitude = np.arctan2(rays[..., 0], rays[..., 2])
        latitude = np.arcsin(np.clip(rays[..., 1], -1, 1))
        columns = ((longitude / (2 * math.pi) + .5) * len(profile)) % len(profile)
        floor_angle = np.interp(columns, np.arange(len(profile)), profile, period=len(profile))
        size = face["prediction"].shape[0]
        edge = np.zeros((size, size), dtype=bool)
        margin = int(size * .08)
        edge[margin:-margin, margin:-margin] = True
        floor = (-latitude > floor_angle + .06) & (latitude < -.15) & edge
        target = -rays[..., 1] * face["norm"]
        fit = affine_fit(face["prediction"][floor], target[floor])
        face["floorCandidates"] = int(floor.sum())
        if fit:
            face.update(fit=fit, anchor="floor", confidence=min(.9, .55 + .35 * fit["fraction"]), level=0)
    # Only propagate from an anchored source, with enough shared angular area.
    # Two passes reach upward faces while bounding accumulated alignment error.
    for level in [1, 2]:
        anchors = [face for face in faces if face.get("fit") and face["level"] < level]
        pending = []
        for face in faces:
            if face.get("fit"):
                continue
            stride = max(1, face["prediction"].shape[0] // 98)
            rays = face["rays"][::stride, ::stride]
            predictions = face["prediction"][::stride, ::stride]
            inverse_z, weights = [], []
            for other in anchors:
                inverse, valid, front = sampled_face(other, rays)
                if valid.sum() < 180:
                    continue
                inverse_z.append(np.where(valid, inverse * face["norm"][::stride, ::stride], np.nan))
                weights.append(other["confidence"])
            if not inverse_z:
                continue
            stack = np.stack(inverse_z)
            with np.errstate(all="ignore"):
                count = np.isfinite(stack).sum(axis=0)
                target = np.nansum(stack, axis=0) / np.maximum(1, count)
            spread = np.sqrt(np.nansum((stack - target) ** 2, axis=0) / np.maximum(1, count))
            reliable = (count > 0) & (spread < .16 * np.maximum(target, .15))
            fit = affine_fit(predictions[reliable], target[reliable], .12, .55)
            if fit:
                pending.append((face, fit, min(weights) * .8))
        for face, fit, inherited in pending:
            face.update(fit=fit, anchor="overlap", confidence=min(inherited, .8 * fit["fraction"]), level=level)
    return faces


def blend_panorama(faces, width=256, height=128):
    longitude, latitude = np.meshgrid((np.arange(width) + .5) / width * 2 * math.pi - math.pi, math.pi / 2 - (np.arange(height) + .5) / height * math.pi)
    rays = np.stack([np.sin(longitude) * np.cos(latitude), np.sin(latitude), np.cos(longitude) * np.cos(latitude)], axis=-1)
    values, weights = [], []
    for face in faces:
        if not face.get("fit"):
            continue
        inverse, valid, front = sampled_face(face, rays)
        values.append(np.where(valid, inverse, np.nan))
        weights.append(np.where(valid, np.maximum(front, 0) ** 4 * face["confidence"], 0))
    if not values:
        return np.zeros((height, width)), np.zeros((height, width)), {"overlapDisagreement": 1.0}
    stack, weight = np.stack(values), np.stack(weights)
    denom = weight.sum(axis=0)
    mean = np.nansum(stack * weight, axis=0) / np.maximum(denom, 1e-8)
    variance = np.nansum((stack - mean) ** 2 * weight, axis=0) / np.maximum(denom, 1e-8)
    relative_spread = np.sqrt(variance) / np.maximum(mean, 1e-6)
    # Cross-face disagreement is withheld, rather than averaged into a false
    # surface. Confidence is an agreement score, not calibrated accuracy.
    valid = (denom > .08) & (relative_spread < .28) & (mean > .05)
    depth = np.divide(1, mean, out=np.zeros_like(mean), where=valid)
    confidence = np.where(valid, np.minimum(1, denom) * np.exp(-relative_spread * 3), 0)
    overlap = (np.isfinite(stack).sum(axis=0) > 1)
    diagnostics = {"overlapDisagreement": float(np.mean(relative_spread[overlap] > .28)) if overlap.any() else 1.0,
                   "medianRelativeOverlapSpread": float(np.median(relative_spread[overlap])) if overlap.any() else 1.0}
    return depth, confidence, diagnostics


def conservative_downsample(depth, confidence):
    if depth.shape != (128, 256) or confidence.shape != depth.shape:
        raise ValueError("Expected native 256x128 panorama depth")
    blocks = depth.reshape(64, 2, 128, 2).transpose(0, 2, 1, 3).reshape(64, 128, 4)
    certainty = confidence.reshape(64, 2, 128, 2).transpose(0, 2, 1, 3).reshape(64, 128, 4)
    low, high = blocks.min(axis=-1), blocks.max(axis=-1)
    valid = (low > 0) & (certainty.min(axis=-1) >= .25) & (high < low * 1.3)
    return np.where(valid, np.median(blocks, axis=-1), 0), np.where(valid, certainty.min(axis=-1), 0)


def profile_digest(profile):
    return hashlib.sha256(json.dumps(profile, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def cache_key(image_hash, profile_hash):
    return hashlib.sha256((VERSION + MODEL_SHA256 + image_hash + profile_hash).encode()).hexdigest()


def read_cache(file, image_hash, profile_hash):
    try:
        if Path(file).is_symlink() or Path(file).stat().st_size > 1_000_000:
            return None
        cached = json.loads(Path(file).read_text(encoding="utf-8"))
        if not isinstance(cached, dict) or cached.get("version") != VERSION or cached.get("modelSha256") != MODEL_SHA256 or cached.get("imageSha256") != image_hash or cached.get("profileSha256") != profile_hash:
            return None
        if cached.get("width") != 128 or cached.get("height") != 64 or cached.get("units") != "camera_height" or cached.get("purpose") != "display_only" or cached.get("metric") is not False or cached.get("source") != "monocular-multiview-floor-aligned":
            return None
        values, confidence = cached.get("values"), cached.get("confidenceValues")
        if not isinstance(values, list) or len(values) != 8192 or not isinstance(confidence, list) or len(confidence) != 8192:
            return None
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 20 for v in values):
            return None
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 1 for v in confidence):
            return None
        coverage = sum(v > 0 for v in values) / len(values)
        supported_confidence = [c for v, c in zip(values, confidence) if v > 0]
        # Recompute derived aggregate fields; they never become trusted just
        # because a cache file's dimensions and hashes were valid.
        cached["coverage"] = coverage
        cached["confidence"] = float(np.mean(supported_confidence)) if supported_confidence else 0
        return cached
    except (OSError, ValueError, TypeError):
        return None


class PhotoDepth:
    def __init__(self):
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        torch.set_num_threads(6)
        model_dir = Path(os.environ.get("IMO3D_PHOTO_DEPTH_MODEL_DIR", ROOT / "work" / "depth-model"))
        if hashlib.sha256((model_dir / "model.safetensors").read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError("Local photo-depth model checksum mismatch")
        self.torch = torch
        self.device = "cpu"
        try:
            if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] >= 2 * 1024 ** 3:
                torch.zeros(1, device="cuda").add_(1)
                torch.cuda.synchronize()
                self.device = "cuda"
        except RuntimeError:
            pass  # CPU remains available when the GPU cannot run real kernels.
        self.processor = AutoImageProcessor.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForDepthEstimation.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False).eval().to(self.device)
        print(json.dumps({"event": "runtime", "stage": "photo_depth", "device": self.device}), flush=True)

    def infer(self, scene, profile, size=392):
        started = time.monotonic()
        source_bytes = Path(scene["path"]).read_bytes()
        source = np.array(Image.open(scene["path"]).convert("RGB"))
        h, w = source.shape[:2]
        faces = []
        for pitch in [-45, 0, 45]:
            for yaw in range(0, 360, 45):
                rays, norm, basis = camera_rays(yaw, pitch, size)
                longitude = np.arctan2(rays[..., 0], rays[..., 2])
                latitude = np.arcsin(np.clip(rays[..., 1], -1, 1))
                x = (((longitude / (2 * math.pi) + .5) * w - .5) % w).astype(np.float32)
                y = np.clip((.5 - latitude / math.pi) * h - .5, 0, h - 1).astype(np.float32)
                view = cv2.remap(source, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
                with self.torch.inference_mode():
                    inputs = {key: value.to(self.device) for key, value in self.processor(images=Image.fromarray(view), return_tensors="pt").items()}
                    prediction = self.model(**inputs).predicted_depth
                prediction = self.torch.nn.functional.interpolate(prediction[:, None], size=(size, size), mode="bicubic", align_corners=False)[0, 0].cpu().numpy()
                faces.append({"yaw": yaw, "pitch": pitch, "rays": rays, "norm": norm, "basis": basis, "prediction": prediction})
        anchor_faces(faces, np.asarray(profile, dtype=float))
        depth, confidence, diagnostics = blend_panorama(faces)
        depth, confidence = conservative_downsample(depth, confidence)
        coverage = float((depth > 0).mean())
        report = {"version": VERSION, "sceneId": scene["id"], "imageSha256": hashlib.sha256(source_bytes).hexdigest(), "modelSha256": MODEL_SHA256,
                  "width": depth.shape[1], "height": depth.shape[0], "values": depth.round(3).flatten().tolist(), "confidenceValues": confidence.round(3).flatten().tolist(),
                  "confidence": float(np.mean(confidence[depth > 0])) if coverage else 0, "coverage": coverage,
                  "source": "monocular-multiview-floor-aligned", "units": "camera_height", "purpose": "display_only", "metric": False,
                  "seconds": round(time.monotonic() - started, 2), "diagnostics": diagnostics,
                  "faces": [{key: face[key] for key in ["yaw", "pitch", "fit", "anchor", "confidence", "level", "floorCandidates"] if key in face} for face in faces]}
        return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    scenes, profiles = payload.get("scenes"), payload.get("roomProfiles")
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 300 or not isinstance(profiles, dict):
        raise ValueError("Expected scenes and roomProfiles for local relative photo depth")
    if len({scene.get("id") for scene in scenes if isinstance(scene, dict)}) != len(scenes) or any(not isinstance(scene, dict) or not isinstance(scene.get("id"), str) or not isinstance(scene.get("path"), str) for scene in scenes):
        raise ValueError("Expected unique capture IDs and local panorama paths")
    model = None
    cache_dir = Path(os.environ.get("IMO3D_ANALYSIS_CACHE_DIR", Path(args.output).parent / "analysis-cache")) / "photo-depth"
    cache_dir.mkdir(parents=True, exist_ok=True)
    if cache_dir.is_symlink():
        raise ValueError("Photo-depth cache must be a private directory, not a link")
    results, errors = [], []
    for index, scene in enumerate(scenes):
        try:
            profile = profiles.get(scene["id"], {}).get("floorBoundaryRadians")
            if not isinstance(profile, list) or not 64 <= len(profile) <= 4096 or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value < math.pi / 2 for value in profile):
                raise ValueError("A valid learned floor boundary is required for this capture")
            image_hash = hashlib.sha256(Path(scene["path"]).read_bytes()).hexdigest()
            profile_hash = profile_digest(profile)
            file = cache_dir / (cache_key(image_hash, profile_hash) + ".json")
            result = read_cache(file, image_hash, profile_hash)
            if result is None:
                if model is None:
                    model = PhotoDepth()
                result = model.infer(scene, profile)
                result["profileSha256"] = profile_hash
                if file.is_symlink():
                    raise ValueError("Photo-depth cache file must not be a link")
                file.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False), encoding="utf-8")
            result["sceneId"] = scene["id"]
            results.append(result)
        except (OSError, ValueError, KeyError) as error:
            errors.append({"sceneId": scene.get("id"), "error": str(error)})
        print(json.dumps({"event": "progress", "stage": "photo_depth", "completed": index + 1, "total": len(scenes)}), flush=True)
    Path(args.output).write_text(json.dumps({"version": VERSION, "scenes": results, "errors": errors}), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
