"""Image-only, conservative spherical two-view reconstruction for IMO 3D.

Input: {scenes:[{id,path,floor}], outputDir}. No camera coordinates, depths,
scene order, filenames, or reference floor plans participate in inference.
Optional learned boundary profiles yield estimated room envelopes in camera-height
units. Neither sparse camera positions nor inferred walls are measured floor plans.
Requires the pinned packages in imo3d-reconstruction-requirements.txt.
"""
from __future__ import annotations

import argparse
import importlib.util
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import uuid
import zipfile

if os.environ.get("IMO3D_CV_PATH"):
    sys.path.insert(0, os.environ["IMO3D_CV_PATH"])
else:
    local_packages = Path(__file__).resolve().parents[1] / "work" / "reconstruction-python"
    if local_packages.is_dir():
        sys.path.insert(0, str(local_packages))

import numpy as np

VERSION = 1
FEATURE_VERSION = "spherical-sift-v2-4k"


def room_envelope_module():
    spec = importlib.util.spec_from_file_location("imo3d_room_envelope", Path(__file__).with_name("imo3d-room-envelope.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def progress(stage, completed, total, **extra):
    print(json.dumps({"event": "progress", "stage": stage, "completed": completed,
                      "total": total, **extra}, ensure_ascii=False), flush=True)


def wrap(angle):
    return np.arctan2(np.sin(angle), np.cos(angle))


def pixel_bearings(points, width, height):
    """IMO convention: image centre faces -Z, right turns towards +X, up +Y."""
    longitude = (points[:, 0] / width - 0.5) * (2 * np.pi)
    latitude = (0.5 - points[:, 1] / height) * np.pi
    return np.column_stack((np.sin(longitude) * np.cos(latitude),
                            np.sin(latitude), -np.cos(longitude) * np.cos(latitude)))


def essential_from_bearings(first, second):
    design = np.einsum("ni,nj->nij", second, first).reshape(-1, 9)
    _, _, vt = np.linalg.svd(design, full_matrices=len(first) < 9)
    u, s, vt = np.linalg.svd(vt[-1].reshape(3, 3))
    # An essential matrix has two equal nonzero singular values.
    return u @ np.diag([(s[0] + s[1]) / 2] * 2 + [0]) @ vt


def epipolar_error(matrix, first, second):
    normal2, normal1 = first @ matrix.T, second @ matrix
    numerator = np.abs(np.einsum("ni,ni->n", second, normal2))
    return numerator / np.maximum(1e-9, np.minimum(np.linalg.norm(normal2, axis=1),
                                                  np.linalg.norm(normal1, axis=1)))


def robust_essential(first, second, rng, threshold=0.0035, max_trials=700):
    """Eight-point RANSAC on unit sphere rays, not pinhole coordinates."""
    if len(first) < 16:
        return None, np.zeros(len(first), dtype=bool)
    best, best_mask, best_count = None, np.zeros(len(first), dtype=bool), 0
    trial, limit = 0, max_trials
    while trial < limit:
        trial += 1
        sample = rng.choice(len(first), 8, replace=False)
        try:
            matrix = essential_from_bearings(first[sample], second[sample])
        except np.linalg.LinAlgError:
            continue
        mask = epipolar_error(matrix, first, second) < threshold
        count = int(mask.sum())
        if count > best_count:
            best, best_mask, best_count = matrix, mask, count
            probability = (count / len(first)) ** 8
            if probability > 1e-12:
                limit = min(limit, max(80, int(math.log(0.002) / math.log1p(-min(1 - 1e-12, probability))) + 1))
    if best_count < 16:
        return None, best_mask
    # Re-estimation on consensus is crucial with noisy equirectangular features.
    for _ in range(3):
        try:
            candidate = essential_from_bearings(first[best_mask], second[best_mask])
        except np.linalg.LinAlgError:
            break
        refined = epipolar_error(candidate, first, second) < threshold
        if refined.sum() < 16:
            break
        # A failed refit must retain both the previous matrix and its consensus.
        # Returning the candidate with the old mask can triangulate outliers as
        # supported camera motion even when they exceed the RANSAC threshold.
        best, best_mask = candidate, refined
    return best, best_mask


def radial_triangulation(first, second, rotation, translation):
    """Solve positive radial depths; ordinary +Z cheirality is invalid on 360s."""
    rotated = first @ rotation.T
    cosine = np.einsum("ni,ni->n", rotated, second)
    rhs1 = -rotated @ translation
    rhs2 = second @ translation
    denominator = np.maximum(1e-10, 1 - cosine * cosine)
    depth1 = (rhs1 + cosine * rhs2) / denominator
    depth2 = (cosine * rhs1 + rhs2) / denominator
    residual = np.linalg.norm(rotated * depth1[:, None] + translation - second * depth2[:, None], axis=1)
    return depth1, depth2, residual


def recover_spherical_pose(matrix, first, second):
    u, _, vt = np.linalg.svd(matrix)
    if np.linalg.det(u) < 0:
        u[:, -1] *= -1
    if np.linalg.det(vt) < 0:
        vt[-1] *= -1
    w = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., 1.]])
    best, best_count = None, -1
    for rotation in (u @ w @ vt, u @ w.T @ vt):
        for sign in (1, -1):
            translation = sign * u[:, 2]
            d1, d2, residual = radial_triangulation(first, second, rotation, translation)
            positive = (d1 > 0.05) & (d2 > 0.05) & (d1 < 250) & (d2 < 250) & (residual < 0.15)
            count = int(positive.sum())
            if count > best_count:
                best_count = count
                best = rotation, translation, positive, d1
    return best


