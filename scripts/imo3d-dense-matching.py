"""Offline, optional LoFTR correspondences; geometry acceptance stays in the caller."""
import argparse
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIRS = (ROOT / "work/gpu-python", ROOT / "work/registration-learned-python",
                ROOT / "work/reconstruction-python-user")
MODEL_SHA256 = "be9ff88b323ec27889114719f668ae41aff7034b56a4c4acbd46b8b180b87ed3"
MODEL_NAME = "loftr_indoor_ds_new.ckpt"
ALGORITHM = "imo3d-loftr-spherical-v1"
FACE_SIZE, FACE_FOV, FACE_COUNT = 512, 110, 4
CONFIDENCE, RAY_QUANTIZATION = .5, 300
MAX_PAIRS, MAX_SCENES, MAX_MATCHES = 32, 300, 20000
MAX_IMAGE_BYTES, MAX_CACHE_BYTES = 100 * 1024 * 1024, 8 * 1024 * 1024
MAX_CACHE_EXPANDED_BYTES = MAX_MATCHES * 7 * 8 + 65536


class DenseUnavailable(Exception):
    pass


def configure_runtime_paths(directories=RUNTIME_DIRS):
    """Never let the older CPU torch installation win module resolution."""
    paths = [str(Path(directory).resolve()) for directory in directories]
    sys.path[:] = paths + [entry for entry in sys.path if entry not in paths]


def numpy_module():
    configure_runtime_paths()
    import numpy
    return numpy


def regular_file(path, maximum):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise DenseUnavailable("invalid-input")
    return path.resolve(strict=True)


def validate_request(raw):
    if not isinstance(raw, dict) or set(raw) - {"scenes", "pairs", "outputDir", "cacheDir", "heartbeatFile"}:
        raise DenseUnavailable("invalid-input")
    scenes, pairs = raw.get("scenes"), raw.get("pairs")
    if not isinstance(scenes, list) or not 2 <= len(scenes) <= MAX_SCENES:
        raise DenseUnavailable("invalid-input")
    if not isinstance(pairs, list) or len(pairs) > MAX_PAIRS:
        raise DenseUnavailable("invalid-input")
    normalized, ids = [], set()
    for scene in scenes:
        if not isinstance(scene, dict) or set(scene) != {"id", "path"}:
            raise DenseUnavailable("invalid-input")
        scene_id, source = scene["id"], scene["path"]
        if not isinstance(scene_id, str) or not 1 <= len(scene_id) <= 80 or scene_id in ids:
            raise DenseUnavailable("invalid-input")
        if not isinstance(source, str) or not source:
            raise DenseUnavailable("invalid-input")
        ids.add(scene_id)
        normalized.append({"id": scene_id, "path": regular_file(source, MAX_IMAGE_BYTES)})
    normalized_pairs, seen = [], set()
    for pair in pairs:
        if (not isinstance(pair, list) or len(pair) != 2 or any(type(i) is not int for i in pair)
                or pair[0] == pair[1] or min(pair) < 0 or max(pair) >= len(scenes)):
            raise DenseUnavailable("invalid-input")
        key = tuple(sorted(pair))
        if key not in seen:
            seen.add(key)
            normalized_pairs.append(key)
    if any(not isinstance(raw.get(key), str) or not raw[key] for key in ("outputDir", "cacheDir")):
        raise DenseUnavailable("invalid-input")
    output_dir, cache_dir = Path(raw["outputDir"]), Path(raw["cacheDir"])
    for directory in (output_dir, cache_dir):
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise DenseUnavailable("invalid-input")
        directory.mkdir(parents=True, exist_ok=True)
    output_dir, cache_dir = output_dir.resolve(), cache_dir.resolve()
    heartbeat = None
    if raw.get("heartbeatFile") is not None:
        if not isinstance(raw["heartbeatFile"], str):
            raise DenseUnavailable("invalid-input")
        heartbeat = Path(raw["heartbeatFile"])
        if heartbeat.is_symlink() or not heartbeat.resolve().is_relative_to(output_dir):
            raise DenseUnavailable("invalid-input")
        heartbeat = heartbeat.resolve()
    return {"scenes": normalized, "pairs": normalized_pairs, "outputDir": output_dir,
            "cacheDir": cache_dir, "heartbeatFile": heartbeat}


