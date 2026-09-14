"""Private geometry persistence tests; never initialize a model or load Torch."""
from pathlib import Path
import copy
import contextlib
import io
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCRATCH = ROOT / "work/geometry-evidence-tests"
SCRATCH.mkdir(parents=True, exist_ok=True)
runtime_path = ROOT / "work/reconstruction-runtime.json"
if runtime_path.exists():
    runtime = json.loads(runtime_path.read_text(encoding="utf-8-sig"))
    if runtime.get("cvPath"):
        sys.path.insert(0, runtime["cvPath"])
import numpy as np

spec = importlib.util.spec_from_file_location("joint_geometry_core", ROOT / "scripts/imo3d-joint-depth.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def fixture():
    """Analytic inclined plane, observed from three independently placed cameras.

    The source plane is z = 3 + 0.1*x + 0.05*y in world coordinates.
    No apartment photographs, network weights or saved reconstruction required.
    """
    views, results = [], []
    size = 378
    focal = size / (2 * np.tan(np.deg2rad(50)))
    grid = (np.arange(size, dtype=np.float32) + .5 - size / 2) / focal
    x, y = np.meshgrid(grid, grid)
    rays = np.stack([x, y, np.ones_like(x)], axis=-1)
    ids = ["camera-a", "camera-b", "camera-c"]
    for ordinal, sid in enumerate(ids):
        center = np.array([.4*ordinal, .2*ordinal, .1*ordinal], dtype=np.float32)
        extrinsics = np.eye(4, dtype=np.float32)
        extrinsics[:3, 3] = -center
        rotation = np.eye(3, dtype=np.float32)
        scene = {"id": sid, "position": {axis: float(center[i]) for i, axis in enumerate("xyz")},
                 "yaw": 0., "floor": 0, "componentId": "observed-main"}
        depth = ((3 + .1*center[0] + .05*center[1] - center[2]) / (1 - .1*x - .05*y)).astype(np.float32)
        confidence = (3 + .1*x + .02*y).astype(np.float32)
        view = {"id": sid, "scene": scene, "depth": depth, "rawDepth": depth.copy(), "confidence": confidence,
                "rotation": rotation, "center": center, "extrinsics": extrinsics,
                "modelInputExtrinsics": extrinsics.copy(), "predictedExtrinsics": extrinsics[:3].copy(),
                "predictedIntrinsics": np.array([[focal,0,189],[0,focal,189],[0,0,1]], dtype=np.float32),
                "image": np.zeros((378,378,3), dtype=np.uint8), "rays": rays}
        mask = np.zeros((189,189), dtype=bool)
        mask[10:-10:2,10:-10:2] = True
        support = {other: mask.copy() for other in ids if other != sid}
        points = rays[::2,::2] * depth[::2,::2,None] + center
        views.append(view)
        results.append({"view": view, "points": points, "valid": mask,
                        "confidence": np.where(mask, .77+.02*ordinal, 0).astype(np.float32), "support": support})
    return views, results


def synthetic(group=None, pitch=-30):
    group = group or [{"id": "a", "position": {"x": 0., "y": 0., "z": 0.}, "yaw": 0., "floor": 0, "componentId": "observed-main"},
                      {"id": "b", "position": {"x": 1., "y": 0., "z": 0.}, "yaw": 0., "floor": 0, "componentId": "observed-main"}]
    views, results = [], []
    for scene in group:
        for heading in (0, 90, 180, 270):
            center = np.array([scene["position"][axis] for axis in "xyz"])
            rotation = core.basis(heading, pitch)
            ext = np.eye(4, dtype=np.float32); ext[:3, :3] = rotation.T; ext[:3, 3] = -rotation.T @ center
            view = {"id": scene["id"], "scene": scene, "rotation": rotation, "center": center, "extrinsics": ext,
                    "rays": core.rays_for() @ rotation.T, "heading": heading, "pitch": pitch,
                    "image": np.full((378, 378, 3), 127, dtype=np.uint8),
                    "depth": np.full((378, 378), 2., dtype=np.float32),
                    "rawDepth": np.full((378, 378), 2., dtype=np.float32),
                    "confidence": np.full((378, 378), 3.5, dtype=np.float32)}
            mask = np.zeros((189, 189), dtype=bool); mask[4:-4, 4:-4] = True
            result = {"view": view, "valid": mask, "confidence": np.where(mask, .8, 0).astype(np.float32),
                      "points": core.rays_for()[::2, ::2] * 2 @ rotation.T + center,
                      "support": {other["id"]: mask.copy() for other in group if other["id"] != scene["id"]}}
            views.append(view); results.append(result)
    return views, results


class GeometryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="geometry-evidence-test-", dir=SCRATCH)
        self.folder = Path(self.temporary.name)
        self.assertTrue(self.folder.resolve().is_relative_to(SCRATCH.resolve()))
        self.addCleanup(self.temporary.cleanup)
        self.views, self.results = fixture()
        self.key = "a" * 64
        self.ids = [view["id"] for view in self.views]
        self.pass_info = {"poseScale": 1.0, "normalizedPoseError": .01}

    def complete(self, folder=None):
        writer = core.GeometryEvidenceWriter(folder or self.folder)
        records = []
        for pitch in (-30, 30):
            views, results = synthetic(pitch=pitch)
            records.append(writer.write(self.key, pitch, views, results, self.pass_info))
        return writer, records

    def test_raw_camera_fixture_retains_native_arrays_and_exact_calibration(self):
        before = [view["rawDepth"].copy() for view in self.views]
        scale = 1.25
        for view in self.views:
            view["depth"] = view["rawDepth"] / scale
        arrays = core.geometry_arrays(self.views, self.results, {**self.pass_info, "poseScale": scale})
        self.assertEqual(arrays["raw_depth"].shape, (3, 378, 378))
        self.assertEqual(arrays["validated_depth"].shape, (3, 189, 189))
        self.assertFalse(any("rgb" in key.lower() or "image" in key.lower() or "path" in key.lower() for key in arrays))
        np.testing.assert_array_equal(arrays["pixel_centers"], np.arange(189) * 2 + .5)
        np.testing.assert_array_equal(arrays["intrinsics"], core.make_intrinsics(378))
        for i, (view, result) in enumerate(zip(self.views, self.results)):
            np.testing.assert_array_equal(arrays["raw_depth"][i], before[i])
            np.testing.assert_array_equal(arrays["raw_confidence"][i], view["confidence"])
            np.testing.assert_array_equal(arrays["world_to_camera"][i], view["extrinsics"])
            np.testing.assert_array_equal(arrays["model_input_extrinsics"][i], view["modelInputExtrinsics"])
            np.testing.assert_array_equal(arrays["predicted_extrinsics"][i], view["predictedExtrinsics"])
            np.testing.assert_array_equal(arrays["predicted_intrinsics"][i], view["predictedIntrinsics"])
            np.testing.assert_array_equal(arrays["valid_mask"][i], result["valid"])
            np.testing.assert_array_equal(arrays["validated_confidence"][i], result["confidence"])
            np.testing.assert_array_equal(arrays["validated_depth"][i], np.where(result["valid"], view["depth"][::2, ::2], 0))
            np.testing.assert_array_equal(arrays["physical_support_bits"][i], np.where(result["valid"], 7, 0))
        pixels = np.stack(np.meshgrid(arrays["pixel_centers"], arrays["pixel_centers"]), axis=-1)
        rays = np.concatenate([pixels, np.ones((189, 189, 1))], axis=-1) @ np.linalg.inv(arrays["intrinsics"]).T
        np.testing.assert_allclose(rays, core.rays_for()[::2, ::2], atol=2e-7, rtol=0)
        writer = core.GeometryEvidenceWriter(self.folder)
        record = writer.write(self.key, -30, self.views, self.results, {**self.pass_info, "poseScale": scale})
        with np.load(writer.directory / record["file"], allow_pickle=False) as saved:
            self.assertEqual(set(saved.files), set(arrays))
            for key, value in arrays.items():
                np.testing.assert_array_equal(saved[key], value)

    def test_reloaded_rays_recover_an_independent_analytic_world_plane(self):
        arrays = core.geometry_arrays(self.views, self.results, self.pass_info)
        pixel = arrays["pixel_centers"]
        u, v = np.meshgrid(pixel, pixel)
        image_points = np.stack([u, v, np.ones_like(u)], axis=-1)
        rays = image_points @ np.linalg.inv(arrays["intrinsics"]).T
        for i, view in enumerate(self.views):
            pose = np.linalg.inv(arrays["world_to_camera"][i])
            world = (rays * arrays["validated_depth"][i, ..., None]) @ pose[:3,:3].T + pose[:3,3]
            valid = arrays["valid_mask"][i].astype(bool)
            residual = world[...,2] - 3 - .1*world[...,0] - .05*world[...,1]
            np.testing.assert_allclose(residual[valid], 0, atol=8e-7, rtol=0)

    def test_archive_pair_verifies_and_manifest_is_complete_without_model(self):
        with patch.object(core, "Model", side_effect=AssertionError("Model must not initialize")):
            writer, records = self.complete()
            fresh = core.GeometryEvidenceWriter(self.folder)
            self.assertTrue(fresh.verify(records, self.key, {"a", "b"}, 0, "observed-main"))
            summary = fresh.finalize(2)
        self.assertEqual(summary["status"], "complete")
        self.assertEqual((summary["batchCount"], summary["viewCount"]), (2, 16))
        self.assertEqual(summary["totalBytes"], sum(record["byteLength"] for record in records))
        self.assertEqual(summary["manifest"], "joint-geometry/manifest.json")
        manifest = json.loads((writer.directory / "manifest.json").read_text())
        self.assertEqual(len(manifest["files"]), 2)

    def test_legacy_cache_missing_hash_floor_component_and_camera_mismatch_reject(self):
        writer, records = self.complete()
        fresh = core.GeometryEvidenceWriter(self.folder)
        for legacy in (None, [], {}, records[:1]):
            self.assertFalse(fresh.verify(legacy, self.key, {"a", "b"}, 0, "observed-main"))
        for field, wrong in (("sha256", "0" * 64), ("byteLength", records[0]["byteLength"] + 1), ("floor", 1), ("componentId", "foreign"), ("sceneIds", ["a", "foreign"]), ("file", "../escape.npz")):
            corrupted = copy.deepcopy(records); corrupted[0][field] = wrong
            with self.subTest(field=field):
                self.assertFalse(fresh.verify(corrupted, self.key, {"a", "b"}, 0, "observed-main"))
                self.assertEqual(fresh.files, {})
        (writer.directory / records[1]["file"]).unlink()
        self.assertFalse(fresh.verify(records, self.key, {"a", "b"}, 0, "observed-main"))
        self.assertEqual(fresh.files, {}, "One valid pitch cannot register a partial cache hit")
        self.assertEqual(fresh.finalize(2)["status"], "unavailable")

    def test_linked_archive_and_directory_are_rejected(self):
        writer, records = self.complete()
        target = writer.directory / records[0]["file"]
        native = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda candidate: candidate == target or native(candidate)):
            self.assertFalse(core.GeometryEvidenceWriter(self.folder).verify(records, self.key, {"a", "b"}, 0, "observed-main"))
        with patch.object(Path, "is_symlink", lambda candidate: candidate == writer.directory or native(candidate)):
            with self.assertRaisesRegex(ValueError, "links"):
                core.GeometryEvidenceWriter(self.folder)

    def test_archive_total_batch_and_manifest_caps_are_enforced(self):
        views, results = synthetic()
        writer = core.GeometryEvidenceWriter(self.folder)
        for constant in ("GEOMETRY_FILE_MAX", "GEOMETRY_TOTAL_MAX"):
            with self.subTest(limit=constant), patch.object(core, constant, 100), self.assertRaises(ValueError):
                writer.write(self.key, -30, views, results, self.pass_info)
            self.assertEqual(writer.files, {})
        with patch.object(core, "GEOMETRY_BATCH_MAX", 1):
            writer.write(self.key, -30, views, results, self.pass_info)
            with self.assertRaises(ValueError):
                writer.write(self.key, 30, views, results, self.pass_info)
        self.assertEqual(writer.finalize(2)["status"], "partial")
        with patch.object(core, "GEOMETRY_MANIFEST_MAX", 10), self.assertRaises(ValueError):
            writer.finalize(2)

    def test_invalid_scale_single_camera_unsupported_mask_and_nonfinite_raw_reject(self):
        for info in ({"poseScale": 0, "normalizedPoseError": 0}, {"poseScale": 1, "normalizedPoseError": .181}):
            with self.assertRaises(ValueError):
                core.geometry_arrays(self.views, self.results, info)
        with self.assertRaises(ValueError):
            core.geometry_arrays(self.views[:1] * 2, self.results[:1] * 2, self.pass_info)
        self.views[0]["rawDepth"][0, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "Nonfinite"):
            core.geometry_arrays(self.views, self.results, self.pass_info)
        self.views[0]["rawDepth"][0, 0] = self.views[0]["depth"][0, 0]
        self.results[0]["support"] = {}
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            core.geometry_arrays(self.views, self.results, self.pass_info)

    def test_actual_run_default_opt_in_cache_hit_and_deleted_archive_rebuild(self):
        group = [view["scene"] for view in synthetic()[0][::4]]
        for scene in group:
            image = self.folder / (scene["id"] + ".png")
            core.Image.new("RGB", (32, 16), (90, 100, 110)).save(image)
            scene["path"] = str(image)
        payload = {"scenes": group, "links": [{"from": "a", "to": "b"}]}
        runs = []
        class FakeModel:
            def run(self, views, retain_raw=False):
                runs.append(retain_raw)
                for view in views:
                    if retain_raw:
                        view["rawDepth"] = view["depth"].copy()
                    else:
                        view.pop("rawDepth", None)
                return {"poseScale": 1., "normalizedPoseError": .01}
        def render(group, pitch, images):
            views, results = synthetic(group, pitch)
            for view, result in zip(views, results):
                view["test_result"] = result
            return views
        def pack(results, profiles):
            ids = {result["view"]["id"] for result in results}
            return {sid: {"sums": np.full(8192, 2.), "weights": np.ones(8192), "squares": np.full(8192, 4.)} for sid in ids}, []
        evidence_dir = self.folder / "private-attempt"
        with patch.dict(os.environ, {"IMO3D_ANALYSIS_CACHE_DIR": str(self.folder / "cache")}), patch.object(core, "Model", FakeModel), patch.object(core, "render_views", side_effect=render), patch.object(core, "validate_surfaces", side_effect=lambda views: [view["test_result"] for view in views]), patch.object(core, "pack_surfaces", side_effect=pack), contextlib.redirect_stdout(io.StringIO()):
            legacy = core.run(copy.deepcopy(payload), evidence_output_dir=evidence_dir)
            self.assertNotIn("geometryEvidence", legacy)
            self.assertEqual(runs, [False, False])
            self.assertFalse((evidence_dir / "joint-geometry").exists())
            opted = {**payload, "retainGeometryEvidence": True}
            generated = core.run(copy.deepcopy(opted), evidence_output_dir=evidence_dir)
            self.assertEqual(runs, [False, False, True, True])
            self.assertEqual(generated["geometryEvidence"]["status"], "complete")
            files = sorted((evidence_dir / "joint-geometry").glob("*.npz"))
            self.assertEqual(len(files), 2)
            with patch.object(core, "Model", side_effect=AssertionError("Complete cache should not initialize model")):
                cached = core.run(copy.deepcopy(opted), evidence_output_dir=evidence_dir)
            self.assertEqual(cached["geometryEvidence"]["status"], "complete")
            self.assertEqual(len(runs), 4)
            files[0].unlink()
            rebuilt = core.run(copy.deepcopy(opted), evidence_output_dir=evidence_dir)
            self.assertEqual(runs, [False, False, True, True, True, True])
            self.assertEqual(rebuilt["geometryEvidence"]["status"], "complete")
            self.assertEqual(len(list((evidence_dir / "joint-geometry").glob("*.npz"))), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