def extract_features(path, cache_dir):
    import cv2
    resolved = Path(path).resolve(strict=True)
    encoded = resolved.read_bytes()
    fingerprint = hashlib.sha256(FEATURE_VERSION.encode() + encoded).hexdigest()
    cache = cache_dir / (fingerprint + ".npz")
    if cache.exists():
        try:
            with np.load(cache, allow_pickle=False) as data:
                return {key: data[key] for key in ("points", "bearings", "descriptors", "signature")}
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            pass  # Incomplete/corrupt cache is recomputed from the original.
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("تعذرت قراءة صورة البانوراما")
    height, width = image.shape
    if abs(width / height - 2) > 0.06:
        raise ValueError("تتطلب المعالجة صور بانوراما 360 كاملة بنسبة 2:1")
    high_resolution = width > 2048
    # Doorway overlap can occupy only a small part of a complete panorama.
    # Retain those details when the original supports them; never enlarge a
    # low-resolution source or relax the geometric acceptance thresholds.
    if width > 4096:
        image = cv2.resize(image, (4096, 2048), interpolation=cv2.INTER_AREA)
    height, width = image.shape
    # SIFT on an overlapping longitude strip makes seam-adjacent objects usable.
    pad = width // 8
    padded = np.concatenate((image[:, -pad:], image, image[:, :pad]), axis=1)
    mask = np.zeros_like(padded)
    mask[int(height * .13):int(height * .87), pad:pad + width] = 255
    detector = cv2.SIFT_create(nfeatures=10000 if high_resolution else 4200,
                               contrastThreshold=.018 if high_resolution else .025, edgeThreshold=12)
    keys, descriptors = detector.detectAndCompute(padded, mask)
    points = np.asarray([(key.pt[0] - pad, key.pt[1]) for key in keys], dtype=np.float32).reshape(-1, 2)
    if descriptors is None:
        descriptors = np.zeros((0, 128), dtype=np.float32)
    # RootSIFT is less sensitive to panorama exposure differences.
    descriptors = np.sqrt(descriptors / np.maximum(1e-12, descriptors.sum(axis=1, keepdims=True)))
    signature = cv2.resize(image, (64, 32), interpolation=cv2.INTER_AREA).astype(float)
    signature = np.sort(signature, axis=1).reshape(-1)
    signature = (signature - signature.mean()) / max(1, signature.std())
    result = {"points": points, "bearings": pixel_bearings(points, width, height),
              "descriptors": descriptors.astype(np.float32), "signature": signature}
    temporary = cache.with_name(fingerprint + "." + uuid.uuid4().hex + ".npz")
    np.savez_compressed(temporary, **result)
    temporary.replace(cache)
    return result


def match_pair(first, second, rng):
    import cv2
    if min(len(first["descriptors"]), len(second["descriptors"])) < 24:
        return None, "few_features"
    matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    raw = matcher.knnMatch(first["descriptors"], second["descriptors"], k=2)
    candidates = [m for neighbours in raw if len(neighbours) == 2
                  for m, n in [neighbours] if m.distance < .72 * n.distance]
    # One-to-one correspondences prevent repeated flooring from dominating.
    unique = {}
    for match in sorted(candidates, key=lambda item: item.distance):
        unique.setdefault(match.trainIdx, match)
    matches = list(unique.values())
    if len(matches) < 32:
        return None, "few_matches"
    indices1 = np.asarray([m.queryIdx for m in matches])
    indices2 = np.asarray([m.trainIdx for m in matches])
    rays1, rays2 = first["bearings"][indices1], second["bearings"][indices2]
    matrix, inliers = robust_essential(rays1, rays2, rng)
    count = int(inliers.sum())
    if matrix is None or count < 28 or count / len(matches) < .22:
        return None, "inconsistent_geometry"
    recovered = recover_spherical_pose(matrix, rays1[inliers], rays2[inliers])
    if recovered is None:
        return None, "ambiguous_pose"
    rotation, translation, positive, depths = recovered
    chirality = float(positive.mean())
    if chirality < .78:
        return None, "ambiguous_pose"
    camera_rotation = rotation.T
    tilt = math.degrees(math.acos(np.clip(camera_rotation[1, 1], -1, 1)))
    direction = -camera_rotation @ translation
    yaw = math.atan2(-camera_rotation[0, 2], camera_rotation[0, 0])
    if tilt > 10 or abs(direction[1]) > .32:
        return None, "not_level_or_inconsistent"
    consistent1, consistent2 = rays1[inliers][positive], rays2[inliers][positive]
    parallax = np.degrees(np.arccos(np.clip(np.einsum("ni,ni->n", consistent1 @ rotation.T, consistent2), -1, 1)))
    median_parallax = float(np.median(parallax))
    if median_parallax < .65:
        return None, "rotation_only_or_duplicate"
    longitude = np.arctan2(consistent1[:, 0], -consistent1[:, 2])
    sectors = len(set(np.floor((longitude + np.pi) / (2 * np.pi) * 12).astype(int)))
    if sectors < 3:
        return None, "narrow_overlap"
    errors = epipolar_error(matrix, rays1[inliers], rays2[inliers])
    confidence = min(.99, (.35 * min(1., count / 120) + .30 * min(1., count / len(matches) / .7)
                            + .20 * chirality + .15 * min(1., sectors / 6)))
    return {"matches": len(matches), "inliers": count, "confidence": round(confidence, 4),
            "parallaxDegrees": round(median_parallax, 3), "residualDegrees": round(float(np.degrees(np.median(errors))), 4),
            "yaw": float(yaw), "direction": direction, "tiltDegrees": round(tilt, 3),
            "_indices1": indices1[inliers][positive], "_indices2": indices2[inliers][positive],
            "_points": consistent1 * depths[positive, None], "_depths1": depths[positive],
            "_depths2": np.linalg.norm((consistent1 * depths[positive, None]) @ rotation.T + translation, axis=1)}, None