def check_heartbeat(path, now=None):
    if path is None:
        return
    try:
        age = (time.time() if now is None else now) - path.stat().st_mtime
        if path.is_symlink() or not path.is_file() or age > 15 or age < -5:
            raise DenseUnavailable("parent-stopped")
    except OSError as error:
        raise DenseUnavailable("parent-stopped") from error


def file_sha256(path, heartbeat=None):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while True:
            check_heartbeat(heartbeat)
            chunk = source.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def matching_metadata(first_hash, second_hash, versions):
    return {"algorithm": ALGORITHM, "modelSha256": MODEL_SHA256, "sources": [first_hash, second_hash],
            "faceSize": FACE_SIZE, "faceFov": FACE_FOV, "faceCount": FACE_COUNT,
            "confidenceThreshold": CONFIDENCE, "rayQuantization": RAY_QUANTIZATION,
            "maxMatches": MAX_MATCHES, "tempBugFix": True, "versions": dict(versions)}


def cache_key(metadata):
    return hashlib.sha256(json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def perspective_bearings(points, size=FACE_SIZE, yaw=0, field_of_view=FACE_FOV):
    np = numpy_module()
    extent = math.tan(math.radians(field_of_view / 2))
    points = np.asarray(points, dtype=float).reshape(-1, 2)
    local = np.column_stack(((points[:, 0] + .5) / size * 2 * extent - extent,
                             -((points[:, 1] + .5) / size * 2 * extent - extent), -np.ones(len(points))))
    rotation = np.array([[math.cos(yaw), 0, -math.sin(yaw)], [0, 1, 0],
                         [math.sin(yaw), 0, math.cos(yaw)]])
    rays = local @ rotation.T
    return rays / np.linalg.norm(rays, axis=1, keepdims=True)


def validate_matches(rays1, rays2, confidence):
    np = numpy_module()
    count = len(confidence) if confidence.ndim == 1 else -1
    if (not 0 <= count <= MAX_MATCHES or rays1.shape != (count, 3) or rays2.shape != (count, 3)
            or any(value.dtype.kind != "f" or not np.isfinite(value).all() for value in (rays1, rays2, confidence))
            or (confidence < CONFIDENCE).any() or (confidence > 1).any()):
        raise ValueError("invalid match arrays")
    for rays in (rays1, rays2):
        if not np.allclose(np.linalg.norm(rays, axis=1), 1, atol=1e-5, rtol=0):
            raise ValueError("non-unit rays")
        keys = [tuple(row) for row in np.round(rays * RAY_QUANTIZATION).astype(int)]
        if len(set(keys)) != count:
            raise ValueError("duplicate bearing")
    return rays1, rays2, confidence


def deduplicate_matches(rays1, rays2, confidence):
    np = numpy_module()
    first, second, scores = np.asarray(rays1, dtype=np.float32), np.asarray(rays2, dtype=np.float32), np.asarray(confidence)
    if scores.ndim != 1 or first.shape != (len(scores), 3) or second.shape != first.shape:
        raise ValueError("invalid match shape")
    usable = np.isfinite(scores) & (scores >= CONFIDENCE) & (scores <= 1)
    usable &= np.isfinite(first).all(axis=1) & np.isfinite(second).all(axis=1)
    usable &= np.abs(np.linalg.norm(first, axis=1) - 1) <= 1e-5
    usable &= np.abs(np.linalg.norm(second, axis=1) - 1) <= 1e-5
    keep, used_first, used_second = [], set(), set()
    for index in np.argsort(-scores, kind="stable"):
        if not usable[index]:
            continue
        a = tuple(np.round(first[index] * RAY_QUANTIZATION).astype(int))
        b = tuple(np.round(second[index] * RAY_QUANTIZATION).astype(int))
        if a not in used_first and b not in used_second:
            keep.append(index)
            used_first.add(a)
            used_second.add(b)
            if len(keep) == MAX_MATCHES:
                break
    return validate_matches(first[keep].astype(np.float32), second[keep].astype(np.float32), scores[keep].astype(np.float32))


def read_cache(file, metadata):
    np = numpy_module()
    try:
        regular_file(file, MAX_CACHE_BYTES)
        with zipfile.ZipFile(file) as archive:
            items = archive.infolist()
            if ({item.filename for item in items} != {"rays1.npy", "rays2.npy", "confidence.npy", "metadata.npy"}
                    or len(items) != 4 or sum(item.file_size for item in items) > MAX_CACHE_EXPANDED_BYTES):
                return None
        with np.load(file, allow_pickle=False) as data:
            stored = data["metadata"]
            if stored.shape != () or stored.dtype.kind != "U" or stored.nbytes > 8192:
                return None
            if json.loads(str(stored.item())) != metadata:
                return None
            return validate_matches(data["rays1"], data["rays2"], data["confidence"])
    except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile, DenseUnavailable, RecursionError):
        return None


