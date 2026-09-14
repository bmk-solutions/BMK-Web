"""Experimental pixel-derived room envelopes for level 360-degree panoramas.

The camera height is one arbitrary unit. Floor/ceiling image evidence estimates
the visible envelope; this is neither metric survey data nor furnished geometry.
No saved floor plan, camera position or room template participates in inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys

if os.environ.get("IMO3D_CV_PATH"):
    sys.path.insert(0, os.environ["IMO3D_CV_PATH"])
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d, map_coordinates
from scipy.signal import find_peaks


def polygon_radii(outline, angles):
    """First positive intersection of a horizontal camera ray and a polygon."""
    polygon = np.asarray(outline, dtype=float).reshape(-1, 2)
    a, edge = polygon, np.roll(polygon, -1, axis=0) - polygon
    ray = np.column_stack((np.sin(angles), -np.cos(angles)))
    cross = ray[:, None, 0] * edge[None, :, 1] - ray[:, None, 1] * edge[None, :, 0]
    numerator = a[:, 0] * edge[:, 1] - a[:, 1] * edge[:, 0]
    with np.errstate(divide="ignore", invalid="ignore"):
        radius = numerator[None, :] / cross
        fraction = (a[None, :, 0] * ray[:, None, 1] - a[None, :, 1] * ray[:, None, 0]) / cross
    valid = (np.abs(cross) > 1e-10) & (radius > 0) & (fraction >= -1e-7) & (fraction <= 1 + 1e-7)
    return np.min(np.where(valid, radius, np.inf), axis=1)


def fit_observed_wall_lines(points, nearest):
    """Fit each observed segment independently, preserving non-right-angle walls."""
    count = len(points)
    lines = []
    for index, start in enumerate(nearest):
        end = nearest[(index + 1) % len(nearest)]
        members = np.arange(start, end if end > start else end + count) % count
        # Corner samples can straddle the two faces. Fit the segment interior.
        trim = max(1, len(members) // 12)
        if len(members) < 8:
            return None
        samples = points[members[trim:-trim]]
        kept = samples
        for _ in range(3):
            center = np.median(kept, axis=0)
            _, singular, vectors = np.linalg.svd(kept - center, full_matrices=False)
            if singular[0] < 1e-8:
                return None
            normal = vectors[-1]
            offset = float(np.median(kept @ normal))
            residual = np.abs(samples @ normal - offset)
            threshold = max(.005, float(np.median(residual)) * 3)
            kept = samples[residual <= threshold]
            if len(kept) < max(4, len(samples) // 2):
                return None
        lines.append((normal, offset, samples))
    # A corner detector can split a single straight wall into two segments.
    # Merge only when both sets of observed samples support the same plane.
    changed = True
    while changed and len(lines) > 4:
        changed = False
        for index, (normal, offset, samples) in enumerate(lines):
            next_normal, next_offset, next_samples = lines[(index + 1) % len(lines)]
            if normal @ next_normal < 0:
                next_normal, next_offset = -next_normal, -next_offset
            if normal @ next_normal < math.cos(math.radians(3)) or abs(offset - next_offset) > .025:
                continue
            merged_normal = normal + next_normal
            merged_normal /= np.linalg.norm(merged_normal)
            merged_samples = np.concatenate((samples, next_samples))
            merged_offset = float(np.median(merged_samples @ merged_normal))
            if np.quantile(np.abs(merged_samples @ merged_normal - merged_offset), .95) > .025:
                continue
            merged = (merged_normal, merged_offset, merged_samples)
            if index == len(lines) - 1:
                lines = [merged] + lines[1:-1]
            else:
                lines[index:index + 2] = [merged]
            changed = True
            break
    vertices = []
    for index, (normal, offset, _) in enumerate(lines):
        previous, previous_offset, _ = lines[index - 1]
        matrix = np.array([previous, normal])
        if abs(np.linalg.det(matrix)) < .12:
            return None
        vertices.append(np.linalg.solve(matrix, [previous_offset, offset]))
    return np.asarray(vertices)


def regularize_outline(radii, orientation=None, corner_probabilities=None):
    """Fit observed contour segments; a concave room is never replaced by a hull."""
    width = len(radii)
    angles = (np.arange(width) / width - .5) * 2 * np.pi
    points = np.column_stack((np.sin(angles) * radii, -np.cos(angles) * radii))
    tolerance = max(.025, float(np.median(radii)) * .018)
    raw = cv2.approxPolyDP(points.astype(np.float32), tolerance, True).reshape(-1, 2).astype(float)
    if corner_probabilities is not None:
        probabilities = np.asarray(corner_probabilities, dtype=float)
        if probabilities.shape == radii.shape and np.all(np.isfinite(probabilities)):
            peaks = find_peaks(np.tile(probabilities, 3), height=max(.05, float(np.max(probabilities)) * .12),
                               prominence=.03, distance=max(12, width // 40))[0]
            peaks = peaks[(peaks >= width) & (peaks < 2 * width)] - width
            if 4 <= len(peaks) <= 24:
                raw = points[peaks]
    if not 4 <= len(raw) <= 40:
        return raw, {"regularized": False, "reason": "insufficient_straight_boundary_evidence"}
    edges = np.roll(raw, -1, axis=0) - raw
    if orientation is None:
        edge_angles = np.arctan2(edges[:, 0], -edges[:, 1])
        weights = np.linalg.norm(edges, axis=1)
        orientation = float(np.angle(np.sum(weights * np.exp(4j * edge_angles))) / 4)
    c, s = math.cos(orientation), math.sin(orientation)
    rotation = np.array([[c, -s], [s, c]])
    local = points @ rotation
    raw_local = raw @ rotation
    nearest = [int(np.argmin(np.linalg.norm(points - p, axis=1))) for p in raw]
    local_edges = np.roll(raw_local, -1, axis=0) - raw_local
    deviation = np.arctan2(np.min(np.abs(local_edges), axis=1), np.max(np.abs(local_edges), axis=1))
    # A dominant orientation does not prove that every wall is orthogonal.
    # Preserve oblique faces instead of coercing a trapezoid into a rectangle.
    if np.any(deviation > math.radians(7)):
        polygon = fit_observed_wall_lines(points, nearest)
        movement_limit = max(.08, tolerance * 4)
        if polygon is not None and max(abs(cv2.pointPolygonTest(polygon.astype(np.float32), tuple(map(float, point)), True)) for point in raw) <= movement_limit and np.max(np.min(np.linalg.norm(polygon[:, None] - raw[None, :], axis=2), axis=1)) <= movement_limit:
            predicted = polygon_radii(polygon, angles)
            error = np.abs(np.arctan(1 / predicted) - np.arctan(1 / radii))
            if np.all(np.isfinite(predicted)) and np.quantile(error, .9) <= math.radians(3):
                return polygon, {"regularized": True, "method": "observed-independent-wall-lines",
                                 "boundaryResidualDegrees": round(float(np.degrees(np.quantile(error, .9))), 4)}
        return raw, {"regularized": False, "reason": "oblique_wall_fit_unsupported"}
    lines = []
    for index, start in enumerate(nearest):
        end = nearest[(index + 1) % len(nearest)]
        members = np.arange(start, end if end > start else end + width) % width
        if len(members) < 3:
            return raw, {"regularized": False, "reason": "short_boundary_segment"}
        delta = raw_local[(index + 1) % len(raw)] - raw_local[index]
        axis = 1 if abs(delta[0]) > abs(delta[1]) else 0
        values = local[members, axis]
        lines.append({"axis": axis, "value": float(np.median(values)), "members": members})
    # Merge nearly collinear fragments. Parallel offsets require an observed
    # connecting segment; no unseen wall is manufactured to bridge them.
    changed = True
    while changed and len(lines) > 4:
        changed = False
        for index, line in enumerate(lines):
            following = lines[(index + 1) % len(lines)]
            if line["axis"] == following["axis"] and abs(line["value"] - following["value"]) < tolerance * 3:
                members = np.concatenate((line["members"], following["members"]))
                merged = {"axis": line["axis"], "value": float(np.median(local[members, line["axis"]])), "members": members}
                if index == len(lines) - 1:
                    lines = [merged] + lines[1:-1]
                else:
                    lines[index:index + 2] = [merged]
                changed = True
                break
    if any(line["axis"] == lines[index - 1]["axis"] for index, line in enumerate(lines)):
        return raw, {"regularized": False, "reason": "parallel_boundary_ambiguity"}
    vertices = []
    for index, line in enumerate(lines):
        previous = lines[index - 1]
        corner = np.zeros(2)
        corner[line["axis"]], corner[previous["axis"]] = line["value"], previous["value"]
        vertices.append(corner)
    polygon = np.asarray(vertices) @ rotation.T
    predicted = polygon_radii(polygon, angles)
    error = np.abs(np.arctan(1 / predicted) - np.arctan(1 / radii))
    if not np.all(np.isfinite(predicted)) or np.quantile(error, .9) > math.radians(3):
        return raw, {"regularized": False, "reason": "wall_fit_disagrees_with_image_profile"}
    return polygon, {"regularized": True, "orientationRadians": orientation,
                     "boundaryResidualDegrees": round(float(np.degrees(np.quantile(error, .9))), 4)}


def outline_from_profiles(profile, orientation=None):
    """Convert learned per-column angular boundaries to a local room polygon.

    Positive floor pitch points downwards; negative ceiling pitch points upwards.
    The origin is the camera; +X is image-right and -Z is the panorama centre.
    """
    floor = np.asarray(profile["floorBoundaryRadians"], dtype=float)
    ceiling = np.asarray(profile["ceilingBoundaryRadians"], dtype=float)
    if floor.ndim != 1 or ceiling.shape != floor.shape or not 128 <= len(floor) <= 4096 or not np.all(np.isfinite(floor)) or not np.all(np.isfinite(ceiling)):
        raise ValueError("Invalid floor/ceiling boundary arrays")
    valid = (floor > .015) & (floor < 1.48) & (ceiling < -.015) & (ceiling > -1.48)
    if np.mean(valid) < .97:
        raise ValueError("Predicted boundary has insufficient valid angular coverage")
    if not np.all(valid):
        index = np.arange(len(floor))
        floor = np.interp(index, index[valid], floor[valid], period=len(floor))
        ceiling = np.interp(index, index[valid], ceiling[valid], period=len(floor))
    ratios = np.tan(-ceiling) / np.tan(floor)
    ratio = float(np.median(ratios))
    ratio_deviation = float(np.median(np.abs(np.log(ratios / ratio))))
    if not .2 <= ratio <= 3:
        raise ValueError("Predicted floor and ceiling heights are inconsistent")
    floor_radii = 1 / np.tan(floor)
    ceiling_radii = ratio / np.tan(-ceiling)
    # A cabinet or bed can occlude a wall's floor junction while its ceiling
    # junction is visible. Use that independent boundary where it supports a
    # modest extension; large disagreements remain low-confidence evidence.
    radii = np.maximum(floor_radii, np.minimum(ceiling_radii, floor_radii * 1.5))
    radii = np.exp(gaussian_filter1d(np.log(radii), .8, mode="wrap"))
    polygon, fit = regularize_outline(radii, orientation, profile.get("cornerProbabilities"))
    if len(polygon) < 4 or len(polygon) > 40:
        raise ValueError("Predicted boundary is too fragmented for a room outline")
    confidence = .8 * math.exp(-ratio_deviation * 3)
    if not fit["regularized"]:
        confidence *= .75
    return {"version": 1, "method": "learned-spherical-boundary-projection", "scale": "camera_height",
            "classification": "estimated_room_envelope", "cameraHeight": 1, "ceilingAboveCamera": round(ratio, 5),
            "confidence": round(confidence, 4),
            "outline": [{"x": round(float(x), 5), "z": round(float(z), 5)} for x, z in polygon],
            "evidence": {**fit, "heightRatioLogDeviation": round(ratio_deviation, 5), "validAngularFraction": float(np.mean(valid)),
                         "ceilingSupportedFraction": round(float(np.mean(ceiling_radii > floor_radii * 1.05)), 4)},
            "warnings": ["Room envelope inferred from image boundaries; occluded walls remain estimates.", "Camera-height units, not metres."]}


def infer_floor_baseline(pair, first, second, first_profile, second_profile):
    """Recover a two-view baseline in camera-height units from supported floor tracks.

    Furniture below the predicted wall boundary is rejected by a two-view,
    horizontal-plane consensus, rather than being treated as floor automatically.
    """
    if first_profile is None or second_profile is None:
        return None
    rays1 = first["bearings"][pair["_indices1"]]
    rays2 = second["bearings"][pair["_indices2"]]
    depths1, depths2 = np.asarray(pair["_depths1"]), np.asarray(pair["_depths2"])
    def floor_mask(rays, profile):
        boundary = np.asarray(profile["floorBoundaryRadians"], dtype=float)
        longitude = (np.arctan2(rays[:, 0], -rays[:, 2]) / (2 * np.pi) + .5) * len(boundary)
        limit = np.interp(longitude, np.arange(len(boundary)), boundary, period=len(boundary))
        downward = np.arcsin(np.clip(-rays[:, 1], -1, 1))
        return (downward > limit + math.radians(2)) & (downward > math.radians(7)) & (downward < math.radians(78))
    h1, h2 = -rays1[:, 1] * depths1, -rays2[:, 1] * depths2
    valid = floor_mask(rays1, first_profile) & floor_mask(rays2, second_profile)
    valid &= (h1 > .025) & (h2 > .025) & np.isfinite(h1) & np.isfinite(h2)
    valid &= np.abs(np.log(np.maximum(.001, h1) / np.maximum(.001, h2))) < .14
    if np.count_nonzero(valid) < 12:
        return None
    heights = np.sqrt(h1[valid] * h2[valid])
    logarithms = np.log(heights)
    residuals = np.abs(logarithms[:, None] - logarithms[None, :])
    counts = np.count_nonzero(residuals < .075, axis=1)
    eligible = (counts >= 12) & (counts >= len(heights) * .30)
    if not np.any(eligible):
        return None
    # The lower physical plane has the greater camera-to-plane distance.
    # Require meaningful support: a lone distant outlier cannot win.
    centre = float(np.max(logarithms[eligible]))
    consensus = np.abs(logarithms - centre) < .085
    height = float(np.median(heights[consensus]))
    consensus = np.abs(np.log(heights / height)) < .085
    selected = np.flatnonzero(valid)[consensus]
    if len(selected) < 12:
        return None
    spread = np.linalg.eigvalsh(np.cov((rays1[selected] * depths1[selected, None])[:, [0, 2]].T))
    if not np.all(np.isfinite(spread)) or spread[0] < height * height * .006:
        return None
    deviation = float(np.median(np.abs(np.log(heights[consensus] / height))))
    if deviation > .045:
        return None
    return {"baseline": 1 / height, "confidence": round(min(.95, .4 + len(selected) / 150 + .25 * len(selected) / len(heights)), 4),
            "supportPoints": len(selected), "candidatePoints": len(heights), "floorHeightLogDeviation": round(deviation, 5),
            "scale": "camera_height", "method": "two-view-floor-plane-consensus"}


def footprint_overlap(first, second):
    """Bounded raster intersection supports concave polygons without convex hulls."""
    a, b = np.asarray(first, dtype=float), np.asarray(second, dtype=float)
    low = np.minimum(a.min(axis=0), b.min(axis=0)) - .05
    high = np.maximum(a.max(axis=0), b.max(axis=0)) + .05
    step = max(.015, float(np.max(high - low)) / 384)
    size = np.ceil((high - low) / step).astype(int) + 2
    masks = []
    for polygon in [a, b]:
        mask = np.zeros((int(size[1]), int(size[0])), dtype=np.uint8)
        cv2.fillPoly(mask, [np.rint((polygon - low) / step).astype(np.int32)], 1)
        masks.append(mask.astype(bool))
    intersection = int(np.count_nonzero(masks[0] & masks[1]))
    union = int(np.count_nonzero(masks[0] | masks[1]))
    areas = [int(np.count_nonzero(mask)) for mask in masks]
    return intersection / max(1, union), intersection / max(1, min(areas)), max(areas) / max(1, min(areas))


def aggregate_room_envelopes(scenes, components, pairs, observations=None, image_pairs=None):
    """Fuse matching room observations only within an established component frame."""
    by_id = {scene["id"]: scene for scene in scenes}
    frames = {component["id"]: component for component in components}
    kinds = {}
    for observation in observations or []:
        if observation.get("sceneId") not in by_id or observation.get("kind") in (None, "unknown") or observation.get("confidence", 0) < .75:
            continue
        previous = kinds.get(observation["sceneId"])
        if previous is None or observation["confidence"] > previous["confidence"]:
            kinds[observation["sceneId"]] = observation
    def compatible(a, b):
        first, second = kinds.get(a), kinds.get(b)
        return not first or not second or first["kind"] == second["kind"] or {first["kind"], second["kind"]} <= {"corridor", "entrance"}
    footprints = {}
    for scene in scenes:
        if not scene.get("position") or not scene.get("roomEnvelope") or frames[scene["component"]].get("scaleBasis") != "camera_height":
            continue
        polygon = np.asarray([[point["x"], point["z"]] for point in scene["roomEnvelope"]["outline"]])
        yaw = math.radians(scene["yaw"])
        rotation = np.array([[math.cos(yaw), -math.sin(yaw)], [math.sin(yaw), math.cos(yaw)]])
        origin = np.array([scene["position"]["x"], scene["position"]["z"]])
        footprints[scene["id"]] = polygon @ rotation.T + origin
    similarity = {}
    def overlap(a, b):
        key = tuple(sorted([a, b]))
        if key not in similarity:
            similarity[key] = footprint_overlap(footprints[a], footprints[b])
        return similarity[key]
    groups = [{scene_id} for scene_id in footprints]
    candidates = []
    for pair in pairs:
        a, b = pair["a"], pair["b"]
        if a not in footprints or b not in footprints or by_id[a]["component"] != by_id[b]["component"] or by_id[a]["floor"] != by_id[b]["floor"] or not compatible(a, b):
            continue
        iou, contained, area_ratio = overlap(a, b)
        def contains(camera, polygon):
            position = by_id[camera]["position"]
            return cv2.pointPolygonTest(polygon.astype(np.float32), (float(position["x"]), float(position["z"])), True) >= -.12
        if (iou >= .58 or contained >= .87 and area_ratio < 1.65) and contains(a, footprints[b]) and contains(b, footprints[a]):
            candidates.append((iou, a, b))
    for _, a, b in sorted(candidates, reverse=True):
        first = next(group for group in groups if a in group)
        second = next(group for group in groups if b in group)
        if first is second:
            continue
        if any(not compatible(i, j) for i in first for j in second):
            continue
        cross = [overlap(i, j)[0] for i in first for j in second]
        if min(cross) < .25 or np.mean(cross) < .43:
            continue
        first.update(second)
        groups.remove(second)
    rooms, room_by_scene = [], {}
    for group in groups:
        members = sorted(group)
        representative = max(members, key=lambda scene_id: by_id[scene_id]["roomEnvelope"]["confidence"] * .3 +
                             np.mean([overlap(scene_id, other)[0] if other != scene_id else 1 for other in members]))
        anchor = np.array([by_id[representative]["position"]["x"], by_id[representative]["position"]["z"]])
        angles = (np.arange(720) / 720 - .5) * 2 * np.pi
        radial = np.asarray([polygon_radii(footprints[scene_id] - anchor, angles) for scene_id in members])
        radial[~np.isfinite(radial)] = np.nan
        radius = np.nanmedian(radial, axis=0)
        if not np.all(np.isfinite(radius)):
            polygon = footprints[representative]
        else:
            polygon, _ = regularize_outline(radius)
            polygon += anchor
        if not 4 <= len(polygon) <= 40:
            polygon = footprints[representative]
        confidence = float(np.median([by_id[scene_id]["roomEnvelope"]["confidence"] for scene_id in members]))
        coherence = float(np.mean([overlap(a, b)[0] for i, a in enumerate(members) for b in members[i + 1:]])) if len(members) > 1 else None
        room_id = "room-" + members[0]
        room = {"id": room_id, "floor": by_id[representative]["floor"], "component": by_id[representative]["component"],
                "frame": "component", "scale": "camera_height", "sceneIds": members, "representativeSceneId": representative,
                "outline": [{"x": round(float(x), 5), "z": round(float(z), 5)} for x, z in polygon],
                "ceilingHeight": round(float(np.median([1 + by_id[scene_id]["roomEnvelope"]["ceilingAboveCamera"] for scene_id in members])), 4),
                "ceilingAboveCamera": round(float(np.median([by_id[scene_id]["roomEnvelope"]["ceilingAboveCamera"] for scene_id in members])), 4),
                "openings": [],
                "confidence": round(confidence, 4), "classification": "estimated_room_envelope",
                "evidence": {"method": "multi-view-boundary-median" if len(members) > 1 else "single-panorama-boundary", "observations": len(members), "footprintCoherence": coherence}}
        rooms.append(room)
        room_by_scene.update({scene_id: room_id for scene_id in members})
    rooms, excluded = partition_room_regions(rooms)
    retained_rooms = {room["id"] for room in rooms}
    room_by_scene = {scene_id: room_id for scene_id, room_id in room_by_scene.items() if room_id in retained_rooms}
    membership_relations = []
    # Rejecting a doorway's shape need not create a second kitchen identity.
    # Reassociate only a directly matched photograph whose observed footprint
    # substantially agrees with exactly one retained room. Its contour is never
    # allowed back into the wall estimate.
    neighbours = {}
    for pair in pairs:
        neighbours.setdefault(pair["a"], set()).add(pair["b"])
        neighbours.setdefault(pair["b"], set()).add(pair["a"])
    for scene_id in sorted(set(footprints) - set(room_by_scene)):
        choices = []
        position = by_id[scene_id]["position"]
        for room in rooms:
            linked = neighbours.get(scene_id, set()).intersection(room["sceneIds"])
            if not linked or room["component"] != by_id[scene_id]["component"] or room["floor"] != by_id[scene_id]["floor"] or any(not compatible(scene_id, member) for member in room["sceneIds"]):
                continue
            polygon = np.asarray([[p["x"], p["z"]] for p in room["outline"]])
            iou, contained, area_ratio = footprint_overlap(footprints[scene_id], polygon)
            distance = cv2.pointPolygonTest(polygon.astype(np.float32), (float(position["x"]), float(position["z"])), True)
            if iou < .4 or contained < .65 or area_ratio > 1.65 or distance < -.3:
                continue
            choices.append((iou, contained, room, sorted(linked)[0]))
        choices.sort(key=lambda choice: choice[0], reverse=True)
        if not choices or len(choices) > 1 and choices[0][0] - choices[1][0] < .15:
            continue
        iou, contained, room, linked = choices[0]
        room.setdefault("boundarySceneIds", room["sceneIds"][:])
        room["sceneIds"] = sorted([*room["sceneIds"], scene_id])
        confidence = round(.70 + .15 * iou + .10 * contained, 4)
        verified = iou >= .58 and contained >= .87
        room["evidence"].setdefault("membershipAssignments", []).append({"sceneId": scene_id, "confidence": confidence, "needsReview": not verified, "method": "matched-excluded-boundary-overlap"})
        room_by_scene[scene_id] = room["id"]
        membership_relations.append({"id": "room-membership-" + hashlib.sha256("/".join(sorted([scene_id, linked])).encode()).hexdigest()[:24],
                                     "fromId": scene_id, "toId": linked, "kind": "same_room", "confidence": confidence, "verified": verified,
                                     **({"provisional": True} if not verified else {})})
    for room in rooms:
        room["id"] = "room-" + min(room["sceneIds"])
    room_by_scene = {scene_id: room["id"] for room in rooms for scene_id in room["sceneIds"]}
    relations = membership_relations
    for iou, a, b in candidates:
        if room_by_scene.get(a) and room_by_scene.get(a) == room_by_scene.get(b):
            relations.append({"id": "room-overlap-" + hashlib.sha256("/".join(sorted([a, b])).encode()).hexdigest()[:24],
                              "fromId": a, "toId": b, "kind": "same_room", "confidence": round(.78 + .20 * iou, 4),
                              "verified": iou >= .58})
    connections = {}
    for pair in pairs:
        a, b = room_by_scene.get(pair["a"]), room_by_scene.get(pair["b"])
        if not a or not b or a == b:
            continue
        key = tuple(sorted([a, b]))
        relation = connections.setdefault(key, {"a": key[0], "b": key[1], "kind": "observed_visual_connection", "walkability": "unverified", "scenePairs": []})
        relation["scenePairs"].append({"a": pair["a"], "b": pair["b"], "confidence": pair["confidence"]})
    corridor_observations = infer_corridor_observations(rooms, scenes, list(connections.values()), observations)
    threshold_connections = observed_threshold_connections(rooms, scenes, pairs)
    architecture = {}
    rooms, wall_contacts = align_observed_wall_contacts(rooms, scenes, [*connections.values(), *threshold_connections], image_pairs or [], architecture)
    return {"rooms": rooms, "relations": relations, "observations": corridor_observations, "connections": list(connections.values()), "wallContacts": wall_contacts, "excludedObservations": excluded,
            **architecture, "thresholdConnections": threshold_connections,
            "unplacedEnvelopeSceneIds": [scene["id"] for scene in scenes if scene.get("roomEnvelope") and scene["id"] not in room_by_scene]}


def partition_room_regions(rooms):
    """Resolve contradictory footprint overlap using observation support, not a template."""
    polygons = {room["id"]: np.asarray([[p["x"], p["z"]] for p in room["outline"]]) for room in rooms}
    excluded, retained = [], []
    for room in rooms:
        contradictory = []
        if len(room["sceneIds"]) == 1 and room["confidence"] < .8:
            for other in rooms:
                if other is room or other["component"] != room["component"] or other["floor"] != room["floor"] or len(other["sceneIds"]) < 2:
                    continue
                iou, contained, _ = footprint_overlap(polygons[room["id"]], polygons[other["id"]])
                if iou > .25 or contained > .65:
                    contradictory.append(other["id"])
        if len(contradictory) >= 2:
            excluded.append({"sceneIds": room["sceneIds"], "reason": "single_view_spans_multiple_supported_rooms", "contradicts": contradictory})
        else:
            retained.append(room)
    groups = {}
    for room in retained:
        groups.setdefault((room["component"], room["floor"]), []).append(room)
    output = []
    for members in groups.values():
        all_points = np.concatenate([polygons[room["id"]] for room in members])
        low, high = all_points.min(axis=0) - .05, all_points.max(axis=0) + .05
        step = max(.012, float(np.max(high - low)) / 900)
        size = np.ceil((high - low) / step).astype(int) + 3
        masks, scores = [], []
        for room in members:
            mask = np.zeros((int(size[1]), int(size[0])), dtype=np.uint8)
            cv2.fillPoly(mask, [np.rint((polygons[room["id"]] - low) / step).astype(np.int32)], 1)
            interior = cv2.distanceTransform(mask, cv2.DIST_L2, 3) * step
            support = room["confidence"] * (1 + .35 * math.log1p(len(room["sceneIds"])))
            scores.append(np.where(mask, support + np.minimum(.18, interior * .12), -100.))
            masks.append(mask)
        winner = np.argmax(np.asarray(scores), axis=0)
        for index, room in enumerate(members):
            own = masks[index].astype(bool)
            partition = own & (winner == index)
            if np.array_equal(partition, own):
                output.append(room)
                continue
            fraction = float(np.count_nonzero(partition) / max(1, np.count_nonzero(own)))
            # A thin remnant around a stronger footprint is a conflicting
            # observation, not a new room. Exterior-only contours would also
            # silently fill holes and recreate the overlap we just removed.
            if fraction < .5:
                excluded.append({"sceneIds": room["sceneIds"], "reason": "boundary_mostly_contradicted_by_supported_rooms"})
                continue
            contours, hierarchy = cv2.findContours(partition.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                excluded.append({"sceneIds": room["sceneIds"], "reason": "weaker_duplicate_boundary_observation"})
                continue
            contour = max(contours, key=cv2.contourArea)
            contour_index = next(i for i, candidate in enumerate(contours) if candidate is contour)
            if hierarchy[0, contour_index, 2] != -1:
                excluded.append({"sceneIds": room["sceneIds"], "reason": "overlap_requires_unobserved_room_partition"})
                continue
            polygon = cv2.approxPolyDP(contour, max(.6, .025 / step), True).reshape(-1, 2) * step + low
            if len(polygon) < 4 or len(polygon) > 64:
                excluded.append({"sceneIds": room["sceneIds"], "reason": "ambiguous_overlapping_boundary"})
                continue
            output.append({**room, "outline": [{"x": round(float(x), 5), "z": round(float(z), 5)} for x, z in polygon],
                           "confidence": round(room["confidence"] * max(.6, fraction), 4),
                           "evidence": {**room["evidence"], "overlapResolution": "observation-supported-region-partition", "retainedAreaFraction": round(fraction, 4)}})
    return output, excluded


def segment_wall_hits(origin, destination, polygon):
    """Finite camera sightline intersections; each result names an observed edge."""
    direction = destination - origin
    cross = lambda a, b: a[0] * b[1] - a[1] * b[0]
    hits = []
    for index, start in enumerate(polygon):
        edge = polygon[(index + 1) % len(polygon)] - start
        denominator = cross(direction, edge)
        if abs(denominator) < 1e-9 or np.linalg.norm(edge) < 1e-5:
            continue
        distance, fraction = cross(start - origin, edge) / denominator, cross(start - origin, direction) / denominator
        if 0 < distance < 1 and 0 <= fraction <= 1:
            hits.append((distance, fraction, index, origin + distance * direction, edge / np.linalg.norm(edge)))
    return sorted(hits, key=lambda hit: hit[0])


def segment_interior_length(origin, destination, polygon, minimum_depth=.03):
    """Measure substantive third-room crossings, ignoring a grazed corner.

    Intersection intervals handle concave outlines and very thin intervening
    regions without depending on a fixed number of whole-segment samples.
    """
    length = float(np.linalg.norm(destination - origin))
    if length < 1e-8:
        return 0.
    cuts = sorted(set([0., 1., *[float(hit[0]) for hit in segment_wall_hits(origin, destination, polygon)]]))
    occupied = 0.
    for low, high in zip(cuts, cuts[1:]):
        # A convex corner can contain an interval while the midpoint is still
        # too close to the edge to establish an intervening physical region.
        points = [origin + (low + (high - low) * fraction) * (destination - origin) for fraction in [.25, .5, .75]]
        depth = max(cv2.pointPolygonTest(polygon.astype(np.float32), tuple(map(float, point)), True) for point in points)
        if depth > minimum_depth:
            occupied += (high - low) * length
    return occupied


def observed_threshold_connections(rooms, scenes, pairs):
    """Resolve one unassigned doorway capture, never arbitrary graph paths.

    Two independently matched photographs on each side must put the capture
    near exactly two observed room boundaries in the same existing frame.
    This only supplies candidates to image-ray validation; it cuts no doorway.
    """
    assigned = {scene_id for room in rooms for scene_id in room["sceneIds"]}
    polygons = {room["id"]: np.asarray([[p["x"], p["z"]] for p in room["outline"]], np.float32) for room in rooms}
    neighbours = {}
    for pair in pairs:
        if pair.get("confidence", 0) >= .5:
            neighbours.setdefault(pair["a"], {})[pair["b"]] = pair
            neighbours.setdefault(pair["b"], {})[pair["a"]] = pair
    result = []
    for scene in scenes:
        if scene["id"] in assigned or not scene.get("position"):
            continue
        camera = (float(scene["position"]["x"]), float(scene["position"]["z"]))
        candidates = []
        for room in rooms:
            if room["component"] != scene.get("component") or room["floor"] != scene.get("floor", 0):
                continue
            linked = set(room["sceneIds"]).intersection(neighbours.get(scene["id"], {}))
            distance = cv2.pointPolygonTest(polygons[room["id"]], camera, True)
            if len(linked) >= 2 and max(neighbours[scene["id"]][key]["confidence"] for key in linked) >= .8 and -.45 <= distance <= .12:
                candidates.append((room, linked))
        if len(candidates) != 2:
            continue
        chosen = {candidate[0]["id"] for candidate in candidates}
        if any(room["id"] not in chosen and room["component"] == scene.get("component")
               and room["floor"] == scene.get("floor", 0) and cv2.pointPolygonTest(polygons[room["id"]], camera, True) > .03 for room in rooms):
            continue
        evidence = []
        for _, linked in candidates:
            for key in sorted(linked):
                pair = neighbours[scene["id"]][key]
                evidence.append({"a": pair["a"], "b": pair["b"], "confidence": pair["confidence"], "viaSceneId": scene["id"]})
        a, b = sorted(chosen)
        result.append({"a": a, "b": b, "kind": "unassigned_threshold_observation", "walkability": "unverified",
                       "verified": False, "viaSceneId": scene["id"], "scenePairs": evidence})
    return result


def collect_observed_room_crossings(rooms, scenes, connections, image_pairs):
    """Collect finite matched-image rays through two room boundary faces.

    A threshold photograph may lie just outside a fused contour. Its partner
    inside the other room can still observe rays through both faces; neither
    camera nor polygon is moved to manufacture those intersections. A third
    room between the views makes this a sightline, never a direct doorway.
    """
    by_room = {room["id"]: room for room in rooms}
    cameras = {scene["id"]: scene for scene in scenes}
    polygons = {room["id"]: np.asarray([[p["x"], p["z"]] for p in room["outline"]], dtype=float) for room in rooms}
    private_pairs = {frozenset([pair["a"], pair["b"]]): pair for pair in image_pairs if len(pair.get("_points", []))}
    position = lambda scene: np.array([scene["position"]["x"], scene["position"]["z"]], dtype=float)
    inside = lambda point, polygon: cv2.pointPolygonTest(polygon.astype(np.float32), tuple(map(float, point)), True)
    groups, diagnostics = {}, []
    for connection in connections:
        a, b = connection["a"], connection["b"]
        first, second = by_room.get(a), by_room.get(b)
        if not first or not second or first["component"] != second["component"] or first["floor"] != second["floor"]:
            continue
        others = {key: polygon for key, polygon in polygons.items() if key not in (a, b)
                  and by_room[key]["component"] == first["component"] and by_room[key]["floor"] == first["floor"]}
        for evidence in connection["scenePairs"]:
            ids = [evidence["a"], evidence["b"]]
            if evidence.get("confidence", 0) < .55 or any(not cameras.get(key, {}).get("position") for key in ids):
                continue
            camera1, camera2 = cameras[ids[0]], cameras[ids[1]]
            pa, pb = position(camera1), position(camera2)
            blockers = [key for key, polygon in others.items() if segment_interior_length(pa, pb, polygon) > .1]
            if blockers:
                diagnostics.append({"a": ids[0], "b": ids[1], "reason": "visual_sightline_through_third_room", "interveningRoomIds": blockers})
                continue
            pair = private_pairs.get(frozenset(ids))
            if pair is None:
                diagnostics.append({"a": ids[0], "b": ids[1], "reason": "no_retained_matched_rays"})
                continue
            camera1, camera2 = cameras[pair["a"]], cameras[pair["b"]]
            pa, pb = position(camera1), position(camera2)
            direction = np.asarray(pair["direction"], dtype=float)
            horizontal = float(np.linalg.norm(direction[[0, 2]]))
            if horizontal < .1:
                continue
            baseline = float(np.linalg.norm(pb - pa)) / horizontal
            yaw = math.radians(camera1.get("yaw", 0))
            rotation = np.array([[math.cos(yaw), -math.sin(yaw)], [math.sin(yaw), math.cos(yaw)]])
            points = np.asarray(pair["_points"], dtype=float)
            world = points[:, [0, 2]] @ rotation.T * baseline + pa
            heights = 1 + points[:, 1] * baseline
            count = 0
            pair_key = tuple(sorted(ids))
            for camera in [camera1, camera2]:
                source_room = a if camera["id"] in first["sceneIds"] else b
                target_room = b if source_room == a else a
                source = position(camera)
                # Only the inside endpoint supplies the outgoing ray. The
                # opposite endpoint can remain an uncertain threshold capture.
                if inside(source, polygons[source_room]) < -.03:
                    continue
                for index, (point, height) in enumerate(zip(world, heights)):
                    # A matched far-wall feature can fall just outside an
                    # estimated contour (cabinet bases and occluded corners).
                    # Retain it only when the finite ray enters that region;
                    # never extend a ray beyond the observed 3D feature.
                    if not np.all(np.isfinite(point)) or not np.isfinite(height) or inside(point, polygons[target_room]) < -.25:
                        continue
                    source_hits = segment_wall_hits(source, point, polygons[source_room])
                    target_hits = segment_wall_hits(source, point, polygons[target_room])
                    if len(source_hits) != 1 or not 1 <= len(target_hits) <= 2:
                        continue  # Multiple walls in a concave region are not one opening.
                    one, two = source_hits[0], target_hits[0]
                    if one[0] > two[0] + .02 or np.linalg.norm(one[3] - two[3]) > 1.2:
                        continue
                    if any(segment_interior_length(source, point, polygon) > .1 for polygon in others.values()):
                        continue
                    crossing_heights = [1 + hit[0] * (height - 1) for hit in [one, two]]
                    if any(not .08 < value < min(first["ceilingHeight"], second["ceilingHeight"]) * .93 for value in crossing_heights):
                        continue
                    if source_room != a:
                        one, two = two, one
                        crossing_heights.reverse()
                    key = (a, one[2], b, two[2])
                    group = groups.setdefault(key, {"key": key, "samples": {}, "pairs": {}})
                    sample_key = (pair_key, index)
                    group["samples"].setdefault(sample_key, {"a": one[3], "b": two[3], "height": crossing_heights})
                    group["pairs"][pair_key] = evidence
                    count += 1
            if not count:
                diagnostics.append({"a": ids[0], "b": ids[1], "reason": "no_unobstructed_two_face_rays"})
    return list(groups.values()), diagnostics


def infer_observed_room_openings(rooms, scenes, connections, image_pairs):
    """Export visible aperture spans, never standard or verified door widths."""
    groups, diagnostics = collect_observed_room_crossings(rooms, scenes, connections, image_pairs)
    by_room = {room["id"]: room for room in rooms}
    polygons = {room["id"]: np.asarray([[p["x"], p["z"]] for p in room["outline"]], dtype=float) for room in rooms}
    portals, assigned_pairs = [], set()
    for group in sorted(groups, key=lambda item: len(item["samples"]), reverse=True):
        a, edge_a, b, edge_b = group["key"]
        if frozenset([a, b]) in assigned_pairs:
            continue  # A split corner contour does not prove two entrances.
        samples = list(group["samples"].values())
        if len(samples) < 16:
            continue
        candidates = []
        for room_id, edge, side, partner in [(a, edge_a, "a", b), (b, edge_b, "b", a)]:
            polygon = polygons[room_id]; start, end = polygon[edge], polygon[(edge + 1) % len(polygon)]
            delta = end - start; length = float(np.linalg.norm(delta))
            if length < .1:
                break
            projected = np.sort(np.asarray([(sample[side] - start) @ delta / length for sample in samples]))
            low, high = np.quantile(projected, [.05, .95])
            # Widely separated clusters could be two windows/openings. Do not
            # cut away the wall between them as one invented doorway.
            core = projected[(projected >= low) & (projected <= high)]
            if not .08 < high - low < 1.8 or len(core) < 10 or np.max(np.diff(core)) > max(.15, (high - low) * .3):
                break
            width, offset = float((high - low) / length), float((low + high) / 2 / length)
            if width < .015 or width > .95 or offset - width / 2 < .005 or offset + width / 2 > .995:
                break
            candidates.append((room_id, {"edge": edge, "offset": round(offset, 5), "width": round(width, 5),
                "confidence": round(min(.78, .45 + len(samples) / 500 + .025 * (len(group["pairs"]) - 1)), 4),
                "verified": False, "pairedRoomId": partner, "evidence": "matched-rays-through-two-room-boundaries",
                "widthInterpretation": "visible_span_lower_bound", "supportRays": len(samples), "supportPairs": len(group["pairs"]),
                "scenePairs": list(group["pairs"].values())}))
        if len(candidates) != 2:
            continue
        for room_id, candidate in candidates:
            by_room[room_id].setdefault("doorwayCandidates", []).append(candidate)
        assigned_pairs.add(frozenset([a, b]))
        gap = float(np.median([np.linalg.norm(sample["a"] - sample["b"]) for sample in samples]))
        portals.append({"a": a, "b": b, "edgeA": edge_a, "edgeB": edge_b,
                        "kind": "observed_boundary_opening", "verified": False, "walkability": "unverified",
                        "gap": round(gap, 5), "scale": "camera_height", "supportRays": len(samples),
                        "scenePairs": list(group["pairs"].values())})
    blocked = {frozenset([entry["a"], entry["b"]]) for entry in diagnostics if entry["reason"] == "visual_sightline_through_third_room"}
    for connection in connections:
        key = frozenset([connection["a"], connection["b"]])
        if key in assigned_pairs or all(frozenset([pair["a"], pair["b"]]) in blocked for pair in connection["scenePairs"]):
            continue
        support = max([len(group["samples"]) for group in groups if frozenset([group["key"][0], group["key"][2]]) == key] or [0])
        diagnostics.append({"roomA": connection["a"], "roomB": connection["b"], "reason": "insufficient_consistent_aperture_extent", "maximumSupportRays": support})
    return portals, diagnostics


def infer_corridor_observations(rooms, scenes, connections, observations=None):
    """Suggest a corridor only from narrow multiview geometry and room access.

    A bed glimpsed through a doorway can weakly bias a panorama classifier.
    This evaluator contributes reviewable evidence; it does not rename a user
    room, alter any boundary, or overrule strong incompatible visual evidence.
    """
    by_scene = {scene["id"]: scene for scene in scenes}
    by_room = {room["id"]: room for room in rooms}
    strong_furnished = {observation.get("sceneId") for observation in observations or []
                        if observation.get("kind") not in (None, "unknown", "corridor", "entrance")
                        and observation.get("confidence", 0) >= .8}
    neighbours = {}
    for connection in connections:
        a, b = connection.get("a"), connection.get("b")
        first, second = by_room.get(a), by_room.get(b)
        if not first or not second or first["component"] != second["component"] or first["floor"] != second["floor"]:
            continue
        if not any(pair.get("confidence", 0) >= .55 for pair in connection.get("scenePairs", [])):
            continue
        neighbours.setdefault(a, set()).add(b)
        neighbours.setdefault(b, set()).add(a)
    result = []
    for room in rooms:
        if len(neighbours.get(room["id"], [])) < 3 or room["confidence"] < .5 or strong_furnished.intersection(room["sceneIds"]):
            continue
        polygon = np.asarray([[point["x"], point["z"]] for point in room["outline"]], dtype=np.float32)
        box = cv2.boxPoints(cv2.minAreaRect(polygon))
        vectors = [box[1] - box[0], box[2] - box[1]]
        lengths = [float(np.linalg.norm(vector)) for vector in vectors]
        long_index = int(np.argmax(lengths)); long_side, short_side = max(lengths), min(lengths)
        if short_side < .05 or long_side / short_side < 3:
            continue
        axis = vectors[long_index] / long_side
        observed = []
        for scene_id in room.get("boundarySceneIds", room["sceneIds"]):
            camera = by_scene.get(scene_id, {}).get("position")
            if camera is None:
                continue
            point = np.asarray([camera["x"], camera["z"]], dtype=float)
            if cv2.pointPolygonTest(polygon, tuple(map(float, point)), True) >= -.08:
                observed.append(point)
        if len(observed) < 3:
            continue
        camera_span = float(np.ptp(np.asarray(observed) @ axis))
        if camera_span / long_side < .45:
            continue
        evidence = ["estimated_corridor_needs_review", "fitted_floor_ceiling_boundaries",
                    f"oriented_boundary_aspect_ratio={long_side / short_side:.3f}",
                    f"observed_camera_count={len(observed)};long_axis_camera_coverage={camera_span / long_side:.3f}",
                    f"accepted_visual_connections_to_distinct_rooms={len(neighbours[room['id']])}",
                    "no_strong_incompatible_furnished_function_observation"]
        for scene_id in room["sceneIds"]:
            result.append({"id": "layout-corridor-" + hashlib.sha256((room["id"] + "/" + scene_id).encode()).hexdigest()[:24],
                           "sceneId": scene_id, "kind": "corridor", "confidence": .78, "needsReview": True,
                           "model": "multi-view-room-envelope-corridor-v1", "evidence": evidence[:]})
    return result


def align_observed_wall_contacts(rooms, scenes, connections, image_pairs, architecture=None):
    """Align close observed planes only across geometrically matched room views.

    This is a bounded adjustment in the established component frame, not room
    packing or a corridor generator. Aperture spans require triangulated image
    rays through the opposing observed region; camera paths alone do not set a
    door width, and every aperture remains unverified.
    """
    by_id = {room["id"]: room for room in rooms}
    cameras = {scene["id"]: scene for scene in scenes}
    polygons = {room["id"]: np.asarray([[p["x"], p["z"]] for p in room["outline"]], dtype=float) for room in rooms}
    position = lambda scene: np.array([scene["position"]["x"], scene["position"]["z"]], dtype=float)
    inside = lambda point, polygon: cv2.pointPolygonTest(polygon.astype(np.float32), tuple(map(float, point)), True)
    proposals = {}
    for connection in connections:
        first, second = by_id[connection["a"]], by_id[connection["b"]]
        if first["component"] != second["component"] or first["floor"] != second["floor"]:
            continue
        for pair in connection["scenePairs"]:
            a, b = cameras[pair["a"]], cameras[pair["b"]]
            if a["id"] not in first["sceneIds"]:
                a, b = b, a
            pa, pb = position(a), position(b)
            if any(other not in (first["id"], second["id"]) and by_id[other]["component"] == first["component"]
                   and by_id[other]["floor"] == first["floor"] and segment_interior_length(pa, pb, polygon) > .1
                   for other, polygon in polygons.items()):
                continue
            if inside(pa, polygons[first["id"]]) < -.03 or inside(pb, polygons[second["id"]]) < -.03:
                continue
            ha = segment_wall_hits(pa, pb, polygons[first["id"]])
            hb = segment_wall_hits(pa, pb, polygons[second["id"]])
            if not ha or not hb:
                continue
            x, y = ha[0], hb[-1]
            gap = float(np.linalg.norm(x[3] - y[3]))
            angle = math.degrees(math.acos(np.clip(abs(x[4] @ y[4]), 0, 1)))
            if x[0] >= y[0] or gap > .4 or angle > 8:
                continue
            key = (first["id"], x[2], second["id"], y[2])
            proposal = proposals.setdefault(key, {"key": key, "gap": gap, "angle": angle, "pairs": []})
            proposal["pairs"].append(pair)
    ray_groups, _ = collect_observed_room_crossings(rooms, scenes, connections, image_pairs)
    for group in ray_groups:
        if len(group["samples"]) < 16:
            continue
        a, ia, b, ib = group["key"]
        first, second = polygons[a], polygons[b]
        da, db = first[(ia + 1) % len(first)] - first[ia], second[(ib + 1) % len(second)] - second[ib]
        if min(np.linalg.norm(da), np.linalg.norm(db)) < .1:
            continue
        angle = math.degrees(math.acos(np.clip(abs(da @ db / np.linalg.norm(da) / np.linalg.norm(db)), 0, 1)))
        gap = float(np.median([np.linalg.norm(sample["a"] - sample["b"]) for sample in group["samples"].values()]))
        if gap > .4 or angle > 8:
            continue
        proposal = proposals.setdefault(group["key"], {"key": group["key"], "gap": gap, "angle": angle, "pairs": []})
        known = {frozenset([pair["a"], pair["b"]]) for pair in proposal["pairs"]}
        proposal["pairs"].extend(pair for key, pair in group["pairs"].items() if frozenset(key) not in known)
        proposal["supportRays"] = len(group["samples"])
    contacts, used = [], set()
    for proposal in sorted(proposals.values(), key=lambda item: len(item["pairs"]), reverse=True):
        a, ia, b, ib = proposal["key"]
        if (a, ia) in used or (b, ib) in used:
            continue
        first, second = polygons[a], polygons[b]
        start1, end1 = first[ia], first[(ia + 1) % len(first)]
        start2, end2 = second[ib], second[(ib + 1) % len(second)]
        d1, d2 = end1 - start1, end2 - start2
        lengths = [np.linalg.norm(d1), np.linalg.norm(d2)]
        if min(lengths) < .35:
            continue
        d1, d2 = d1 / lengths[0], d2 / lengths[1]
        if d1 @ d2 < 0:
            d2 = -d2
        weights = np.array([by_id[key]["confidence"] * (1 + math.log1p(len(by_id[key].get("boundarySceneIds", by_id[key]["sceneIds"])))) for key in [a, b]])
        tangent = d1 * weights[0] + d2 * weights[1]; tangent /= np.linalg.norm(tangent)
        normal = np.array([-tangent[1], tangent[0]])
        interval1, interval2 = sorted([start1 @ tangent, end1 @ tangent]), sorted([start2 @ tangent, end2 @ tangent])
        if min(interval1[1], interval2[1]) - max(interval1[0], interval2[0]) < .25:
            continue
        plane = float(np.average([((start1 + end1) / 2) @ normal, ((start2 + end2) / 2) @ normal], weights=weights))
        updated = {}
        valid = True
        for key, edge in [(a, ia), (b, ib)]:
            polygon = polygons[key].copy()
            for vertex in [edge, (edge + 1) % len(polygon)]:
                polygon[vertex] += (plane - polygon[vertex] @ normal) * normal
            previous_area = abs(cv2.contourArea(polygons[key].astype(np.float32)))
            area = abs(cv2.contourArea(polygon.astype(np.float32)))
            if np.max(np.linalg.norm(polygon - polygons[key], axis=1)) > .3 or not .7 < area / max(1e-8, previous_area) < 1.4:
                valid = False; break
            for scene_id in by_id[key].get("boundarySceneIds", by_id[key]["sceneIds"]):
                point = position(cameras[scene_id])
                if inside(point, polygons[key]) >= .03 and inside(point, polygon) < -.02:
                    valid = False; break
            if any(other not in (a, b) and by_id[other]["component"] == by_id[key]["component"] and
                   footprint_overlap(polygon, other_polygon)[0] > footprint_overlap(polygons[key], other_polygon)[0] + .012
                   for other, other_polygon in polygons.items()):
                valid = False
            updated[key] = polygon
        if not valid:
            continue
        polygons.update(updated); used.update([(a, ia), (b, ib)])
        contact = {"a": a, "b": b, "edgeA": ia, "edgeB": ib, "gapBefore": round(proposal["gap"], 4),
                   "angleBeforeDegrees": round(proposal["angle"], 3), "scale": "camera_height", "verified": False,
                   "evidence": "matched-rays-close-facing-wall-planes" if proposal.get("supportRays") else "matched-views-close-facing-wall-planes",
                   "scenePairs": proposal["pairs"], **({"supportRays": proposal["supportRays"]} if proposal.get("supportRays") else {})}
        contacts.append(contact)
    for room in rooms:
        room["outline"] = [{"x": round(float(x), 5), "z": round(float(z), 5)} for x, z in polygons[room["id"]]]
        room.pop("doorwayCandidates", None)
    portals, diagnostics = infer_observed_room_openings(rooms, scenes, connections, image_pairs)
    if architecture is not None:
        architecture.update(architectureConnections=portals, architectureDiagnostics=diagnostics)
    return rooms, contacts


def load_panorama(file, width=1536):
    image = cv2.imdecode(np.frombuffer(Path(file).read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or abs(image.shape[1] / image.shape[0] - 2) > .06:
        raise ValueError("A full 2:1 panorama is required")
    if image.shape[1] > width:
        image = cv2.resize(image, (width, width // 2), interpolation=cv2.INTER_AREA)
    return image


def boundary_evidence(image):
    """Horizontal colour transitions; strong vertical door edges are downweighted."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(float)
    lab = gaussian_filter(lab, (.9, .9, 0), mode=("nearest", "wrap", "nearest"))
    gy = (np.roll(lab, -2, axis=0) - np.roll(lab, 2, axis=0)) / 4
    gx = (np.roll(lab, -2, axis=1) - np.roll(lab, 2, axis=1)) / 4
    vertical = np.linalg.norm(gy * np.array([1., 1.6, 1.6]), axis=2)
    horizontal = np.linalg.norm(gx * np.array([1., 1.6, 1.6]), axis=2)
    energy = np.log1p(vertical) * (.25 + .75 * vertical / np.maximum(.25, vertical + horizontal))
    energy = gaussian_filter(energy, (.5, 2), mode=("nearest", "wrap"))
    # Keep strength comparable across exposed white walls and darker furniture.
    energy /= max(.25, float(np.quantile(energy, .92)))
    return np.clip(energy, 0, 3)