def connected_components(count, pairs):
    adjacency = [[] for _ in range(count)]
    for pair in pairs:
        adjacency[pair["i"]].append(pair["j"])
        adjacency[pair["j"]].append(pair["i"])
    seen, result = set(), []
    for node in range(count):
        if node in seen:
            continue
        stack, component = [node], []
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            component.append(current)
            stack.extend(adjacency[current])
        result.append(sorted(component))
    return sorted(result, key=lambda component: (-len(component), component[0]))


def rotate_horizontal(vector, yaw):
    cosine, sine = math.cos(yaw), math.sin(yaw)
    return np.asarray([cosine * vector[0] - sine * vector[2],
                       sine * vector[0] + cosine * vector[2]])


def visual_pair_bearings(pair, source_yaw):
    """Reciprocal world bearings from epipolar translation, not sketch lengths."""
    direction = pair["direction"]
    forward = (math.degrees(source_yaw + math.atan2(direction[0], -direction[2]))) % 360
    return round(forward, 4), round((forward + 180) % 360, 4)


def baseline_ratio_constraints(edges):
    """Recover baseline ratios from common SIFT tracks in multiple image pairs.

    For a common 3D point, radial_depth_A * baseline_A equals
    radial_depth_B * baseline_B. No camera height or reference length is assumed.
    """
    from scipy.optimize import least_squares
    if not edges:
        return {}
    observations = {}
    for index, pair in enumerate(edges):
        for suffix, node in (("1", pair["i"]), ("2", pair["j"])):
            for feature, depth in zip(pair.get("_indices" + suffix, []), pair.get("_depths" + suffix, [])):
                if .1 < depth < 80:
                    observations.setdefault((node, int(feature)), []).append((index, float(depth)))
    ratios = {}
    for track in observations.values():
        for a in range(len(track)):
            for b in range(a + 1, len(track)):
                i, di = track[a]
                j, dj = track[b]
                if i > j:
                    i, j, di, dj = j, i, dj, di
                ratios.setdefault((i, j), []).append(math.log(di / dj))
    constraints = []
    for (i, j), values in ratios.items():
        if len(values) < 10:
            continue
        median = float(np.median(values))
        deviation = float(np.median(np.abs(np.asarray(values) - median)))
        if deviation < .10 and abs(median) < 3:
            constraints.append((i, j, median, min(1., len(values) / 40) / (1 + deviation * 10)))
    return constraints


def baseline_scales(edges, constraints=None):
    """Return only baselines linked to a floor anchor or the explicit gauge edge.

    Unanchored ratio groups remain relative; callers must retain their ratio
    constraints rather than inventing absolute lengths for those groups.
    """
    from scipy.optimize import least_squares
    if not edges:
        return {}
    if constraints is None:
        constraints = baseline_ratio_constraints(edges)
    graph = [[] for _ in edges]
    for i, j, ratio, _ in constraints:
        graph[i].append((j, ratio))
        graph[j].append((i, -ratio))
    floor_anchors = {index: pair["_floorBaseline"] for index, pair in enumerate(edges)
                     if pair.get("_floorBaseline") and .02 < pair["_floorBaseline"]["baseline"] < 20}
    if floor_anchors:
        logarithms, reached = np.zeros(len(edges)), set()
        for anchor, evidence in floor_anchors.items():
            if anchor in reached:
                continue
            logarithms[anchor] = math.log(evidence["baseline"])
            reached.add(anchor)
            stack = [anchor]
            while stack:
                i = stack.pop()
                for j, ratio in graph[i]:
                    if j not in reached:
                        logarithms[j] = logarithms[i] + ratio
                        reached.add(j)
                        stack.append(j)
        def floor_residual(values):
            residuals = [(values[j] - values[i] - ratio) * weight for i, j, ratio, weight in constraints if i in reached and j in reached]
            residuals.extend((values[index] - math.log(evidence["baseline"])) * math.sqrt(evidence["confidence"])
                             for index, evidence in floor_anchors.items())
            return residuals
        logarithms = least_squares(floor_residual, logarithms, loss="soft_l1", f_scale=.06, max_nfev=100).x
        return {index: math.exp(float(np.clip(logarithms[index], -4, 4))) for index in reached}
    logarithms, reached, stack = np.zeros(len(edges)), {0}, [0]
    while stack:
        i = stack.pop()
        for j, ratio in graph[i]:
            if j not in reached:
                logarithms[j] = logarithms[i] + ratio
                reached.add(j)
                stack.append(j)
    if len(reached) > 1:
        def residual(values):
            return [(values[j] - values[i] - ratio) * weight for i, j, ratio, weight in constraints if i in reached and j in reached] + [values[0] * 10]
        logarithms = least_squares(residual, logarithms, loss="soft_l1", f_scale=.06, max_nfev=80).x
    return {index: math.exp(float(np.clip(logarithms[index], -4, 4))) for index in reached}