def write_cache(file, metadata, rays1, rays2, confidence):
    np = numpy_module()
    validate_matches(rays1, rays2, confidence)
    if file.is_symlink():
        raise DenseUnavailable("invalid-input")
    temporary = file.with_name(file.stem + "." + uuid.uuid4().hex + ".npz")
    try:
        np.savez_compressed(temporary, rays1=rays1, rays2=rays2, confidence=confidence,
                            metadata=np.array(json.dumps(metadata, sort_keys=True, separators=(",", ":"))))
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()


def load_runtime(heartbeat=None):
    check_heartbeat(heartbeat)
    if any(not directory.is_dir() for directory in RUNTIME_DIRS):
        raise DenseUnavailable("runtime-unavailable")
    configure_runtime_paths()
    os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "160000000"
    try:
        import torch
        import cv2
        import kornia
        import numpy as np
        from kornia.feature import LoFTR
        from kornia.feature.loftr.loftr import default_cfg
    except (ImportError, OSError, RuntimeError) as error:
        raise DenseUnavailable("runtime-unavailable") from error
    check_heartbeat(heartbeat)
    if not torch.cuda.is_available():
        raise DenseUnavailable("cuda-unavailable")
    model_path = next((path for path in (ROOT / "work/registration-models" / MODEL_NAME,
                                       ROOT / "work/registration-recovery" / MODEL_NAME) if path.is_file()), None)
    if model_path is None or model_path.is_symlink() or file_sha256(model_path, heartbeat) != MODEL_SHA256:
        raise DenseUnavailable("model-unavailable")
    torch.set_num_threads(2)
    cv2.setNumThreads(2)
    return {"torch": torch, "cv2": cv2, "numpy": np, "LoFTR": LoFTR, "config": default_cfg,
            "modelPath": model_path, "versions": {"torch": torch.__version__, "kornia": kornia.__version__,
                                                  "opencv": cv2.__version__, "numpy": np.__version__}}


def create_model(runtime, heartbeat=None):
    check_heartbeat(heartbeat)
    free_bytes, _ = runtime["torch"].cuda.mem_get_info()
    if free_bytes < 1536 * 1024 * 1024:
        raise DenseUnavailable("cuda-busy")
    config = deepcopy(runtime["config"])
    config["coarse"]["temp_bug_fix"] = True
    model = runtime["LoFTR"](pretrained=None, config=config)
    weights = runtime["torch"].load(runtime["modelPath"], map_location="cpu", weights_only=True)
    model.load_state_dict(weights["state_dict"])
    check_heartbeat(heartbeat)
    return model.eval().to("cuda")


def prepare_faces(path, digest, runtime, heartbeat=None):
    check_heartbeat(heartbeat)
    encoded = regular_file(path, MAX_IMAGE_BYTES).read_bytes()
    if hashlib.sha256(encoded).hexdigest() != digest:
        raise DenseUnavailable("source-changed")
    cv2, np = runtime["cv2"], runtime["numpy"]
    panorama = cv2.imdecode(np.frombuffer(encoded, np.uint8), cv2.IMREAD_GRAYSCALE)
    if panorama is None or panorama.ndim != 2 or abs(panorama.shape[1] / panorama.shape[0] - 2) > .06:
        raise DenseUnavailable("invalid-panorama")
    height, width = panorama.shape
    if height * width > 160_000_000:
        raise DenseUnavailable("invalid-panorama")
    cols, rows = np.meshgrid(np.arange(FACE_SIZE), np.arange(FACE_SIZE))
    coordinates = np.column_stack((cols.ravel(), rows.ravel()))
    faces = []
    for face in range(FACE_COUNT):
        check_heartbeat(heartbeat)
        rays = perspective_bearings(coordinates, FACE_SIZE, face * math.pi / 2).reshape(FACE_SIZE, FACE_SIZE, 3)
        map_x = ((np.arctan2(rays[:, :, 0], -rays[:, :, 2]) / (2 * math.pi) + .5) * width).astype(np.float32)
        map_y = ((.5 - np.arcsin(np.clip(rays[:, :, 1], -1, 1)) / math.pi) * height).astype(np.float32)
        faces.append(cv2.remap(panorama, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP))
    return faces


