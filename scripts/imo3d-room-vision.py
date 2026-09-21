"""Offline room recognition with a local vision-language model.

No filenames, room names, camera coordinates, credentials, or network services
participate in inference. Generated captions are proposed visual evidence and remain reviewable.
Ensuite relationships must be resolved separately from room/door topology.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
for package_path in reversed((os.environ.get("IMO3D_VISION_PATH"), ROOT / "work" / "room-vision-python-verified")):
    if package_path and Path(package_path).is_dir():
        sys.path.insert(0, str(package_path))

from PIL import Image

VERSION = "smolvlm-rtdetr-panorama-rooms-v3"
CAPTION_VERSION = "smolvlm-panorama-rooms-v1"
ROOM_PATTERNS = {
    "bedroom": r"\b(?:bedroom|bed room|sleeping room)\b",
    "bathroom": r"\b(?:bathroom|washroom|restroom|shower room|toilet room)\b",
    "kitchen": r"\bkitchen\b",
    "living": r"\b(?:living room|family room|lounge)\b",
    "guest": r"\b(?:majlis|guest reception|drawing room|guest sitting room)\b",
    "dining": r"\bdining (?:room|area|table)\b",
    "corridor": r"\b(?:hallway|corridor|hall)\b",
    "entrance": r"\b(?:entrance|foyer|entryway|entry hall)\b",
    "balcony": r"\b(?:balcony|terrace)\b",
    "storage": r"\b(?:closet|dressing room|storage room|walk.in wardrobe)\b",
}
OBJECT_PATTERNS = {
    "bedroom": r"\b(?:bed|pillow|headboard|bedside)\b",
    "bathroom": r"\b(?:toilet|shower|bathtub|washbasin|bath tub)\b",
    "kitchen": r"\b(?:stove|oven|refrigerator|cooktop|countertop|cabinets|microwave)\b",
    "living": r"\b(?:sofa|couch|television|tv|coffee table)\b",
    "guest": r"\b(?:sofa|seating|chairs|couch)\b",
    "dining": r"\b(?:dining table|table|chairs)\b",
    "corridor": r"\b(?:door|doors|doorway|passage|hallway|corridor)\b",
    "entrance": r"\b(?:door|doorway|entry|entrance|foyer)\b",
    "balcony": r"\b(?:railing|outdoor|outside|balcony|terrace)\b",
    "storage": r"\b(?:wardrobe|wardrobes|closet|cupboard|shelves|clothing)\b",
}
ARABIC_LABELS = {"bedroom": "غرفة نوم", "bathroom": "حمام", "kitchen": "مطبخ", "living": "صالة معيشة", "guest": "غرفة ضيوف", "dining": "غرفة طعام", "corridor": "ممر", "entrance": "مدخل", "balcony": "شرفة", "storage": "غرفة تخزين", "unknown": "فراغ يحتاج مراجعة"}
OBJECT_ROOMS = {"bed": "bedroom", "sofa": "living", "diningtable": "dining", "toilet": "bathroom", "oven": "kitchen", "microwave": "kitchen", "refrigerator": "kitchen"}
RELEVANT_OBJECTS = set(OBJECT_ROOMS) | {"sink", "tvmonitor", "chair", "pottedplant"}


def positive_mentions(text, pattern):
    mentions = []
    for match in re.finditer(pattern, text):
        prefix = text[max(0, match.start() - 32):match.start()]
        if not re.search(r"\b(?:no|not|without|absence of)\s+(?:(?:a|any|visible)\s+)*$", prefix):
            mentions.append(match.group())
    return mentions


def parse_room_caption(caption):
    """Accept a named function with visible object support; never infer privacy."""
    caption = " ".join(str(caption).split())[:480]
    lower = caption.lower()
    # Function is read from the first clause, before objects or neighboring rooms.
    first_clause = re.split(r"objects\s*:|[.;\n]", lower, maxsplit=1)[0]
    if re.search(r"\b(?:not|unclear|unknown|unsure|uncertain|cannot|can't)\b", first_clause):
        return {"kind": "unknown", "confidence": .25, "needsReview": True, "evidence": [caption or "No room function identified"]}
    candidates = [(match.start(), kind) for kind, pattern in ROOM_PATTERNS.items()
                  if (match := re.search(pattern, first_clause))]
    if not candidates:
        return {"kind": "unknown", "confidence": .25, "needsReview": True, "evidence": [caption or "No room function identified"]}
    candidates.sort()
    kind = candidates[0][1]
    supported = bool(positive_mentions(lower, OBJECT_PATTERNS[kind]))
    contradictory = len({item[1] for item in candidates}) > 1
    score = .86 if supported else .68
    if contradictory:
        score = min(score, .66)
    return {"kind": kind, "confidence": score, "needsReview": score < .8,
            "evidence": [caption[:240], "visible_object_support" if supported else "room_function_only"]}


def image_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as image_file:
        while chunk := image_file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_cached_caption(path, digest):
    try:
        cached = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(cached, dict) or cached.get("imageSha256") != digest:
        return None
    caption = cached.get("caption")
    if not isinstance(caption, str) or not 1 <= len(caption) <= 4000:
        return None
    # Always re-apply current evidence rules; never trust persisted derived fields.
    return {**parse_room_caption(caption), "caption": caption, "imageSha256": digest}


def validate_request(request):
    scenes = request.get("scenes") if isinstance(request, dict) else None
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 1000:
        raise ValueError("Expected between 1 and 1000 scenes")
    ids = set()
    for scene in scenes:
        if not isinstance(scene, dict) or not isinstance(scene.get("id"), str) or not 1 <= len(scene["id"]) <= 80 or not isinstance(scene.get("path"), str) or not scene["path"]:
            raise ValueError("Each scene requires an id and a local image path")
        if scene["id"] in ids:
            raise ValueError("Duplicate scene ids are not allowed")
        ids.add(scene["id"])
    return scenes


def perspective_image(source, yaw_degrees, size=512):
    """Sample a true 90-degree perspective view from the spherical photograph."""
    import numpy as np
    image = source.copy()
    image.thumbnail((3072, 1536), Image.Resampling.LANCZOS)
    pixels = np.asarray(image, dtype=np.float32)
    height, width = pixels.shape[:2]
    axis = (np.arange(size, dtype=np.float32) + .5) / size * 2 - 1
    right, down = np.meshgrid(axis, axis)
    pitch = -.10
    up = -down * math.cos(pitch) + math.sin(pitch)
    forward = math.cos(pitch) + down * math.sin(pitch)
    longitude = np.arctan2(right, forward) + math.radians(yaw_degrees)
    latitude = np.arctan2(up, np.sqrt(right * right + forward * forward))
    x = ((longitude / (2 * np.pi) + .5) * width - .5) % width
    y = np.clip((.5 - latitude / np.pi) * height - .5, 0, height - 1)
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    x1, y1 = (x0 + 1) % width, np.minimum(y0 + 1, height - 1)
    dx, dy = (x - x0)[..., None], (y - y0)[..., None]
    sampled = ((pixels[y0, x0] * (1 - dx) + pixels[y0, x1] * dx) * (1 - dy)
               + (pixels[y1, x0] * (1 - dx) + pixels[y1, x1] * dx) * dy)
    return Image.fromarray(np.clip(sampled, 0, 255).astype(np.uint8))


def valid_object_views(views):
    if not isinstance(views, list) or len(views) != 4:
        return False
    for view in views:
        if not isinstance(view, list) or len(view) > 32:
            return False
        for obj in view:
            if not isinstance(obj, dict) or obj.get("label") not in RELEVANT_OBJECTS:
                return False
            box = obj.get("box")
            numbers = [obj.get("confidence"), obj.get("area")]
            if not isinstance(box, list) or len(box) != 4:
                return False
            numbers.extend(box)
            if any(not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(number) or not 0 <= number <= 1 for number in numbers):
                return False
            area = (box[2] - box[0]) * (box[3] - box[1])
            if box[2] <= box[0] or box[3] <= box[1] or not 0 < area < .85 or abs(area - obj["area"]) > .00003:
                return False
    return True


def verify_room_views(full, views):
    result = dict(full)
    flags = []
    supported = [view for view in views if view["kind"] != "unknown" and view["confidence"] >= .8]
    counts = {}
    for view in views:
        kinds = {view["kind"]} if view in supported else set()
        for detected in view.get("objects", []):
            object_kind = OBJECT_ROOMS.get(detected["label"])
            if object_kind and detected["confidence"] >= .82 and detected["area"] >= .035:
                kinds.add(object_kind)
        for object_kind in kinds:
            counts[object_kind] = counts.get(object_kind, 0) + 1
    kind = full["kind"]
    # A confidently detected large bed resolves the observed sofa/bed caption
    # failure. Small beds through a distant doorway cannot trigger this rule.
    large_bed = any(obj["label"] == "bed" and obj["confidence"] >= .9 and obj["area"] >= .18 for view in views for obj in view.get("objects", []))
    strong_sofa = any(obj["label"] == "sofa" and obj["confidence"] >= .82 and obj["area"] >= .1 for view in views for obj in view.get("objects", []))
    if kind in ("living", "unknown") and large_bed and not strong_sofa:
        kind = result["kind"] = "bedroom"
        result["confidence"] = .82
        flags.append("room_function_corrected_by_visible_bed")
    matching = counts.get(kind, 0)
    others = {key: count for key, count in counts.items() if key != kind}
    corridor_conflict = kind not in ("corridor", "entrance", "unknown") and any(key in others for key in ("corridor", "entrance"))
    if matching == 0:
        if others:
            flags.append("perspective_room_conflict")
            result["confidence"] = min(result["confidence"], .55)
        else:
            flags.append("room_function_unverified")
            result["confidence"] = min(result["confidence"], .68)
    elif corridor_conflict and matching <= 1:
        # A furnished room visible beyond a doorway does not locate the camera.
        flags.append("neighboring_room_visible")
        result["confidence"] = min(result["confidence"], .58)
    elif others and max(others.values()) >= matching:
        flags.append("perspective_room_conflict")
        result["confidence"] = min(result["confidence"], .68)
    elif matching == 1 and not (kind == "bedroom" and large_bed):
        flags.append("limited_room_visibility")
        result["confidence"] = min(result["confidence"], .78)
    if any(view["kind"] == "bathroom" for view in supported) and kind == "bedroom":
        flags.append("bathroom_visibility_requires_doorway_review")
    result["reviewFlags"] = flags
    result["needsReview"] = full["needsReview"] or bool(flags)
    result["viewEvidence"] = views
    result["evidence"] = [*full["evidence"], *flags]
    return result


def bathroom_directions(scene_id, full_kind, views):
    if full_kind != "bedroom" and not any(view["kind"] == "bedroom" for view in views):
        return []
    proposals = []
    for view in views:
        toilets = [obj for obj in view.get("objects", []) if obj["label"] == "toilet" and obj["confidence"] >= .82 and obj["area"] >= .002]
        fixtures = sorted(set(positive_mentions(view["caption"].lower(), r"\b(?:toilet|shower|bathtub|washbasin)\b"))) if view["kind"] == "bathroom" else []
        if toilets:
            fixtures = sorted(set(fixtures + ["toilet"]))
        if not fixtures:
            continue
        proposals.append({"sceneId": scene_id, "yaw": view["yaw"], "yawConvention": "native_panorama_degrees",
            "kind": "bathroom", "visibleFixtures": fixtures, "confidence": .86 if len(fixtures) >= 2 or toilets else .72,
            "evidence": [view["caption"][:240], *(["independent_toilet_detector"] if toilets else [])],
            "objectEvidence": toilets, "privateToFrom": False, "doorwayVerified": False})
    return proposals


def inference_device(torch):
    requested = os.environ.get("IMO3D_ROOM_DEVICE", "auto")
    if requested not in ("auto", "cpu", "cuda"):
        raise ValueError("IMO3D_ROOM_DEVICE must be auto, cpu or cuda")
    if requested == "cpu":
        return "cpu"
    try:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA runtime is unavailable")
        # Probe the real GPU kernel, not just driver presence.
        torch.zeros(1, device="cuda").add_(1)
        torch.cuda.synchronize()
        if torch.cuda.mem_get_info()[0] < 3 * 1024 ** 3:
            raise RuntimeError("At least 3 GiB of free GPU memory is required")
        return "cuda"
    except RuntimeError:
        if requested == "cuda":
            raise
        return "cpu"


class RoomVision:
    """Small VLM executes locally with downloads disabled during inference."""
    def __init__(self):
        runtime_paths = [os.environ.get("IMO3D_VLM_PATH"), ROOT / "work" / "vlm-python-verified",
                         os.environ.get("IMO3D_TORCH_PATH"), ROOT / "work" / "layout-python-verified"]
        for package_path in reversed(runtime_paths):
            if package_path and Path(package_path).is_dir():
                sys.path.insert(0, str(package_path))
        gpu_runtime = ROOT / "work" / "gpu-python"
        if (gpu_runtime / ".imo3d-verified.json").is_file():
            sys.path.insert(0, str(gpu_runtime))
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HOME"] = str(ROOT / "work" / "room-vision-models")
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        import torch
        from transformers import AutoProcessor, AutoModelForVision2Seq, AutoImageProcessor, AutoModelForObjectDetection
        self.torch = torch
        self.device = inference_device(torch)
        torch.set_num_threads(max(1, min(8, (os.cpu_count() or 2) // 2)))
        model_dir = Path(os.environ.get("IMO3D_VLM_MODEL_DIR", ROOT / "work" / "room-vision-models" / "SmolVLM-500M-Instruct"))
        manifest = json.loads((model_dir / "manifest.json").read_text(encoding="utf-8"))
        self.revision = manifest["revision"]
        self.processor = AutoProcessor.from_pretrained(str(model_dir), local_files_only=True)
        self.model = AutoModelForVision2Seq.from_pretrained(str(model_dir), local_files_only=True,
            torch_dtype=torch.float32, _attn_implementation="sdpa").eval().to(self.device)
        detector_dir = Path(os.environ.get("IMO3D_OBJECT_MODEL_DIR", ROOT / "work" / "room-vision-models" / "rtdetr_v2_r18vd"))
        self.detector_revision = json.loads((detector_dir / "manifest.json").read_text(encoding="utf-8"))["revision"]
        self.object_processor = AutoImageProcessor.from_pretrained(str(detector_dir), local_files_only=True, use_fast=False)
        self.object_model = AutoModelForObjectDetection.from_pretrained(str(detector_dir), local_files_only=True).eval().to(self.device)
        self.prompt = self.processor.apply_chat_template([{"role": "user", "content": [
            {"type": "image"}, {"type": "text", "text": "Identify the type of room and list the visible furniture. Use this format: Room: <room type>. Objects: <three main objects>."}]}], add_generation_prompt=True)
        self.view_prompt = self.processor.apply_chat_template([{"role": "user", "content": [
            {"type": "image"}, {"type": "text", "text": "Describe the room, objects, and any doorway visible in this image. Be concise."}]}], add_generation_prompt=True)
        self.cache_dir = Path(os.environ.get("IMO3D_ANALYSIS_CACHE_DIR", ROOT / "work" / "room-vision-cache"))
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def caption_image(self, image, max_tokens=36, perspective=False):
        inputs = self.processor(text=self.view_prompt if perspective else self.prompt, images=[image], return_tensors="pt", size={"longest_edge": max(image.size)})
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.inference_mode():
            generated = self.model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
        return self.processor.batch_decode(generated[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]

    def detect_objects(self, crops, digest):
        key = hashlib.sha256(("room-objects-v1" + self.detector_revision + digest).encode()).hexdigest()
        path = self.cache_dir / (key + ".json")
        try:
            cache = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = None
        if isinstance(cache, dict) and cache.get("imageSha256") == digest and valid_object_views(cache.get("views")):
            return cache["views"]
        inputs = self.object_processor(images=crops, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        with self.torch.inference_mode():
            outputs = self.object_model(**inputs)
        detected = self.object_processor.post_process_object_detection(outputs,
            target_sizes=self.torch.tensor([[512, 512]] * len(crops), device=self.device), threshold=.75)
        result = []
        for view in detected:
            objects = []
            for score, label_id, box in zip(view["scores"], view["labels"], view["boxes"]):
                label = self.object_model.config.id2label[int(label_id)]
                if label not in RELEVANT_OBJECTS:
                    continue
                coordinates = [round(max(0, min(1, float(value) / 512)), 5) for value in box]
                area = (coordinates[2] - coordinates[0]) * (coordinates[3] - coordinates[1])
                if not 0 < area < .85:
                    continue
                objects.append({"label": label, "confidence": round(float(score), 4), "box": coordinates, "area": round(area, 5)})
            result.append(objects[:32])
        path.write_text(json.dumps({"imageSha256": digest, "views": result}), encoding="utf-8")
        return result

    def classify(self, scene):
        image_path = Path(scene["path"])
        digest = image_hash(image_path)
        cache_key = hashlib.sha256((CAPTION_VERSION + self.revision + digest).encode()).hexdigest()
        cache_path = self.cache_dir / (cache_key + ".json")
        cached = read_cached_caption(cache_path, digest)
        # Reuse complete evidence before decoding the original panorama.
        previous_views = []
        for yaw in (0, 90, 180, 270):
            key = hashlib.sha256(("room-view-v2" + self.revision + digest + str(yaw)).encode()).hexdigest()
            view = read_cached_caption(self.cache_dir / (key + ".json"), digest)
            if view is not None:
                previous_views.append({"yaw": yaw, **view})
        object_key = hashlib.sha256(("room-objects-v1" + self.detector_revision + digest).encode()).hexdigest()
        try:
            objects = json.loads((self.cache_dir / (object_key + ".json")).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            objects = None
        if cached is not None and len(previous_views) == 4 and isinstance(objects, dict) and objects.get("imageSha256") == digest and valid_object_views(objects.get("views")):
            for view, detected in zip(previous_views, objects["views"]):
                view["objects"] = detected
            verified = verify_room_views(cached, previous_views)
            return {**verified, "id": scene["id"], "roomType": verified["kind"], "roomLabel": ARABIC_LABELS[verified["kind"]]}
        views, crops = [], []
        with Image.open(image_path) as source:
            if not 1.8 <= source.width / source.height <= 2.2:
                raise ValueError("Room vision requires an equirectangular 360 photograph")
            panorama = source.convert("RGB")
            if cached is None:
                image = panorama.copy()
                image.thumbnail((1024, 512), Image.Resampling.LANCZOS)
                caption = self.caption_image(image)
                cached = {**parse_room_caption(caption), "caption": caption, "imageSha256": digest}
                cache_path.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
                image.close()
            # Resize the source once, instead of copying/resizing a 128 MP image
            # again for each of four perspective views.
            panorama.thumbnail((3072, 1536), Image.Resampling.LANCZOS)
            for yaw in (0, 90, 180, 270):
                crop = perspective_image(panorama, yaw)
                crops.append(crop)
                view_key = hashlib.sha256(("room-view-v2" + self.revision + digest + str(yaw)).encode()).hexdigest()
                view_path = self.cache_dir / (view_key + ".json")
                view = read_cached_caption(view_path, digest)
                if view is None:
                    caption = self.caption_image(crop, max_tokens=40, perspective=True)
                    view = {**parse_room_caption(caption), "caption": caption, "imageSha256": digest}
                    view_path.write_text(json.dumps(view, ensure_ascii=False), encoding="utf-8")
                views.append({"yaw": yaw, **view})
        for view, objects in zip(views, self.detect_objects(crops, digest)):
            view["objects"] = objects
        verified = verify_room_views(cached, views)
        return {**verified, "id": scene["id"], "roomType": verified["kind"], "roomLabel": ARABIC_LABELS[verified["kind"]]}


def run(request):
    scenes = validate_request(request)
    vision = RoomVision()
    print(json.dumps({"event": "runtime", "device": vision.device}), flush=True)
    results, errors, observations, doorways = [], [], [], []
    for index, scene in enumerate(scenes):
        try:
            classified = vision.classify(scene)
            results.append(classified)
            doorways.extend(bathroom_directions(scene["id"], classified["kind"], classified["viewEvidence"]))
            observations.append({"id": "vision-" + classified["imageSha256"][:20] + "-" + scene["id"],
                "sceneId": scene["id"], "kind": classified["kind"], "confidence": classified["confidence"],
                "evidence": classified["evidence"], "model": "SmolVLM-500M-Instruct@" + vision.revision[:12]})
        except (OSError, ValueError) as error:
            errors.append({"id": scene.get("id"), "error": str(error)})
        print(json.dumps({"event": "progress", "stage": "room_recognition", "completed": index + 1, "total": len(scenes)}), flush=True)
    return {"version": VERSION, "model": "HuggingFaceTB/SmolVLM-500M-Instruct", "modelRevision": vision.revision,
            "objectModel": "PekingU/rtdetr_v2_r18vd", "objectModelRevision": vision.detector_revision,
            "inference": "local_cuda" if vision.device == "cuda" else "local_cpu", "scenes": results, "observations": observations, "bathroomDoorways": doorways, "errors": errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    started = time.monotonic()
    result = run(json.loads(Path(arguments.input).read_text(encoding="utf-8-sig")))
    result["elapsedSeconds"] = round(time.monotonic() - started, 2)
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"event": "complete", "scenes": len(result["scenes"]), "elapsedSeconds": result["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"event": "error", "stage": "room_recognition", "error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(2)