def vertical_surfaces(cloud, rng):
    """Detect supported vertical surfaces, without classifying furniture as walls."""
    points = np.asarray(cloud, dtype=float).reshape(-1, 3)
    if len(points) < 30:
        return []
    # Quantize duplicate tracks before scoring support; the same feature must not
    # gain confidence just because it occurs in several nearby camera pairs.
    _, unique = np.unique(np.round(points / .04), axis=0, return_index=True)
    remaining = points[unique]
    surfaces = []
    for _ in range(16):
        if len(remaining) < 25:
            break
        best, best_count = None, 0
        horizontal = remaining[:, [0, 2]]
        for _ in range(180):
            a, b = rng.choice(len(horizontal), 2, replace=False)
            vector = horizontal[b] - horizontal[a]
            length = np.linalg.norm(vector)
            if length < .5:
                continue
            direction = vector / length
            normal = np.array([-direction[1], direction[0]])
            distances = np.abs((horizontal - horizontal[a]) @ normal)
            mask = distances < .075
            count = int(mask.sum())
            if count < 25 or count <= best_count:
                continue
            heights = remaining[mask, 1]
            low, high = np.quantile(heights, [.1, .9])
            if high - low < .7:
                continue
            coverage = np.histogram(heights, bins=4, range=(low, high))[0]
            if sum(coverage >= 3) < 3:
                continue
            best, best_count = (mask, direction, horizontal[a]), count
        if best is None:
            break
        mask, direction, origin = best
        support = remaining[mask]
        projection = (support[:, [0, 2]] - origin) @ direction
        order = np.argsort(projection)
        gaps = np.where(np.diff(projection[order]) > .7)[0] + 1
        for segment in np.split(order, gaps):
            if len(segment) < 16:
                continue
            t = projection[segment]
            start, end = np.quantile(t, [.03, .97])
            heights = support[segment, 1]
            if end - start < .65 or np.quantile(heights, .9) - np.quantile(heights, .1) < .7:
                continue
            a, b = origin + direction * start, origin + direction * end
            surfaces.append({"a": {"x": round(float(a[0]), 5), "z": round(float(a[1]), 5)},
                             "b": {"x": round(float(b[0]), 5), "z": round(float(b[1]), 5)},
                             "confidence": round(min(.9, .45 + len(segment) / 200), 3),
                             "supportPoints": len(segment), "kind": "vertical_surface", "classification": "unverified"})
        remaining = remaining[~mask]
    return surfaces


