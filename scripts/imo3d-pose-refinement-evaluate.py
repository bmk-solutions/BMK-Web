"""Offline native-depth pose experiment, never a floorplan or production update.

Fits one physical camera against another on negative-pitch evidence and checks
the untouched positive-pitch evidence. No room outlines, reference plans, model
inference or database writes. Passing is only a candidate for global refinement.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile

if os.environ.get('IMO3D_CV_PATH'):
    sys.path.insert(0, os.environ['IMO3D_CV_PATH'])
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]


def transform(points, delta, origin):
    angle, x, z = delta
    c, s = np.cos(angle), np.sin(angle)
    rotation = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return (points-origin) @ rotation.T + origin + [x, 0, z]


def samples(archive):
    """Native pixel centres, finite-difference normals, one cloud per camera."""
    clouds = {}
    with np.load(archive, allow_pickle=False) as data:
        if str(data['source']) != 'da3-validated-perspective-v1':
            raise ValueError('Native geometry required')
        centers = data['pixel_centers']
        xx, yy = np.meshgrid(centers, centers)
        rays = np.stack([xx, yy, np.ones_like(xx)], -1) @ np.linalg.inv(data['intrinsics']).T
        for i, sid in enumerate(data['scene_ids'].tolist()):
            depth = data['validated_depth'][i]
            ext = data['world_to_camera'][i]
            points = (rays * depth[..., None] - ext[:3, 3]) @ ext[:3, :3]
            mask = data['valid_mask'][i].astype(bool)
            # Neighbours must all be supported: a depth discontinuity isn't a plane.
            valid = mask[1:-1, 1:-1] & mask[:-2, 1:-1] & mask[2:, 1:-1] & mask[1:-1, :-2] & mask[1:-1, 2:]
            dx = points[1:-1, 2:] - points[1:-1, :-2]
            dy = points[2:, 1:-1] - points[:-2, 1:-1]
            normal = np.cross(dx, dy)
            norm = np.linalg.norm(normal, axis=-1)
            valid &= (norm > 1e-7) & (np.linalg.norm(dx, axis=-1) < .15) & (np.linalg.norm(dy, axis=-1) < .15)
            # Vertical surfaces constrain horizontal motion; floors cannot.
            normal /= np.maximum(norm[..., None], 1e-12)
            valid &= np.abs(normal[..., 1]) < .35
            p, n = points[1:-1, 1:-1][valid], normal[valid]
            clouds.setdefault(sid, []).append((p, n))
    result = {}
    for sid, parts in clouds.items():
        p = np.concatenate([v[0] for v in parts])
        n = np.concatenate([v[1] for v in parts])
        # Crop multiplicity does not weight the fit. Deterministic voxel sampling.
        _, index = np.unique(np.floor(p/.025).astype(np.int64), axis=0, return_index=True)
        index = index[::max(1, int(np.ceil(len(index)/6000)))]
        result[sid] = (p[index], n[index])
    return result


def correspondences(source, target):
    p, normals = target
    distance, index = cKDTree(p).query(source)
    return p[index], normals[index], distance < .18


def evaluate_pair(train_source, train_target, hold_source, hold_target):
    source = train_source[0]
    if min(len(source), len(train_target[0]), len(hold_source[0]), len(hold_target[0])) < 150:
        return {'status': 'insufficient_surface_support'}
    origin = np.median(source, axis=0)
    target, normal, supported = correspondences(source, train_target)
    if supported.sum() < 150:
        return {'status': 'insufficient_overlap'}
    p, q, n = source[supported], target[supported], normal[supported]
    def residual(delta):
        return ((transform(p, delta, origin)-q)*n).sum(axis=1)
    bounds = np.array([np.deg2rad(2), .15, .15])
    fit = least_squares(residual, np.zeros(3), bounds=(-bounds, bounds), loss='soft_l1', f_scale=.025, max_nfev=60)
    # Flat parallel walls cannot determine all three horizontal degrees of freedom.
    singular = np.linalg.svd(fit.jac * bounds, compute_uv=False)
    observable = singular[-1] / max(singular[0], 1e-12) > .025
    hp = hold_source[0]
    hq, hn, good = correspondences(hp, hold_target)
    before = np.abs(((hp-hq)*hn).sum(axis=1))[good]
    after = np.abs(((transform(hp, fit.x, origin)-hq)*hn).sum(axis=1))[good]
    _, _, next_good = correspondences(transform(hp, fit.x, origin), hold_target)
    enough = len(before) >= 150
    improved = enough and np.median(after) < np.median(before)*.9 and np.quantile(after, .9) <= np.quantile(before, .9)
    at_bound = bool(np.any(np.abs(fit.x) > bounds*.98))
    passed = observable and improved and not at_bound and next_good.sum() >= good.sum()*.98
    return {'status': 'candidate_only' if passed else 'rejected', 'architecturalAcceptance': False,
            'fitPoints': len(p), 'heldOutPoints': len(before), 'observable': bool(observable), 'atBound': at_bound,
            'heldOutMedianBefore': float(np.median(before)) if enough else None,
            'heldOutMedianAfter': float(np.median(after)) if enough else None,
            'heldOutP90Before': float(np.quantile(before, .9)) if enough else None,
            'heldOutP90After': float(np.quantile(after, .9)) if enough else None,
            'heldOutCoverageBefore': float(good.mean()), 'heldOutCoverageAfter': float(next_good.mean()),
            'yawDegrees': float(np.rad2deg(fit.x[0])), 'translation': {'x': float(fit.x[1]), 'z': float(fit.x[2])},
            'rotationOrigin': origin.tolist()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--batch', type=int, default=0)
    args = parser.parse_args()
    manifest_path, output = Path(args.manifest).resolve(), Path(args.output).resolve()
    if not manifest_path.is_relative_to(ROOT) or not output.is_relative_to(ROOT/'work'):
        raise ValueError('Evidence must be local; output must be isolated under work')
    manifest = json.loads(manifest_path.read_text())
    records = {r['file']: r for r in manifest['files']}
    negatives = sorted(n for n in records if n.endswith('-pitch-neg30.npz'))
    if not 0 <= args.batch < len(negatives):
        raise ValueError('Unknown batch')
    names = [negatives[args.batch], negatives[args.batch].replace('-pitch-neg30.', '-pitch-pos30.')]
    clouds = []
    for name in names:
        if Path(name).name != name:
            raise ValueError('Invalid archive filename')
        file = manifest_path.parent/name
        if file.is_symlink() or not 0 < file.stat().st_size <= 32*1024*1024:
            raise ValueError('Invalid archive')
        if hashlib.sha256(file.read_bytes()).hexdigest() != records[name]['sha256']:
            raise ValueError('Archive hash mismatch')
        with zipfile.ZipFile(file) as archive:
            if sum(item.file_size for item in archive.infolist()) > 32*1024*1024:
                raise ValueError('Archive exceeds decompressed size bound')
        clouds.append(samples(file))
    ids = sorted(set(clouds[0]) & set(clouds[1]))
    pairs = []
    for i, a in enumerate(ids):
        for b in ids[i+1:]:
            pairs.append({'source': a, 'anchor': b, **evaluate_pair(clouds[0][a], clouds[0][b], clouds[1][a], clouds[1][b])})
    report = {'version': 1, 'source': 'native-depth-pose-refinement-experiment', 'units': 'camera_height',
              'appliedToTour': False, 'architecturalAcceptance': False,
              'limitation': 'Opposite pitch tests generalization within the same photographs and pose-conditioned model, not surveyed accuracy. Global camera consistency and free-space validation remain required.',
              'archives': names, 'pairs': pairs}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
