import importlib.util
from pathlib import Path
import unittest
import json
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("photo_depth", ROOT / "scripts" / "imo3d-photo-depth.py")
depth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(depth)
np = depth.np


def room_distance(rays):
    targets = []
    for axis, low, high in [(0, -3, 3), (1, -1, 1.5), (2, -3, 3)]:
        coordinate = rays[..., axis]
        targets.append(np.where(coordinate > 0, high / np.maximum(coordinate, 1e-8), low / np.minimum(coordinate, -1e-8)))
    return np.min(targets, axis=0)


def synthetic_face(yaw, pitch, size=72, a=.8, b=.1):
    rays, norm, basis = depth.camera_rays(yaw, pitch, size)
    distance = room_distance(rays)
    return {"yaw": yaw, "pitch": pitch, "rays": rays, "norm": norm, "basis": basis, "prediction": ((norm / distance - b) / a).astype(np.float32)}


class PhotoDepthTests(unittest.TestCase):
    def test_face_rays_are_unit_and_pitch_is_upward(self):
        rays, _, _ = depth.camera_rays(90, 45, 71)
        self.assertLess(np.max(np.abs(np.linalg.norm(rays, axis=-1) - 1)), 1e-12)
        self.assertAlmostEqual(rays[35, 35, 0], 2 ** -.5)
        self.assertAlmostEqual(rays[35, 35, 1], 2 ** -.5)

    def test_affine_fit_rejects_bad_scale_and_ignores_outliers(self):
        x = np.linspace(.2, 2, 1000)
        y = 1.7 * x + .15
        y[::5] += 3
        fit = depth.affine_fit(x, y)
        self.assertAlmostEqual(fit["a"], 1.7)
        self.assertAlmostEqual(fit["b"], .15)
        self.assertGreater(fit["fraction"], .75)
        self.assertIsNone(depth.affine_fit(x, 4 - x))
        self.assertIsNone(depth.affine_fit(x[:10], y[:10]))

    def test_real_ray_plane_geometry_aligns_tilted_views_and_upward_overlaps(self):
        faces = [synthetic_face(yaw, pitch, a=.8 + yaw / 800, b=.08 + pitch / 1000) for pitch in [-45, 0, 45] for yaw in range(0, 360, 45)]
        longitude = (np.arange(512) + .5) / 512 * 2 * np.pi - np.pi
        profile = np.arctan(np.maximum(np.abs(np.sin(longitude)), np.abs(np.cos(longitude))) / 3)
        depth.anchor_faces(faces, profile)
        self.assertTrue(any(face.get("anchor") == "overlap" and face["pitch"] == 45 for face in faces))
        panorama, confidence, diagnostics = depth.blend_panorama(faces, 128, 64)
        self.assertGreater((panorama > 0).mean(), .88)
        longitude, latitude = np.meshgrid((np.arange(128) + .5) / 128 * 2 * np.pi - np.pi, np.pi / 2 - (np.arange(64) + .5) / 64 * np.pi)
        rays = np.stack([np.sin(longitude) * np.cos(latitude), np.sin(latitude), np.cos(longitude) * np.cos(latitude)], -1)
        expected = room_distance(rays)
        self.assertLess(np.median(np.abs(panorama[panorama > 0] - expected[panorama > 0]) / expected[panorama > 0]), .015)
        self.assertLess(diagnostics["overlapDisagreement"], .02)
        self.assertTrue(np.all(confidence[panorama == 0] == 0))

    def test_unanchored_predictions_stay_unsupported(self):
        face = synthetic_face(0, 45)
        depth.anchor_faces([face], np.full(512, 1.4))
        panorama, confidence, _ = depth.blend_panorama([face])
        self.assertEqual(np.count_nonzero(panorama), 0)
        self.assertEqual(np.count_nonzero(confidence), 0)

    def test_disagreeing_overlap_is_masked_instead_of_a_false_surface(self):
        first = synthetic_face(0, 0)
        first.update(fit={"a": 1, "b": 0}, prediction=np.ones((72, 72), dtype=np.float32), confidence=1)
        second = {**first, "prediction": np.full((72, 72), .1, dtype=np.float32)}
        panorama, confidence, diagnostics = depth.blend_panorama([first, second])
        self.assertEqual(np.count_nonzero(panorama), 0)
        self.assertEqual(np.count_nonzero(confidence), 0)
        self.assertGreater(diagnostics["overlapDisagreement"], .99)

    def test_downsample_does_not_fill_holes_low_confidence_or_surface_discontinuities(self):
        values = np.full((128, 256), 2.0)
        confidence = np.full_like(values, .8)
        values[0, 0] = 0
        confidence[2, 2] = .2
        values[4, 4] = 4
        resized, certainty = depth.conservative_downsample(values, confidence)
        self.assertEqual(resized.shape, (64, 128))
        for location in [(0, 0), (1, 1), (2, 2)]:
            self.assertEqual(resized[location], 0)
            self.assertEqual(certainty[location], 0)
        self.assertEqual(resized[3, 3], 2)
        self.assertEqual(certainty[3, 3], .8)

    def test_cache_hash_includes_image_profile_model_version_and_revalidates_content(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "work", prefix="photo-depth-cache-test-") as folder:
            file = Path(folder) / ("a" * 64 + ".json")
            cached = {"version": depth.VERSION, "modelSha256": depth.MODEL_SHA256, "imageSha256": "image-a", "profileSha256": "profile-a", "width": 128, "height": 64,
                      "source": "monocular-multiview-floor-aligned", "units": "camera_height", "purpose": "display_only", "metric": False,
                      "values": [2] * 8192, "confidenceValues": [.8] * 8192, "coverage": -123, "confidence": -123}
            file.write_text(json.dumps(cached))
            checked = depth.read_cache(file, "image-a", "profile-a")
            self.assertEqual(checked["coverage"], 1)
            self.assertAlmostEqual(checked["confidence"], .8)
            self.assertIsNone(depth.read_cache(file, "image-b", "profile-a"))
            self.assertIsNone(depth.read_cache(file, "image-a", "profile-b"))
            self.assertNotEqual(depth.cache_key("image-a", "profile-a"), depth.cache_key("image-a", "profile-b"))
            for change in [{"version": "old"}, {"modelSha256": "other"}, {"purpose": "measurement"}, {"metric": True}, {"values": [float("nan")] * 8192}, {"values": [2] * 8191}]:
                file.write_text(json.dumps({**cached, **change}))
                self.assertIsNone(depth.read_cache(file, "image-a", "profile-a"))
            file.write_text("{incomplete")
            self.assertIsNone(depth.read_cache(file, "image-a", "profile-a"))


if __name__ == "__main__":
    unittest.main()