def manhattan_orientation(image):
    """Vote horizontal vanishing directions from real rectilinear line segments."""
    size = 480
    xy = (np.arange(size) + .5 - size / 2) / (size / 2)
    x, y = np.meshgrid(xy, -xy)
    camera_rays = np.stack((x, y, -np.ones_like(x)), axis=2)
    height, width = image.shape[:2]
    angles, weights = [], []
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    for face in range(4):
        angle = face * np.pi / 2
        rotation = np.array([[np.cos(angle), 0, -np.sin(angle)], [0, 1, 0], [np.sin(angle), 0, np.cos(angle)]])
        rays = camera_rays @ rotation.T
        rays /= np.linalg.norm(rays, axis=2, keepdims=True)
        mx = (np.arctan2(rays[:, :, 0], -rays[:, :, 2]) / (2 * np.pi) + .5) * width
        my = (.5 - np.arcsin(rays[:, :, 1]) / np.pi) * height
        view = cv2.remap(image, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        segments = detector.detect(cv2.cvtColor(view, cv2.COLOR_BGR2GRAY))[0]
        for segment in segments if segments is not None else []:
            a, b = segment.reshape(2, 2)
            length = np.linalg.norm(a - b)
            if length < 35:
                continue
            def ray(pixel):
                local = np.array([(pixel[0] - size / 2) / (size / 2), -(pixel[1] - size / 2) / (size / 2), -1])
                return rotation @ local
            normal = np.cross(ray(a), ray(b))
            normal /= max(1e-9, np.linalg.norm(normal))
            if abs(normal[1]) < .15:
                continue
            # A horizontal 3D line lies in the ray plane and is perpendicular
            # to vertical, so its direction is the cross product below.
            direction = np.cross(normal, [0., 1., 0.])
            angles.append(math.atan2(direction[0], -direction[2]) % (np.pi / 2))
            weights.append(float(length))
    if not angles:
        return 0., 0.
    candidates = np.linspace(0, np.pi / 2, 360, endpoint=False)
    difference = np.angle(np.exp(4j * (np.asarray(angles)[:, None] - candidates))) / 4
    support = (np.exp(-.5 * (difference / math.radians(2.5)) ** 2) * np.asarray(weights)[:, None]).sum(axis=0)
    selected = int(np.argmax(support))
    return float(candidates[selected]), float(support[selected] / sum(weights))


def trace_manhattan(score, radii, orientation, switch_penalty=8.):
    """Piecewise wall planes: transitions may turn a corner, never wiggle a wall."""
    count, width = score.shape
    offsets = np.exp(np.linspace(np.log(.28), np.log(12), 112))
    logs = np.log(offsets)
    step = logs[1] - logs[0]
    normals = orientation + np.arange(4) * np.pi / 2
    angles = (np.arange(width) / width - .5) * (2 * np.pi)
    cosine = np.cos(angles[None, :] - normals[:, None])
    radius = offsets[None, :, None] / np.maximum(.001, cosine[:, None, :])
    lookup = (np.log(radius) - np.log(radii[0])) / np.log(radii[1] / radii[0])
    emission = map_coordinates(score, [lookup, np.broadcast_to(np.arange(width)[None, None, :], lookup.shape)], order=1, mode="nearest")
    emission[(cosine[:, None, :].repeat(len(offsets), axis=1) <= .015) | (radius > radii[-1])] = -1e5
    state_count = 4 * len(offsets)
    state = np.arange(state_count).reshape(4, -1)
    cost = -emission[:, :, 0]
    back = np.zeros((width * 3, state_count), dtype=np.int16)
    for column in range(1, width * 3):
        current, previous = column % width, (column - 1) % width
        best = cost.copy()
        source = state.copy()
        for target_normal in range(4):
            for source_normal in [(target_normal + 1) % 4, (target_normal - 1) % 4]:
                if min(cosine[target_normal, current], cosine[source_normal, previous]) <= .015:
                    continue
                desired = radius[target_normal, :, current] * cosine[source_normal, previous]
                expected = (np.log(np.maximum(1e-8, desired)) - logs[0]) / step
                for delta in [-1, 0, 1]:
                    index = np.rint(expected).astype(int) + delta
                    valid = (index >= 0) & (index < len(offsets))
                    index = np.clip(index, 0, len(offsets) - 1)
                    candidate = cost[source_normal, index] + switch_penalty + np.abs(index - expected) * .5
                    update = valid & (candidate < best[target_normal])
                    best[target_normal, update] = candidate[update]
                    source[target_normal, update] = state[source_normal, index[update]]
        cost = best - emission[:, :, current]
        cost -= np.min(cost)
        back[column] = source.reshape(-1)
    trace = np.zeros(width * 3, dtype=np.int16)
    trace[-1] = np.argmin(cost)
    for column in range(len(trace) - 1, 0, -1):
        trace[column - 1] = back[column, trace[column]]
    trace = trace[width:2 * width]
    normal, index = trace // len(offsets), trace % len(offsets)
    result = radius[normal, index, np.arange(width)]
    return result, float(np.mean(emission[normal, index, np.arange(width)])), int(np.count_nonzero(np.diff(trace)))


def trace_boundary(score, transition=.08, max_step=4):
    """Periodic ray-depth path. A triple wrap removes the arbitrary image seam."""
    bins, width = score.shape
    tiled = np.tile(score, (1, 3))
    cost = -tiled[:, 0]
    back = np.zeros(tiled.shape, dtype=np.int16)
    deltas = np.arange(-max_step, max_step + 1)
    indices = np.arange(bins)
    for column in range(1, tiled.shape[1]):
        options = []
        for shift in deltas:
            candidate = np.roll(cost, shift) + transition * abs(shift)
            if shift > 0:
                candidate[:shift] = np.inf
            elif shift < 0:
                candidate[shift:] = np.inf
            options.append(candidate)
        options = np.asarray(options)
        selected = np.argmin(options, axis=0)
        back[:, column] = indices - deltas[selected]
        cost = options[selected, indices] - tiled[:, column]
    ray = np.zeros(tiled.shape[1], dtype=np.int16)
    ray[-1] = np.argmin(cost)
    for column in range(len(ray) - 1, 0, -1):
        ray[column - 1] = back[ray[column], column]
    return ray[width:2 * width]


def estimate_envelope(image):
    height, width = image.shape[:2]
    energy = boundary_evidence(image)
    # In a level panorama tan(elevation)=height/radial-distance. Couple the
    # floor and ceiling curves using one unknown height ratio, not a room box.
    radii = np.exp(np.linspace(np.log(.4), np.log(14), 160))
    columns = np.arange(width)[None, :]
    floor_rows = height * (.5 + np.arctan(1 / radii) / np.pi)
    floor_score = map_coordinates(energy, [np.broadcast_to(floor_rows[:, None], (len(radii), width)), np.broadcast_to(columns, (len(radii), width))], order=1, mode="nearest")
    orientation, axis_support = manhattan_orientation(image)
    best = None
    for ratio in np.linspace(.55, 1.3, 9):
        ceiling_rows = height * (.5 - np.arctan(ratio / radii) / np.pi)
        ceiling_score = map_coordinates(energy, [np.broadcast_to(ceiling_rows[:, None], floor_score.shape), np.broadcast_to(columns, floor_score.shape)], order=1, mode="nearest")
        # One boundary may be hidden by furniture. Agreement is rewarded rather
        # than treating the furniture contour alone as a confirmed room wall.
        score = .8 * ceiling_score + .4 * floor_score + .25 * np.minimum(floor_score, ceiling_score)
        radius, value, corners = trace_manhattan(score, radii, orientation)
        trace = np.clip(np.rint((np.log(radius) - np.log(radii[0])) / np.log(radii[1] / radii[0])).astype(int), 0, len(radii) - 1)
        value -= corners * 8 / width
        if best is None or value > best[0]:
            best = value, ratio, trace, ceiling_score, radius
    value, ratio, trace, ceiling_score, radius = best
    yaw = (np.arange(width) / width - .5) * 2 * np.pi
    points = np.column_stack((np.sin(yaw) * radius, -np.cos(yaw) * radius))
    outline = cv2.approxPolyDP(points.astype(np.float32), .075, True).reshape(-1, 2)
    floor = floor_score[trace, np.arange(width)]
    ceiling = ceiling_score[trace, np.arange(width)]
    visible = np.maximum(floor, ceiling)
    agreement = np.minimum(floor, ceiling)
    confidence = float(np.mean(np.clip(agreement / 1.1, 0, 1)))
    result = {"version": 1, "method": "paired-spherical-floor-ceiling-boundaries", "scale": "camera_height",
              "classification": "estimated_visible_envelope", "ceilingAboveCamera": float(ratio),
              "cameraHeight": 1, "confidence": round(confidence, 4),
              "manhattanOrientationRadians": orientation, "axisSupport": round(axis_support, 4),
              "outline": [{"x": round(float(x), 5), "z": round(float(z), 5)} for x, z in outline],
              "evidence": {"meanScore": round(value, 4), "observedFraction": round(float(np.mean(visible > .6)), 4),
                           "pairedFraction": round(float(np.mean(agreement > .5)), 4)},
              "warnings": ["Relative camera-height units, not metres.", "Furniture, door openings and decorative ceilings may obscure the true wall boundary."]}
    return result, radius, energy


def write_preview(image, result, radii, destination):
    overlay = image.copy()
    height, width = image.shape[:2]
    ratio = result["ceilingAboveCamera"]
    for factor, sign, color in [(1, 1, (70, 245, 90)), (ratio, -1, (245, 185, 50))]:
        row = height * (.5 + sign * np.arctan(factor / radii) / np.pi)
        points = np.column_stack((np.arange(width), row)).astype(np.int32)
        cv2.polylines(overlay, [points], False, color, 2, cv2.LINE_AA)
    size = height
    plan = np.full((size, size, 3), (246, 248, 246), dtype=np.uint8)
    polygon = np.asarray([[p["x"], p["z"]] for p in result["outline"]])
    maximum = max(1., float(np.max(np.abs(polygon))) + .3)
    xy = polygon / maximum * (size * .43) + size / 2
    cv2.fillPoly(plan, [xy.astype(np.int32)], (221, 236, 231))
    cv2.polylines(plan, [xy.astype(np.int32)], True, (52, 113, 84), 3, cv2.LINE_AA)
    cv2.circle(plan, (size // 2, size // 2), 6, (20, 95, 230), -1)
    cv2.putText(plan, "PIXEL-DERIVED / RELATIVE", (16, 28), cv2.FONT_HERSHEY_SIMPLEX, .6, (30, 40, 35), 1)
    cv2.imencode(".png", np.concatenate((overlay, plan), axis=1))[1].tofile(str(destination))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--indices", default="0,2,7,12,26,36")
    args = parser.parse_args()
    files = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    destination = Path(args.output); destination.mkdir(parents=True, exist_ok=True)
    results = []
    for index in map(int, args.indices.split(",")):
        item = files[index]
        image = load_panorama(item.get("path", item.get("file")))
        result, radii, _ = estimate_envelope(image)
        result.update(index=index, sceneId=item.get("sceneId", item.get("id")))
        results.append(result)
        write_preview(image, result, radii, destination / (str(index) + ".png"))
        print(json.dumps(result), flush=True)
    (destination / "result.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