def solve_component(nodes, pairs):
    """Robust gravity-aligned pose graph; the origin and one baseline fix gauge."""
    from scipy.optimize import least_squares
    indices = {node: i for i, node in enumerate(nodes)}
    edges = sorted([pair for pair in pairs if pair["i"] in indices and pair["j"] in indices],
                   key=lambda pair: -pair["confidence"] * pair["inliers"])
    count = len(nodes)
    if count == 1:
        return np.zeros((1, 2)), np.zeros(1), False, 0., [], []
    yaws, initial = np.zeros(count), np.zeros((count, 2))
    seen, tree = {edges[0]["i"]}, []
    anchor = edges[0]["i"]
    while len(seen) < count:
        added = False
        for pair in edges:
            i, j = pair["i"], pair["j"]
            if (i in seen) == (j in seen):
                continue
            ii, jj = indices[i], indices[j]
            if i in seen:
                yaws[jj] = yaws[ii] + pair["yaw"]
                initial[jj] = initial[ii] + rotate_horizontal(pair["direction"], yaws[ii])
                seen.add(j)
            else:
                yaws[ii] = yaws[jj] - pair["yaw"]
                initial[ii] = initial[jj] - rotate_horizontal(pair["direction"], yaws[ii])
                seen.add(i)
            tree.append(pair)
            added = True
        if not added:
            break
    ai = indices[anchor]
    def yaw_residual(values):
        return np.asarray([wrap(values[indices[p["j"]]] - values[indices[p["i"]]] - p["yaw"])
                           * math.sqrt(p["confidence"]) for p in edges] + [values[ai] * 10])
    yaws = least_squares(yaw_residual, yaws, loss="soft_l1", f_scale=.04, max_nfev=100).x
    yaw_errors = [abs(float(wrap(yaws[indices[p["j"]]] - yaws[indices[p["i"]]] - p["yaw"]))) for p in edges]
    reliable = [p for p, error in zip(edges, yaw_errors) if error < math.radians(7)]
    # Triangulated radial depths and floor anchors measure the full 3D baseline.
    # The pose graph stores only XZ positions: project each baseline before using
    # it as a distance constraint, including the first (gauge-fixing) edge.
    ratios = baseline_ratio_constraints(reliable)
    full_scales = baseline_scales(reliable, ratios)
    horizontal_fractions = [float(np.linalg.norm(p["direction"][[0, 2]]) / max(1e-9, np.linalg.norm(p["direction"]))) for p in reliable]
    scales = {index: scale * horizontal_fractions[index] for index, scale in full_scales.items()}
    relative_ratios = [(i, j, ratio + math.log(max(1e-9, horizontal_fractions[j]) / max(1e-9, horizontal_fractions[i])), weight)
                       for i, j, ratio, weight in ratios if i not in scales or j not in scales]
    floor_calibrated = any(pair.get("_floorBaseline") for pair in reliable)
    diagram_unit = float(np.median(list(scales.values()))) if floor_calibrated and scales else 1.
    if floor_calibrated:
        initial *= diagram_unit
    # A linear bearing system estimates baseline ratios only when the graph is rigid.
    rows, rhs = [], []
    for pair in reliable:
        i, j = indices[pair["i"]], indices[pair["j"]]
        direction = rotate_horizontal(pair["direction"], yaws[i])
        direction /= max(1e-9, np.linalg.norm(direction))
        normal = np.array([-direction[1], direction[0]])
        row = np.zeros(count * 2)
        row[2*j:2*j+2], row[2*i:2*i+2] = normal, -normal
        rows.append(row * pair["confidence"])
        rhs.append(0.)
    # A disconnected track group still measures baseline ratios. It does not
    # measure that group's absolute scale relative to the floor-anchored graph.
    for first, second, log_ratio, weight in relative_ratios:
        row = np.zeros(count * 2)
        for index, coefficient in ((second, 1.), (first, -math.exp(log_ratio))):
            pair = reliable[index]
            i, j = indices[pair["i"]], indices[pair["j"]]
            direction = rotate_horizontal(pair["direction"], yaws[i])
            direction /= max(1e-9, np.linalg.norm(direction))
            row[2*j:2*j+2] += direction * coefficient * weight
            row[2*i:2*i+2] -= direction * coefficient * weight
        rows.append(row)
        rhs.append(0.)
    for index, scale in scales.items():
        pair = reliable[index]
        i, j = indices[pair["i"]], indices[pair["j"]]
        direction = rotate_horizontal(pair["direction"], yaws[i])
        direction /= max(1e-9, np.linalg.norm(direction))
        for axis in range(2):
            row = np.zeros(count * 2)
            row[2*j+axis], row[2*i+axis] = .4, -.4
            rows.append(row)
            rhs.append(direction[axis] * scale * .4)
    for axis in range(2):
        row = np.zeros(count * 2)
        row[2*ai+axis] = 10
        rows.append(row)
        rhs.append(0.)
    main_index = min(scales) if scales else 0
    main = reliable[main_index] if reliable else edges[0]
    mi, mj = indices[main["i"]], indices[main["j"]]
    baseline = rotate_horizontal(main["direction"], yaws[mi])
    baseline /= np.linalg.norm(baseline)
    if main_index in scales:
        baseline *= scales[main_index]
    for axis in range(2):
        row = np.zeros(count * 2)
        row[2*mj+axis], row[2*mi+axis] = 10, -10
        rows.append(row)
        rhs.append(baseline[axis] * 10)
    matrix = np.asarray(rows)
    positions, _, rank, _ = np.linalg.lstsq(matrix, rhs, rcond=1e-5)
    rigid = bool(rank >= count * 2)
    if not rigid:
        # Keep every dimension that the image evidence actually constrains.
        # A diagram prior supplies only the unresolved null-space coordinates.
        _, _, vt = np.linalg.svd(matrix, full_matrices=matrix.shape[0] < matrix.shape[1])
        nullspace = vt[int(rank):].T
        positions += nullspace @ (nullspace.T @ (initial.reshape(-1) - positions))
    diagram_reference = positions.copy()
    origin = initial[ai].copy()
    initial -= origin
    # Angle residuals prevent a least-squares solution collapsing weak camera nodes.
    def position_residual(values):
        points = values.reshape(-1, 2)
        result = []
        for index, pair in enumerate(reliable):
            i, j = indices[pair["i"]], indices[pair["j"]]
            delta = points[j] - points[i]
            length = np.linalg.norm(delta)
            direction = rotate_horizontal(pair["direction"], yaws[i])
            direction /= max(1e-9, np.linalg.norm(direction))
            weight = math.sqrt(pair["confidence"])
            result.append((direction[0] * delta[1] - direction[1] * delta[0]) / max(.02, length) * weight)
            result.append(min(0., np.dot(direction, delta) / max(.02, length)) * weight * 2)
            if index in scales:
                result.append(math.log(max(.01, length) / scales[index]) * weight * .45)
        for first, second, log_ratio, weight in relative_ratios:
            lengths = []
            for index in (first, second):
                pair = reliable[index]
                lengths.append(max(.01, np.linalg.norm(points[indices[pair["j"]]] - points[indices[pair["i"]]])))
            result.append((math.log(lengths[1] / lengths[0]) - log_ratio) * weight * .45)
        if not rigid:
            # Stabilize only degrees of freedom unsupported by image evidence.
            # Per-edge unit-length priors would fight valid relative ratios.
            result.extend((nullspace.T @ (values - diagram_reference) * .025).tolist())
        result.extend((points[ai] * 10).tolist())
        result.extend(((points[mj] - points[mi] - baseline) * 10).tolist())
        return result
    optimized = least_squares(position_residual, positions, loss="soft_l1", f_scale=.1, max_nfev=140)
    positions = optimized.x.reshape(-1, 2)
    valid, angles = [], []
    for pair in reliable:
        i, j = indices[pair["i"]], indices[pair["j"]]
        delta = positions[j] - positions[i]
        direction = rotate_horizontal(pair["direction"], yaws[i])
        cosine = np.dot(delta, direction) / max(1e-9, np.linalg.norm(delta) * np.linalg.norm(direction))
        error = math.degrees(math.acos(np.clip(cosine, -1, 1)))
        if error < 18 and np.linalg.norm(delta) > .02:
            valid.append(pair)
            angles.append(error)
    # Sparse triangulated points remain candidates; no unsupported walls are drawn.
    cloud, tracks = [], {}
    for pair in valid:
        i, j = indices[pair["i"]], indices[pair["j"]]
        horizontal_length = np.linalg.norm(positions[j] - positions[i])
        horizontal_fraction = np.linalg.norm(pair["direction"][[0, 2]]) / max(1e-9, np.linalg.norm(pair["direction"]))
        length = horizontal_length / max(1e-9, horizontal_fraction)
        for point_index, point in enumerate(pair["_points"]):
            horizontal = rotate_horizontal(point, yaws[i]) * length + positions[i]
            if np.linalg.norm(horizontal - positions[i]) < 15 * length:
                world = [float(horizontal[0]), float(point[1] * length), float(horizontal[1])]
                cloud.append(world)
                if "_indices1" in pair:
                    tracks.setdefault((pair["i"], int(pair["_indices1"][point_index])), []).append(world)
                    tracks.setdefault((pair["j"], int(pair["_indices2"][point_index])), []).append(world)
    verified = []
    for observations in tracks.values():
        if len(observations) < 2:
            continue
        median = np.median(observations, axis=0)
        spread = np.max(np.linalg.norm(np.asarray(observations) - median, axis=1))
        if spread < .2:
            verified.append(median.tolist())
    # Surface detection only receives repeat observations that agree in 3D.
    surfaces = vertical_surfaces(verified, np.random.default_rng(738)) if rigid else []
    for pair in valid:
        pair["_surfaceCandidates"] = surfaces
    return positions, yaws, rigid, float(np.median(angles)) if angles else 180., valid, cloud[::max(1, math.ceil(len(cloud) / 3000))]


