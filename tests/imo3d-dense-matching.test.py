"""Synthetic optional-matcher tests; no downloaded weights, GPU calls, or tour photos."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dense_matching", ROOT / "scripts/imo3d-dense-matching.py")
dense = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dense)
np = dense.numpy_module()


def evidence():
    one = dense.perspective_bearings([[200, 200], [310, 280], [260, 200]])
    two = dense.perspective_bearings([[202, 202], [315, 276], [262, 199]])
    return one.astype(np.float32), two.astype(np.float32), np.array([.9, .8, .7], dtype=np.float32)


def metadata():
    return dense.matching_metadata("a" * 64, "b" * 64, {"torch": "test", "kornia": "test"})


def request(root):
    one, two = root / "one.jpg", root / "two.jpg"
    one.write_bytes(b"synthetic first original")
    two.write_bytes(b"synthetic second original")
    return {"scenes": [{"id": "one", "path": str(one)}, {"id": "two", "path": str(two)}],
            "pairs": [[0, 1]], "outputDir": str(root / "output"), "cacheDir": str(root / "cache")}


class OptionalDenseMatching(unittest.TestCase):
    def test_rectilinear_rays_use_the_same_panorama_convention(self):
        for face, expected in enumerate(([0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0])):
            np.testing.assert_allclose(dense.perspective_bearings([[255.5, 255.5]], yaw=face * np.pi / 2)[0], expected, atol=1e-12)
        rays = dense.perspective_bearings([[255.5, 0], [255.5, 511]])
        self.assertGreater(rays[0, 1], 0)
        self.assertLess(rays[1, 1], 0)

    def test_confidence_first_deduplication_is_one_to_one_in_both_images(self):
        a, b, _ = evidence()
        first = np.array([a[0], a[0], a[1], a[2], a[2]])
        second = np.array([b[0], b[1], b[1], b[2], b[0]])
        scores = np.array([.7, .95, .9, .49, .6])
        one, two, confidence = dense.deduplicate_matches(first, second, scores)
        np.testing.assert_allclose(confidence, [.95, .6])
        np.testing.assert_allclose(one, [a[0], a[2]])
        np.testing.assert_allclose(two, [b[1], b[0]])

    def test_low_confidence_nonfinite_and_nonunit_matches_never_reach_geometry(self):
        a, b, scores = evidence()
        a[0, 0] = np.nan
        a[1] *= 2
        scores[2] = .499
        one, two, confidence = dense.deduplicate_matches(a, b, scores)
        self.assertEqual(one.shape, (0, 3))
        self.assertEqual(two.shape, (0, 3))
        self.assertEqual(confidence.shape, (0,))

    def test_cache_is_bound_to_image_content_model_algorithm_and_face_settings(self):
        original = metadata()
        self.assertEqual(dense.cache_key(original), dense.cache_key(dict(reversed(list(original.items())))))
        for key, value in (("modelSha256", "c" * 64), ("algorithm", "next-version"), ("faceSize", 256),
                           ("confidenceThreshold", .6), ("sources", ["b" * 64, "a" * 64]), ("versions", {"torch": "different"})):
            changed = {**original, key: value}
            self.assertNotEqual(dense.cache_key(original), dense.cache_key(changed))
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "cache.npz"
            dense.write_cache(file, original, *evidence())
            self.assertIsNotNone(dense.read_cache(file, original))
            self.assertIsNone(dense.read_cache(file, {**original, "sources": ["new", "b"]}))

    def test_corrupted_or_duplicate_cached_correspondences_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "bad.npz"
            file.write_bytes(b"partial cache write")
            self.assertIsNone(dense.read_cache(file, metadata()))
            for mutate in (lambda a, b, c: a.__setitem__((0, 0), np.inf),
                           lambda a, b, c: a.__setitem__(1, a[0]),
                           lambda a, b, c: c.__setitem__(0, .3)):
                a, b, scores = evidence()
                mutate(a, b, scores)
                np.savez_compressed(file, rays1=a, rays2=b, confidence=scores, metadata=np.array(json.dumps(metadata())))
                self.assertIsNone(dense.read_cache(file, metadata()))

    def test_cache_expansion_is_bounded_before_numpy_load(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "oversized.npz"
            with zipfile.ZipFile(file, "w", zipfile.ZIP_DEFLATED) as archive:
                for name in ("rays1.npy", "rays2.npy", "confidence.npy", "metadata.npy"):
                    archive.writestr(name, b"0" * (dense.MAX_CACHE_EXPANDED_BYTES // 4 + 1))
            with patch.object(np, "load", side_effect=AssertionError("must reject before decompressing")):
                self.assertIsNone(dense.read_cache(file, metadata()))

    def test_candidate_limits_and_indices_are_validated_before_model_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = request(Path(directory))
            for pairs in ([[0, 1]] * 33, [[0, 0]], [[-1, 1]], [[0, 2]], [[False, 1]]):
                with self.assertRaises(dense.DenseUnavailable):
                    dense.validate_request({**raw, "pairs": pairs})
            normalized = dense.validate_request({**raw, "pairs": [[1, 0], [0, 1]]})
            self.assertEqual(normalized["pairs"], [(0, 1)])

    def test_missing_runtime_returns_an_optional_capability_failure_without_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(dense, "RUNTIME_DIRS", (Path(directory) / "absent",)):
                with self.assertRaisesRegex(dense.DenseUnavailable, "runtime-unavailable"):
                    dense.load_runtime()

    def test_gpu_contention_is_rejected_before_model_allocation(self):
        runtime = {"torch": SimpleNamespace(cuda=SimpleNamespace(mem_get_info=lambda: (512 * 1024 * 1024, 8 * 1024**3)))}
        with self.assertRaisesRegex(dense.DenseUnavailable, "cuda-busy"):
            dense.create_model(runtime)

    def test_heartbeat_stops_an_orphan_and_cannot_escape_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = request(root)
            outside = root / "external-heartbeat"
            outside.touch()
            with self.assertRaises(dense.DenseUnavailable):
                dense.validate_request({**raw, "heartbeatFile": str(outside)})
            heartbeat = root / "output" / "heartbeat"
            heartbeat.touch()
            dense.check_heartbeat(heartbeat)
            os.utime(heartbeat, (time.time() - 30, time.time() - 30))
            with self.assertRaisesRegex(dense.DenseUnavailable, "parent-stopped"):
                dense.run({**raw, "heartbeatFile": str(heartbeat)})

    def test_cached_run_never_allocates_model_and_keeps_source_files_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = request(root)
            cache_dir = root / "cache"
            cache_dir.mkdir()
            originals = [(Path(scene["path"]).read_bytes(), Path(scene["path"]).stat().st_mtime_ns) for scene in raw["scenes"]]
            hashes = [dense.file_sha256(scene["path"]) for scene in raw["scenes"]]
            meta = dense.matching_metadata(*hashes, {"test": "runtime"})
            cache = cache_dir / (dense.cache_key(meta) + ".npz")
            dense.write_cache(cache, meta, *evidence())
            with patch.object(dense, "load_runtime", return_value={"versions": {"test": "runtime"}}), \
                    patch.object(dense, "create_model", side_effect=AssertionError("cache hit must avoid inference")):
                result = dense.run(raw)
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["pairs"], [{"i": 0, "j": 1, "cacheFile": cache.name}])
            self.assertEqual(originals, [(Path(scene["path"]).read_bytes(), Path(scene["path"]).stat().st_mtime_ns) for scene in raw["scenes"]])

    def test_cli_cancellation_is_a_clean_optional_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = request(root)
            output_dir = root / "output"
            output_dir.mkdir()
            heartbeat = output_dir / "heartbeat"
            heartbeat.touch()
            os.utime(heartbeat, (time.time() - 30, time.time() - 30))
            raw["heartbeatFile"] = str(heartbeat)
            input_file, output_file = root / "input.json", root / "result.json"
            input_file.write_text(json.dumps(raw), encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "scripts/imo3d-dense-matching.py"), "--input", str(input_file), "--output", str(output_file)], capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 3)
            self.assertEqual(json.loads(output_file.read_text()), {"status": "unavailable", "reason": "parent-stopped", "pairs": []})
            self.assertNotIn(str(root), result.stderr)


if __name__ == "__main__":
    unittest.main()