def match_faces(model, first, second, runtime, heartbeat=None):
    torch, np = runtime["torch"], runtime["numpy"]
    tensor = lambda face: torch.from_numpy(face.astype(np.float32) / 255)[None, None].to("cuda")
    first_tensors, second_tensors = [tensor(face) for face in first], [tensor(face) for face in second]
    rays1, rays2, scores = [], [], []
    with torch.inference_mode():
        for a, image_a in enumerate(first_tensors):
            for b, image_b in enumerate(second_tensors):
                check_heartbeat(heartbeat)
                matched = model({"image0": image_a, "image1": image_b})
                selected = matched["confidence"] >= CONFIDENCE
                one, two = matched["keypoints0"][selected].cpu().numpy(), matched["keypoints1"][selected].cpu().numpy()
                rays1.append(perspective_bearings(one, FACE_SIZE, a * math.pi / 2))
                rays2.append(perspective_bearings(two, FACE_SIZE, b * math.pi / 2))
                scores.append(matched["confidence"][selected].cpu().numpy())
    return deduplicate_matches(np.concatenate(rays1), np.concatenate(rays2), np.concatenate(scores))


def run(raw):
    request = validate_request(raw)
    heartbeat, cache_dir = request["heartbeatFile"], request["cacheDir"]
    check_heartbeat(heartbeat)
    if not request["pairs"]:
        return {"status": "ready", "pairs": [], "cacheDir": str(cache_dir)}
    runtime = load_runtime(heartbeat)
    hashes, model, faces, outputs = {}, None, OrderedDict(), []
    for index, (i, j) in enumerate(request["pairs"]):
        check_heartbeat(heartbeat)
        for scene_index in (i, j):
            if scene_index not in hashes:
                hashes[scene_index] = file_sha256(request["scenes"][scene_index]["path"], heartbeat)
        metadata = matching_metadata(hashes[i], hashes[j], runtime["versions"])
        file = cache_dir / (cache_key(metadata) + ".npz")
        cached = read_cache(file, metadata)
        if cached is None:
            if model is None:
                model = create_model(runtime, heartbeat)
            for scene_index in (i, j):
                if scene_index not in faces:
                    faces[scene_index] = prepare_faces(request["scenes"][scene_index]["path"], hashes[scene_index], runtime, heartbeat)
                faces.move_to_end(scene_index)
            matched = match_faces(model, faces[i], faces[j], runtime, heartbeat)
            write_cache(file, metadata, *matched)
            while len(faces) > 8:
                faces.popitem(last=False)
        outputs.append({"i": i, "j": j, "cacheFile": file.name})
        print(json.dumps({"stage": "dense-matching", "completed": index + 1, "total": len(request["pairs"])}), file=sys.stderr, flush=True)
    check_heartbeat(heartbeat)
    return {"status": "ready", "pairs": outputs, "cacheDir": str(cache_dir)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    code = 0
    try:
        input_path = regular_file(args.input, 1024 * 1024)
        result = run(json.loads(input_path.read_text(encoding="utf-8")))
    except DenseUnavailable as error:
        result, code = {"status": "unavailable", "reason": str(error), "pairs": []}, 3 if str(error) == "parent-stopped" else 2
    except Exception:
        # This optional subprocess must never replace a usable SIFT result with
        # a runtime/library error; the caller receives a bounded reason only.
        result, code = {"status": "unavailable", "reason": "inference-failed", "pairs": []}, 2
    output = Path(args.output)
    if output.is_symlink():
        return 2
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, output)
    print(json.dumps({"status": result["status"], "pairs": len(result["pairs"]), **({"reason": result["reason"]} if "reason" in result else {})}), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