def reconstruct(payload):
    import cv2
    started = time.monotonic()
    cv2.setNumThreads(2)
    cv2.setRNGSeed(4729)
    scenes = payload.get("scenes", [])
    if not isinstance(scenes, list) or not 2 <= len(scenes) <= 300:
        raise ValueError("تحتاج المعالجة إلى صورتين على الأقل وبحد أقصى 300 صورة في المهمة")
    if len({scene["id"] for scene in scenes}) != len(scenes):
        raise ValueError("معرّفات اللقطات مكررة")
    profiles = payload.get("roomProfiles", {})
    if not isinstance(profiles, dict):
        raise ValueError("بيانات حدود الغرف غير صالحة")
    envelope_module = room_envelope_module() if profiles else None
    envelopes, profile_errors = {}, []
    for scene in scenes:
        profile = profiles.get(scene["id"])
        if profile is not None:
            try:
                envelopes[scene["id"]] = envelope_module.outline_from_profiles(profile)
            except (ValueError, KeyError, TypeError) as error:
                profile_errors.append({"id": scene["id"], "error": str(error)})
    output = Path(payload["outputDir"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = Path(payload.get("featureCacheDir") or output / "features")
    cache.mkdir(exist_ok=True)
    features = []
    for index, scene in enumerate(scenes):
        progress("features", index, len(scenes), sceneId=scene["id"])
        features.append(extract_features(scene["path"], cache))
    progress("features", len(scenes), len(scenes))
    candidates = [(i, j) for i in range(len(scenes)) for j in range(i + 1, len(scenes))
                  if scenes[i].get("floor", 0) == scenes[j].get("floor", 0)]
    if len(scenes) > 80:
        # Candidate retrieval only; every accepted edge still needs epipolar proof.
        chosen = set()
        for i, first in enumerate(features):
            distances = [(float(np.mean((first["signature"] - other["signature"]) ** 2)), j)
                         for j, other in enumerate(features) if j != i and scenes[i].get("floor", 0) == scenes[j].get("floor", 0)]
            for _, j in sorted(distances)[:18]:
                chosen.add((min(i, j), max(i, j)))
        # Whole-room appearance changes at doorways. Retain nearby capture-order
        # pairs as retrieval candidates too; they still need the SAME geometric proof.
        for i in range(len(scenes)):
            for j in range(i + 1, min(i + 4, len(scenes))):
                if scenes[i].get("floor", 0) == scenes[j].get("floor", 0):
                    chosen.add((i, j))
        candidates = sorted(chosen)
    rng, pairs, rejected = np.random.default_rng(4729), [], {}
    for index, (i, j) in enumerate(candidates):
        pair, reason = match_pair(features[i], features[j], rng)
        if pair:
            pair.update(i=i, j=j, a=scenes[i]["id"], b=scenes[j]["id"])
            if envelope_module and scenes[i]["id"] in envelopes and scenes[j]["id"] in envelopes:
                floor_evidence = envelope_module.infer_floor_baseline(pair, features[i], features[j], profiles.get(scenes[i]["id"]), profiles.get(scenes[j]["id"]))
                if floor_evidence:
                    pair["_floorBaseline"] = floor_evidence
            pairs.append(pair)
        else:
            rejected[reason] = rejected.get(reason, 0) + 1
        if index % 5 == 0 or index == len(candidates) - 1:
            progress("matching", index + 1, len(candidates), acceptedPairs=len(pairs))
    # A global appearance shortlist can strand a room whose doorway looks unlike
    # its interior. Search between the resulting components explicitly, while
    # retaining the same epipolar, parallax and gravity rejection thresholds.
    initial_components = connected_components(len(scenes), pairs)
    if len(initial_components) > 1 and len(scenes) > 80:
        tried = set(candidates)
        bridge_scores = {}
        for ci, first_group in enumerate(initial_components):
            for second_group in initial_components[ci + 1:]:
                ranked = []
                for i in first_group:
                    for j in second_group:
                        pair_key = (min(i, j), max(i, j))
                        if pair_key in tried or scenes[i].get("floor", 0) != scenes[j].get("floor", 0):
                            continue
                        score = float(np.mean((features[i]["signature"] - features[j]["signature"]) ** 2))
                        ranked.append((score, pair_key))
                bridge_scores.update((pair_key, score) for score, pair_key in sorted(ranked)[:4])
        bridges = sorted(sorted(bridge_scores, key=lambda pair: (bridge_scores[pair], pair))[:4 * len(scenes)])
        for index, (i, j) in enumerate(sorted(bridges)):
            pair, reason = match_pair(features[i], features[j], rng)
            if pair:
                pair.update(i=i, j=j, a=scenes[i]["id"], b=scenes[j]["id"])
                if envelope_module and scenes[i]["id"] in envelopes and scenes[j]["id"] in envelopes:
                    floor_evidence = envelope_module.infer_floor_baseline(pair, features[i], features[j], profiles.get(scenes[i]["id"]), profiles.get(scenes[j]["id"]))
                    if floor_evidence:
                        pair["_floorBaseline"] = floor_evidence
                pairs.append(pair)
            else:
                rejected[reason] = rejected.get(reason, 0) + 1
            if index % 5 == 0 or index == len(bridges)-1:
                progress("matching", len(candidates)+index+1, len(candidates)+len(bridges), acceptedPairs=len(pairs))
        candidates.extend(sorted(bridges))
    # Reject globally inconsistent edges before assigning component IDs. Otherwise
    # removal of one false loop can leave a disconnected map labelled connected.
    globally_consistent = []
    preliminary = connected_components(len(scenes), pairs)
    progress("layout", 0, 1)
    for index, nodes in enumerate(preliminary):
        _, _, _, _, valid, _ = solve_component(nodes, pairs)
        globally_consistent.extend(valid)
        progress("layout", 0, 1)
    components = connected_components(len(scenes), globally_consistent)
    result_scenes, result_components, accepted = {}, [], []
    progress("layout", 0, len(components))
    for index, nodes in enumerate(components):
        positions, yaws, rigid, error, valid, cloud = solve_component(nodes, globally_consistent)
        accepted.extend(valid)
        component_id = "component-" + str(index + 1)
        bearings = {node: [] for node in nodes}
        node_indices = {node: local for local, node in enumerate(nodes)}
        for pair in valid:
            forward, reverse = visual_pair_bearings(pair, float(yaws[node_indices[pair["i"]]]))
            bearings[pair["i"]].append({"targetId": pair["b"], "yaw": forward})
            bearings[pair["j"]].append({"targetId": pair["a"], "yaw": reverse})
        for local, node in enumerate(nodes):
            node_pairs = [pair for pair in valid if node in (pair["i"], pair["j"])]
            confidence = float(np.median([pair["confidence"] for pair in node_pairs])) if node_pairs else 0
            if not rigid:
                confidence *= .65
            result_scenes[node] = {"id": scenes[node]["id"], "floor": scenes[node].get("floor", 0),
                                   "position": {"x": round(float(positions[local, 0]), 5), "y": 0,
                                                "z": round(float(positions[local, 1]), 5)} if node_pairs else None,
                                   "yaw": round(math.degrees(float(yaws[local])), 4),
                                   "links": [pair["b"] if pair["i"] == node else pair["a"] for pair in node_pairs],
                                   "visualLinks": bearings[node],
                                   "confidence": round(confidence, 4), "component": component_id}
            if scenes[node]["id"] in envelopes:
                result_scenes[node]["roomEnvelope"] = envelopes[scenes[node]["id"]]
        result_components.append({"id": component_id, "sceneIds": [scenes[node]["id"] for node in nodes],
                                  "layout": "relative_reconstruction" if rigid else "topology_only",
                                  "bearingErrorDegrees": round(error, 3), "sparsePoints": cloud,
                                  "floorAnchoredPairs": sum(bool(pair.get("_floorBaseline")) for pair in valid),
                                  "scaleBasis": "camera_height" if any(pair.get("_floorBaseline") for pair in valid) else "unscaled",
                                  "surfaceCandidates": valid[0].get("_surfaceCandidates", []) if valid else []})
        progress("layout", index + 1, len(components))
    positioned = sum(scene["position"] is not None for scene in result_scenes.values())
    status = "ready" if positioned == len(scenes) and len(components) == 1 else "partial" if accepted else "insufficient_overlap"
    warnings = ["المواضع المستنتجة نسبية وليست بالمتر؛ الصور وحدها لا تحدد مقياس الشقة.",
                "الربط البصري يثبت تداخل الصور، ويحتاج مراجعة الممرات والأبواب قبل اعتماده للمشي.",
                "هذه إعادة بناء متناثرة ومسارات تقديرية، وليست مخطط جدران هندسيًا أو خرائط عمق للقياس."]
    if len(components) > 1:
        warnings.append(f"توجد {len(components)} مجموعات غير متصلة؛ لم تُخترع روابط بين الصور التي لا تتداخل بصريًا.")
    if any(not scene["links"] for scene in result_scenes.values()):
        warnings.append("بعض الصور بلا تطابق هندسي موثوق. أضف لقطات متداخلة عند الأبواب وبين الفراغات.")
    if any(component["layout"] == "topology_only" and len(component["sceneIds"]) > 1 for component in result_components):
        warnings.append("بعض المجموعات لا تحتوي زوايا رصد كافية لاستنتاج نسب المسافات؛ مخططها يوضح الاتصال فقط.")
    if any(component["surfaceCandidates"] for component in result_components):
        warnings.append("الخطوط المستنتجة تمثل أسطحًا رأسية مرصودة وقد تشمل أثاثًا؛ يلزم التحقق قبل اعتمادها كجدران.")
    if envelopes:
        warnings.append("حدود الغرف مستنتجة من صور الأرضية والسقف؛ الجدران المخفية تقديرية والمقياس بوحدات ارتفاع الكاميرا وليس بالمتر.")
    public_pairs = [{key: value for key, value in pair.items() if not key.startswith("_") and key not in ("i", "j", "direction", "yaw")}
                    | {"relativeYawDegrees": round(math.degrees(pair["yaw"]), 4), "translationDirection": pair["direction"].tolist(),
                       "kind": "visual_overlap", "walkability": "unverified"}
                    | ({"floorBaseline": pair["_floorBaseline"]} if pair.get("_floorBaseline") else {}) for pair in accepted]
    room_layout = envelope_module.aggregate_room_envelopes(list(result_scenes.values()), result_components, public_pairs, payload.get("roomObservations", []), accepted) if envelope_module else None
    corridor_observations = room_layout.get("observations", []) if room_layout else []
    if room_layout and room_layout["rooms"]:
        warnings = [warning for warning in warnings if "هذه إعادة بناء متناثرة" not in warning and "مخططها يوضح الاتصال فقط" not in warning]
        warnings.append("حدود الشقة مستنتجة من توافق مشاهد الأرضية والسقف؛ قد تحتاج المناطق المخفية أو المتعارضة إلى تصحيح، والمقياس نسبي.")
        if any(component["layout"] == "topology_only" and len(component["sceneIds"]) > 1 for component in result_components):
            warnings.append("بعض مواضع الغرف والمسافات بينها لا تملك رصدًا كافيًا؛ حدود الغرف مستنتجة من الصور لكن توزيعها يحتاج مراجعة.")
        for component in result_components:
            component["rooms"] = [room for room in room_layout["rooms"] if room["component"] == component["id"]]
    return {"version": VERSION, "status": status, "scale": "relative", "scenes": [result_scenes[i] for i in range(len(scenes))],
            "pairs": public_pairs, "components": result_components, "warnings": warnings,
            **({"roomLayout": room_layout, "roomRelations": room_layout["relations"], "roomObservations": corridor_observations} if room_layout else {}),
            "diagnostics": {"imageCount": len(scenes), "candidatePairs": len(candidates), "geometricPairs": len(pairs),
                            "acceptedPairs": len(accepted), "features": [len(feature["points"]) for feature in features],
                            "roomEnvelopes": len(envelopes), "floorAnchoredPairs": sum(bool(pair.get("_floorBaseline")) for pair in accepted),
                            "profileErrors": profile_errors,
                            "rejections": rejected, "elapsedSeconds": round(time.monotonic() - started, 2),
                            "method": "RootSIFT / spherical essential RANSAC / gravity-aligned bearing graph"}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        with open(args.input, encoding="utf-8-sig") as stream:
            payload = json.load(stream)
        result = reconstruct(payload)
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(destination)
        print(json.dumps({"event": "complete", "status": result["status"]}), flush=True)
    except Exception as error:
        print(json.dumps({"event": "error", "message": str(error)}, ensure_ascii=False), flush=True)
        raise


if __name__ == "__main__":
    main()

