"""Evidence and cache boundaries for the local room recognizer (no model needed)."""
from pathlib import Path
import importlib.util
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("room_vision", Path(__file__).resolve().parents[1] / "scripts" / "imo3d-room-vision.py")
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)


class RoomEvidenceTests(unittest.TestCase):
    def test_gpu_selection_probes_kernels_memory_and_keeps_cpu_fallback(self):
        torch = Mock()
        torch.cuda.is_available.return_value = True
        torch.cuda.mem_get_info.return_value = (4 * 1024 ** 3, 8 * 1024 ** 3)
        with patch.dict(vision.os.environ, {"IMO3D_ROOM_DEVICE": "auto"}):
            self.assertEqual(vision.inference_device(torch), "cuda")
            torch.zeros.assert_called_with(1, device="cuda")
            torch.cuda.mem_get_info.return_value = (1024, 8 * 1024 ** 3)
            self.assertEqual(vision.inference_device(torch), "cpu")
            torch.cuda.is_available.return_value = False
            self.assertEqual(vision.inference_device(torch), "cpu")
        with patch.dict(vision.os.environ, {"IMO3D_ROOM_DEVICE": "cuda"}):
            self.assertRaises(RuntimeError, vision.inference_device, torch)
        with patch.dict(vision.os.environ, {"IMO3D_ROOM_DEVICE": "cpu"}):
            self.assertEqual(vision.inference_device(torch), "cpu")

    def test_complete_cached_evidence_skips_image_decoding_and_inference(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = vision.RoomVision.__new__(vision.RoomVision)
            model.cache_dir, model.revision, model.detector_revision = Path(tmp), "vlm", "detector"
            digest, caption = "image-hash", "Room: living room. Objects: sofa, coffee table, TV."
            keys = [vision.CAPTION_VERSION + model.revision + digest]
            keys += ["room-view-v2" + model.revision + digest + str(yaw) for yaw in (0, 90, 180, 270)]
            for key in keys:
                (model.cache_dir / (vision.hashlib.sha256(key.encode()).hexdigest() + ".json")).write_text(json.dumps({"imageSha256": digest, "caption": caption}), encoding="utf-8")
            object_key = vision.hashlib.sha256(("room-objects-v1" + model.detector_revision + digest).encode()).hexdigest()
            object_file = model.cache_dir / (object_key + ".json")
            object_file.write_text(json.dumps({"imageSha256": digest, "views": [[], [], [], []]}), encoding="utf-8")
            with patch.object(vision, "image_hash", return_value=digest), patch.object(vision.Image, "open", side_effect=ValueError("decode required")):
                result = model.classify({"id": "scene", "path": "unused"})
                self.assertEqual(result["id"], "scene")
                self.assertEqual(len(result["viewEvidence"]), 4)
                object_file.write_text("{}", encoding="utf-8")
                self.assertRaisesRegex(ValueError, "decode required", model.classify, {"id": "scene", "path": "unused"})

    def test_room_function_and_visible_objects(self):
        examples = [("kitchen", "Room: Kitchen. Objects: sink, stove, cabinets."),
                    ("bedroom", "Room: bedroom. Objects: bed, curtains, mirror."),
                    ("bathroom", "Room: bathroom. Objects: toilet, shower, sink."),
                    ("living", "Room: living room. Objects: sofa, coffee table, TV."),
                    ("dining", "Room: dining table."),
                    ("guest", "Room: majlis. Objects: seating, sofas, chairs."),
                    ("corridor", "Room: hallway. Objects: doors."),
                    ("entrance", "Room: foyer. Objects: front door, console."),
                    ("storage", "Room: walk-in wardrobe. Objects: shelves, clothing."),
                    ("balcony", "Room: balcony. Objects: railing, chairs.")]
        for kind, caption in examples:
            with self.subTest(kind=kind):
                result = vision.parse_room_caption(caption)
                self.assertEqual(result["kind"], kind)
                self.assertGreaterEqual(result["confidence"], .8)

    def test_function_without_object_requires_review(self):
        result = vision.parse_room_caption("Room: kitchen. Objects: walls, window, curtains.")
        self.assertEqual(result["kind"], "kitchen")
        self.assertTrue(result["needsReview"])
        self.assertLess(result["confidence"], .8)

    def test_uncertainty_negation_and_no_function_not_promoted(self):
        for caption in ["Objects: bed, sink", "Not a bedroom", "Room: unknown", "I cannot identify the room.", ""]:
            with self.subTest(caption=caption):
                self.assertEqual(vision.parse_room_caption(caption)["kind"], "unknown")

    def test_neighboring_bathroom_never_claims_an_ensuite(self):
        result = vision.parse_room_caption("Room: bedroom. Objects: bed, bathroom visible through a door.")
        self.assertEqual(result["kind"], "bedroom")
        self.assertNotIn("ensuite", result)
        self.assertNotIn("master", str(result))

    def test_conflicting_room_functions_need_review(self):
        result = vision.parse_room_caption("Room: living room and dining room. Objects: sofa and dining table.")
        self.assertTrue(result["needsReview"])
        self.assertLess(result["confidence"], .8)

    def test_guest_bedroom_remains_a_bedroom(self):
        self.assertEqual(vision.parse_room_caption("Room: guest bedroom. Objects: bed and bedside table.")["kind"], "bedroom")

    def test_cache_requires_matching_image_and_valid_caption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "caption.json"
            for data in ["invalid", [], {"imageSha256": "other", "caption": "Room: kitchen. Objects: stove."}, {"imageSha256": "image", "caption": 42}]:
                path.write_text(json.dumps(data), encoding="utf-8")
                self.assertIsNone(vision.read_cached_caption(path, "image"))
            path.write_text(json.dumps({"imageSha256": "image", "caption": "Room: kitchen. Objects: stove.", "kind": "bedroom", "confidence": 1}), encoding="utf-8")
            result = vision.read_cached_caption(path, "image")
            self.assertEqual(result["kind"], "kitchen")
            self.assertLess(result["confidence"], 1)

    def test_input_validation_precedes_model_loading(self):
        for request in [{"scenes": []}, None, {"scenes": [{"id": "a", "path": "one"}, {"id": "a", "path": "two"}]}, {"scenes": [{"id": "a"}]}]:
            with self.assertRaises(ValueError):
                vision.validate_request(request)

    def test_perspective_conflict_does_not_force_majority(self):
        full = vision.parse_room_caption("Room: bedroom. Objects: bed.")
        views = [vision.parse_room_caption("Room: hallway. Objects: doors.") for _ in range(3)]
        views.append(vision.parse_room_caption("Room: bedroom. Objects: bed."))
        result = vision.verify_room_views(full, views)
        self.assertEqual(result["kind"], "bedroom")
        self.assertLess(result["confidence"], .6)
        self.assertTrue(result["needsReview"])
        self.assertIn("neighboring_room_visible", result["reviewFlags"])

    def test_multi_view_agreement_retains_room_function(self):
        full = vision.parse_room_caption("Room: bedroom. Objects: bed.")
        views = [vision.parse_room_caption("Room: bedroom. Objects: bed, wardrobe.") for _ in range(3)]
        views.append(vision.parse_room_caption("Room: unknown. Objects: wall."))
        self.assertGreaterEqual(vision.verify_room_views(full, views)["confidence"], .8)

    def test_visible_bathroom_has_no_privacy_or_door_claim(self):
        caption = "Room: bathroom. Objects: shower, toilet, sink."
        view = {**vision.parse_room_caption(caption), "caption": caption, "yaw": 90}
        proposals = vision.bathroom_directions("bedroom-scene", "bedroom", [view])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["yaw"], 90)
        self.assertEqual(proposals[0]["visibleFixtures"], ["shower", "toilet"])
        self.assertFalse(proposals[0]["privateToFrom"])
        self.assertFalse(proposals[0]["doorwayVerified"])

    def test_glass_cabinet_is_not_bathroom_evidence(self):
        caption = "Room: bedroom. Objects: glass cabinet, mirror, bed."
        view = {**vision.parse_room_caption(caption), "caption": caption, "yaw": 0}
        self.assertEqual(vision.bathroom_directions("bedroom-scene", "bedroom", [view]), [])

    def test_perspective_longitude_wrap_preserves_seam(self):
        import numpy as np
        from PIL import Image
        data = np.zeros((128, 256, 3), dtype=np.uint8)
        data[:, :20, 0] = 240
        data[:, -20:, 0] = 240
        data[:, 108:148, 2] = 240
        source = Image.fromarray(data)
        forward = np.asarray(vision.perspective_image(source, 0, 32))
        backward = np.asarray(vision.perspective_image(source, 180, 32))
        self.assertGreater(int(forward[16, 16, 2]), 200)
        self.assertGreater(int(backward[16, 16, 0]), 200)

    def test_large_independently_detected_bed_resolves_sofa_caption(self):
        full = vision.parse_room_caption("Room: living room. Objects: bed, cupboard.")
        unknown = vision.parse_room_caption("A blank wall.")
        views = [{**unknown, "objects": [{"label": "bed", "confidence": .94, "area": .3}]}]
        result = vision.verify_room_views(full, views)
        self.assertEqual(result["kind"], "bedroom")
        self.assertGreaterEqual(result["confidence"], .8)
        self.assertIn("room_function_corrected_by_visible_bed", result["reviewFlags"])

    def test_small_bed_through_doorway_does_not_locate_camera(self):
        full = vision.parse_room_caption("Room: living room. Objects: sofa.")
        unknown = vision.parse_room_caption("A blank wall.")
        result = vision.verify_room_views(full, [{**unknown, "objects": [{"label": "bed", "confidence": .94, "area": .07}]}])
        self.assertEqual(result["kind"], "living")
        self.assertTrue(result["needsReview"])

    def test_independent_toilet_detection_is_still_only_a_proposal(self):
        caption = "The image shows a doorway in a bedroom."
        view = {**vision.parse_room_caption(caption), "caption": caption, "yaw": 90,
                "objects": [{"label": "toilet", "confidence": .89, "area": .014, "box": [.3, .6, .4, .74]}]}
        proposal = vision.bathroom_directions("scene", "bedroom", [view])[0]
        self.assertGreaterEqual(proposal["confidence"], .8)
        self.assertEqual(proposal["objectEvidence"][0]["label"], "toilet")
        self.assertFalse(proposal["privateToFrom"])

    def test_object_cache_rejects_nonfinite_coordinates_and_forged_areas(self):
        obj = {"label": "bed", "confidence": .9, "area": .25, "box": [0, 0, .5, .5]}
        self.assertTrue(vision.valid_object_views([[obj], [], [], []]))
        for invalid in [{**obj, "area": .8}, {**obj, "confidence": float("nan")}, {**obj, "box": [0, 0, 2, 2]}, {**obj, "label": "master-bedroom"}]:
            self.assertFalse(vision.valid_object_views([[invalid], [], [], []]))

    def test_negated_fixture_is_not_positive_evidence(self):
        caption = "Room: bathroom. Objects: no visible toilet, without a shower."
        result = vision.parse_room_caption(caption)
        self.assertLess(result["confidence"], .8)
        self.assertEqual(vision.bathroom_directions("scene", "bedroom", [{**result, "caption": caption, "yaw": 90}]), [])


if __name__ == "__main__":
    unittest.main()
