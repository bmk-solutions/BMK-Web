"""Image-boundary projection and floor-plane scale tests with independent geometry."""
import importlib.util
import copy
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("envelope", Path(__file__).resolve().parents[1] / "scripts/imo3d-room-envelope.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
np = core.np


def profiles(polygon, ratio=.8, count=1024):
    angles = (np.arange(count) / count - .5) * 2 * np.pi
    radius = core.polygon_radii(polygon, angles)
    return {"floorBoundaryRadians": np.arctan(1 / radius), "ceilingBoundaryRadians": -np.arctan(ratio / radius)}


def pair_data(floor_count=40, furniture_count=20, baseline=.7):
    rng = np.random.default_rng(522)
    coordinates = rng.uniform([-2., -2.], [2., 2.], (floor_count + furniture_count, 2))
    points = np.column_stack((coordinates[:, 0], -np.ones(len(coordinates)), coordinates[:, 1]))
    points[floor_count:, 1] = -.35
    second = points - np.array([baseline, 0, 0])
    depth1, depth2 = np.linalg.norm(points, axis=1), np.linalg.norm(second, axis=1)
    first = {"bearings": points / depth1[:, None]}
    other = {"bearings": second / depth2[:, None]}
    pair = {"_indices1": np.arange(len(points)), "_indices2": np.arange(len(points)), "_depths1": depth1 / baseline, "_depths2": depth2 / baseline}
    profile = profiles([[-4, -4], [4, -4], [4, 4], [-4, 4]])
    return pair, first, other, profile


def aperture_data(gap=.2, threshold=False, count=80):
    rooms = [{"id": name, "component": "c", "floor": 0, "sceneIds": [name], "confidence": .8, "ceilingHeight": 2,
              "outline": [{"x": x, "z": z} for x, z in [(low, -1), (high, -1), (high, 1), (low, 1)]]}
             for name, low, high in [("a", -2, 0), ("b", gap, gap + 2)]]
    second_x = gap - .15 if threshold else gap + 1
    scenes = [{"id": name, "component": "c", "floor": 0, "position": {"x": x, "z": 0}, "yaw": 0} for name, x in [("a", -1), ("b", second_x)]]
    connection = [{"a": "a", "b": "b", "scenePairs": [{"a": "a", "b": "b", "confidence": .9}]}]
    points = np.column_stack([np.full(count, gap + 1.6), np.zeros(count), np.linspace(-.6, .6, count)]) / (second_x + 1)
    pairs = [{"a": "a", "b": "b", "direction": np.array([1, 0, 0]), "_points": points}]
    return rooms, scenes, connection, pairs


class RoomEnvelopeGeometry(unittest.TestCase):
    def test_threshold_camera_does_not_have_to_be_forced_inside_its_contour(self):
        rooms, scenes, connections, pairs = aperture_data(threshold=True)
        original_rooms, original_scenes = copy.deepcopy(rooms), copy.deepcopy(scenes)
        portals, diagnostics = core.infer_observed_room_openings(rooms, scenes, connections, pairs)
        self.assertEqual(len(portals), 1)
        self.assertEqual(scenes, original_scenes)
        self.assertEqual([room['outline'] for room in rooms], [room['outline'] for room in original_rooms])
        self.assertEqual(diagnostics, [])
        self.assertTrue(all(room['doorwayCandidates'][0]['widthInterpretation'] == 'visible_span_lower_bound' for room in rooms))

    def test_separate_observed_faces_get_openings_without_an_invented_bridge(self):
        rooms, scenes, connections, pairs = aperture_data(gap=.6)
        original = copy.deepcopy(rooms)
        architecture = {}
        actual, contacts = core.align_observed_wall_contacts(rooms, scenes, connections, pairs, architecture)
        self.assertEqual(contacts, [])
        self.assertEqual([room['outline'] for room in actual], [room['outline'] for room in original])
        self.assertEqual(len(architecture['architectureConnections']), 1)
        self.assertAlmostEqual(architecture['architectureConnections'][0]['gap'], .6, delta=.05)
        self.assertTrue(all(not room['doorwayCandidates'][0]['verified'] for room in actual))

    def test_visual_overlap_through_another_room_is_not_a_doorway(self):
        rooms, scenes, connections, pairs = aperture_data(gap=.6)
        rooms.append({'id': 'hall', 'component': 'c', 'floor': 0, 'sceneIds': ['hall'], 'confidence': .8, 'ceilingHeight': 2,
                      'outline': [{'x': x, 'z': z} for x, z in [(.1, -1), (.4, -1), (.4, 1), (.1, 1)]]})
        actual, contacts = core.align_observed_wall_contacts(rooms, scenes, connections, pairs)
        self.assertEqual(contacts, [])
        self.assertTrue(all(not room.get('doorwayCandidates') for room in actual))
        _, diagnostics = core.infer_observed_room_openings(actual, scenes, connections, pairs)
        self.assertEqual(diagnostics[0]['reason'], 'visual_sightline_through_third_room')
        self.assertEqual(diagnostics[0]['interveningRoomIds'], ['hall'])
        rooms[-1]['floor'] = 1
        portals, _ = core.infer_observed_room_openings(rooms, scenes, connections, pairs)
        self.assertEqual(len(portals), 1)

    def test_third_room_corner_grazing_does_not_block_a_real_opening(self):
        square = np.array([[0., 0], [1, 0], [1, 1], [0, 1]])
        self.assertEqual(core.segment_interior_length(np.array([-1., -.01]), np.array([2., -.01]), square), 0)
        self.assertAlmostEqual(core.segment_interior_length(np.array([-1., .5]), np.array([2., .5]), square), 1)
        # Exact edge intersection must remain a grazing observation.
        self.assertEqual(core.segment_interior_length(np.array([-1., 0]), np.array([2., 0]), square), 0)

    def test_sparse_and_separated_feature_clusters_do_not_supply_a_standard_width(self):
        for count in [0, 15]:
            rooms, scenes, connections, pairs = aperture_data(count=count)
            portals, _ = core.infer_observed_room_openings(rooms, scenes, connections, pairs)
            self.assertEqual(portals, [])
        rooms, scenes, connections, pairs = aperture_data()
        pairs[0]['_points'][:, 2] = np.r_[np.linspace(-.9, -.8, 40), np.linspace(.8, .9, 40)] / 2.2
        portals, _ = core.infer_observed_room_openings(rooms, scenes, connections, pairs)
        self.assertEqual(portals, [])

    def test_aperture_observations_never_cross_component_frames(self):
        rooms, scenes, connections, pairs = aperture_data()
        rooms[1]['component'] = 'independent-origin'
        portals, _ = core.infer_observed_room_openings(rooms, scenes, connections, pairs)
        self.assertEqual(portals, [])

    def test_threshold_requires_two_sided_strong_and_corroborated_evidence(self):
        rooms, scenes, _, _ = aperture_data(gap=.3)
        rooms[0]['sceneIds'].append('a2'); rooms[1]['sceneIds'].append('b2')
        scenes.append({'id': 'threshold', 'component': 'c', 'floor': 0, 'position': {'x': .15, 'z': 0}})
        pairs = [{'a': 'threshold', 'b': name, 'confidence': confidence} for name, confidence in [('a', .9), ('a2', .6), ('b', .9), ('b2', .6)]]
        connections = core.observed_threshold_connections(rooms, scenes, pairs)
        self.assertEqual(len(connections), 1)
        self.assertEqual(connections[0]['viaSceneId'], 'threshold')
        self.assertEqual(len(connections[0]['scenePairs']), 4)
        self.assertEqual(core.observed_threshold_connections(rooms, scenes, pairs[:-1]), [])
        self.assertEqual(core.observed_threshold_connections(rooms, scenes, [{**pair, 'confidence': .6} for pair in pairs]), [])
        scenes[-1]['position']['z'] = 3
        self.assertEqual(core.observed_threshold_connections(rooms, scenes, pairs), [])

    def test_threshold_observation_alone_does_not_cut_an_aperture(self):
        rooms, scenes, connections, _ = aperture_data()
        portals, _ = core.infer_observed_room_openings(rooms, scenes, connections, [])
        self.assertEqual(portals, [])
        self.assertTrue(all(not room.get('doorwayCandidates') for room in rooms))

    def test_rectangle_from_boundary_has_true_aspect_and_camera_offset(self):
        expected = np.array([[-1.2, -3.1], [2.3, -3.1], [2.3, 1.4], [-1.2, 1.4]])
        result = core.outline_from_profiles(profiles(expected))
        actual = np.asarray([[p["x"], p["z"]] for p in result["outline"]])
        self.assertEqual(len(actual), 4)
        np.testing.assert_allclose(actual.min(axis=0), expected.min(axis=0), atol=.025)
        np.testing.assert_allclose(actual.max(axis=0), expected.max(axis=0), atol=.025)
        self.assertAlmostEqual(result["ceilingAboveCamera"], .8, places=4)
        self.assertEqual(result["scale"], "camera_height")

    def test_concave_room_is_not_replaced_with_bounding_box_or_hull(self):
        expected = np.array([[-2., -3.], [1., -3.], [1., -1.], [3., -1.], [3., 2.], [-2., 2.]])
        result = core.outline_from_profiles(profiles(expected))
        actual = np.asarray([[p["x"], p["z"]] for p in result["outline"]])
        self.assertEqual(len(actual), 6)
        angles = np.linspace(-np.pi, np.pi, 360, endpoint=False)
        np.testing.assert_allclose(core.polygon_radii(actual, angles), core.polygon_radii(expected, angles), atol=.04)

    def test_rotation_keeps_pixel_bearing_and_room_dimensions(self):
        polygon = np.array([[-1., -3.], [2., -3.], [2., 1.], [-1., 1.]])
        angle = .37
        rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
        expected = polygon @ rotation.T
        result = core.outline_from_profiles(profiles(expected), angle)
        actual = np.asarray([[p["x"], p["z"]] for p in result["outline"]])
        headings = np.linspace(-np.pi, np.pi, 360, endpoint=False)
        np.testing.assert_allclose(core.polygon_radii(actual, headings), core.polygon_radii(expected, headings), atol=.04)

    def test_invalid_boundary_does_not_create_arbitrary_room(self):
        with self.assertRaises(ValueError):
            core.outline_from_profiles({"floorBoundaryRadians": np.zeros(1024), "ceilingBoundaryRadians": np.zeros(1024)})

    def test_floor_consensus_recovers_baseline_despite_furniture(self):
        pair, first, second, profile = pair_data()
        result = core.infer_floor_baseline(pair, first, second, profile, profile)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["baseline"], .7, places=6)
        self.assertGreaterEqual(result["supportPoints"], 25)

    def test_majority_furniture_does_not_replace_supported_lower_floor(self):
        pair, first, second, profile = pair_data(25, 45)
        result = core.infer_floor_baseline(pair, first, second, profile, profile)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["baseline"], .7, places=6)

    def test_missing_or_inconsistent_floor_support_does_not_impose_scale(self):
        pair, first, second, profile = pair_data(8, 0)
        self.assertIsNone(core.infer_floor_baseline(pair, first, second, profile, profile))

    def test_same_room_observations_fuse_in_shared_camera_frame(self):
        world = np.array([[-2., -2.], [2., -2.], [2., 2.], [-2., 2.]])
        scenes = []
        for name, x in [("a", 0), ("b", .7)]:
            envelope = core.outline_from_profiles(profiles(world - [x, 0]))
            scenes.append({"id": name, "floor": 0, "component": "c", "position": {"x": x, "z": 0}, "yaw": 0, "roomEnvelope": envelope})
        result = core.aggregate_room_envelopes(scenes, [{"id": "c", "scaleBasis": "camera_height"}], [{"a": "a", "b": "b", "confidence": .9}])
        self.assertEqual(len(result["rooms"]), 1)
        self.assertEqual(result["rooms"][0]["sceneIds"], ["a", "b"])
        actual = np.asarray([[p["x"], p["z"]] for p in result["rooms"][0]["outline"]])
        np.testing.assert_allclose(actual.min(axis=0), [-2, -2], atol=.04)
        np.testing.assert_allclose(actual.max(axis=0), [2, 2], atol=.04)

    def test_adjacent_different_rooms_keep_walls_and_visual_relation(self):
        envelope = core.outline_from_profiles(profiles([[-1, -1], [1, -1], [1, 1], [-1, 1]]))
        scenes = [{"id": name, "floor": 0, "component": "c", "position": {"x": x, "z": 0}, "yaw": 0, "roomEnvelope": envelope} for name, x in [("a", 0), ("b", 2)]]
        result = core.aggregate_room_envelopes(scenes, [{"id": "c", "scaleBasis": "camera_height"}], [{"a": "a", "b": "b", "confidence": .9}])
        self.assertEqual(len(result["rooms"]), 2)
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["walkability"], "unverified")

    def test_independent_origins_and_unscaled_component_are_not_merged(self):
        envelope = core.outline_from_profiles(profiles([[-1, -1], [1, -1], [1, 1], [-1, 1]]))
        scenes = [{"id": name, "floor": 0, "component": name, "position": {"x": 0, "z": 0}, "yaw": 0, "roomEnvelope": envelope} for name in ["a", "b", "c"]]
        components = [{"id": name, "scaleBasis": "camera_height" if name != "c" else "unscaled"} for name in ["a", "b", "c"]]
        result = core.aggregate_room_envelopes(scenes, components, [])
        self.assertEqual(len(result["rooms"]), 2)
        self.assertEqual(result["unplacedEnvelopeSceneIds"], ["c"])
        pair, first, second, profile = pair_data()
        pair["_depths2"] *= 1.4
        self.assertIsNone(core.infer_floor_baseline(pair, first, second, profile, profile))

    def test_single_doorway_envelope_cannot_fill_two_supported_rooms(self):
        def room(name, bounds, count, confidence):
            x1, z1, x2, z2 = bounds
            return {"id": name, "component": "c", "floor": 0, "sceneIds": [name + str(i) for i in range(count)],
                    "confidence": confidence, "evidence": {},
                    "outline": [{"x": x, "z": z} for x, z in [(x1, z1), (x2, z1), (x2, z2), (x1, z2)]]}
        rooms = [room("first", [-2, -2, 0, 2], 3, .85), room("second", [.2, -2, 2.2, 2], 3, .85),
                 room("doorway", [-2, -2, 2.2, 2], 1, .5)]
        actual, excluded = core.partition_room_regions(rooms)
        self.assertEqual({item["id"] for item in actual}, {"first", "second"})
        self.assertEqual(excluded[0]["reason"], "single_view_spans_multiple_supported_rooms")

    def test_nested_weaker_boundary_does_not_become_an_overlapping_ring(self):
        def room(name, size, count, confidence):
            return {"id": name, "component": "c", "floor": 0, "sceneIds": [name + str(i) for i in range(count)],
                    "confidence": confidence, "evidence": {},
                    "outline": [{"x": x, "z": z} for x, z in [(-size, -size), (size, -size), (size, size), (-size, size)]]}
        actual, excluded = core.partition_room_regions([room("supported", 2, 5, .85), room("conflicting", 2.1, 1, .7)])
        self.assertEqual([item["id"] for item in actual], ["supported"])
        self.assertEqual(excluded[0]["reason"], "boundary_mostly_contradicted_by_supported_rooms")

    def test_adjacent_partial_overlap_is_partitioned_without_filling_new_area(self):
        def room(name, x1, x2):
            return {"id": name, "component": "c", "floor": 0, "sceneIds": [name], "confidence": .8, "evidence": {},
                    "outline": [{"x": x, "z": z} for x, z in [(x1, -1), (x2, -1), (x2, 1), (x1, 1)]]}
        actual, excluded = core.partition_room_regions([room("a", -2, .2), room("b", -.2, 2)])
        self.assertEqual(len(actual), 2)
        self.assertEqual(excluded, [])
        polygons = [np.asarray([[p["x"], p["z"]] for p in item["outline"]]) for item in actual]
        self.assertLess(core.footprint_overlap(*polygons)[0], .025)
        self.assertTrue(all(np.min(p[:, 0]) >= -2.02 and np.max(p[:, 0]) <= 2.02 for p in polygons))

    def test_wall_alignment_requires_visual_connection_and_bounded_gap(self):
        def data(gap):
            rooms = [{"id": name, "component": "c", "floor": 0, "sceneIds": [name], "confidence": .8, "ceilingHeight": 2,
                      "outline": [{"x": x, "z": z} for x, z in [(low, -1), (high, -1), (high, 1), (low, 1)]]}
                     for name, low, high in [("a", -2, 0), ("b", gap, gap + 2)]]
            scenes = [{"id": name, "position": {"x": x, "z": 0}, "yaw": 0} for name, x in [("a", -1), ("b", gap + 1)]]
            return rooms, scenes
        connection = [{"a": "a", "b": "b", "scenePairs": [{"a": "a", "b": "b", "confidence": .9}]}]
        rooms, scenes = data(.2)
        unchanged, contacts = core.align_observed_wall_contacts(rooms, scenes, [], [])
        self.assertEqual(contacts, [])
        self.assertEqual(max(p["x"] for p in unchanged[0]["outline"]), 0)
        aligned, contacts = core.align_observed_wall_contacts(*data(.2), connection, [])
        self.assertEqual(len(contacts), 1)
        self.assertAlmostEqual(max(p["x"] for p in aligned[0]["outline"]), .1, places=4)
        self.assertAlmostEqual(min(p["x"] for p in aligned[1]["outline"]), .1, places=4)
        self.assertTrue(all(not room.get("doorwayCandidates") for room in aligned))
        _, contacts = core.align_observed_wall_contacts(*data(.6), connection, [])
        self.assertEqual(contacts, [])

    def test_aperture_width_comes_from_matched_rays_and_stays_unverified(self):
        rooms = [{"id": name, "component": "c", "floor": 0, "sceneIds": [name], "confidence": .8, "ceilingHeight": 2,
                  "outline": [{"x": x, "z": z} for x, z in [(low, -1), (high, -1), (high, 1), (low, 1)]]}
                 for name, low, high in [("a", -2, 0), ("b", .2, 2.2)]]
        scenes = [{"id": name, "position": {"x": x, "z": 0}, "yaw": 0} for name, x in [("a", -1), ("b", 1.2)]]
        connection = [{"a": "a", "b": "b", "scenePairs": [{"a": "a", "b": "b", "confidence": .9}]}]
        points = np.column_stack([np.full(40, 2.4), np.zeros(40), np.linspace(-.4, .4, 40)]) / 2.2
        pairs = [{"a": "a", "b": "b", "direction": np.array([1, 0, 0]), "_points": points}]
        actual, contacts = core.align_observed_wall_contacts(rooms, scenes, connection, pairs)
        self.assertEqual(len(contacts), 1)
        self.assertTrue(all(len(room["doorwayCandidates"]) == 1 for room in actual))
        for room in actual:
            candidate = room["doorwayCandidates"][0]
            self.assertFalse(candidate["verified"])
            self.assertAlmostEqual(candidate["offset"], .5, places=3)
            self.assertGreater(candidate["width"], .1)
            self.assertLess(candidate["width"], .2)
            self.assertGreaterEqual(candidate["supportRays"], 16)

    def test_excluded_partial_boundary_keeps_provisional_photo_membership(self):
        world_a = np.array([[-2., -1], [0, -1], [0, 1], [-2, 1]])
        world_b = np.array([[-3., -1], [-.5, -1], [-.5, 1], [-3, 1]])
        scenes = []
        for name, x, world, confidence in [("a", -1, world_a, .9), ("b", -2.2, world_b, .5)]:
            envelope = core.outline_from_profiles(profiles(world - [x, 0])); envelope["confidence"] = confidence
            scenes.append({"id": name, "floor": 0, "component": "c", "position": {"x": x, "z": 0}, "yaw": 0, "roomEnvelope": envelope})
        result = core.aggregate_room_envelopes(scenes, [{"id": "c", "scaleBasis": "camera_height"}], [{"a": "a", "b": "b", "confidence": .9}])
        self.assertEqual(len(result["rooms"]), 1)
        self.assertEqual(result["rooms"][0]["sceneIds"], ["a", "b"])
        self.assertEqual(result["rooms"][0]["boundarySceneIds"], ["a"])
        relation = result["relations"][0]
        self.assertTrue(relation["provisional"])
        self.assertFalse(relation["verified"])
        self.assertGreater(relation["confidence"], .75)

    def test_corridor_evidence_requires_narrow_geometry_distributed_cameras_and_access(self):
        polygon = [{"x": x, "z": z} for x, z in [(-.5, -2), (.5, -2), (.5, 2), (-.5, 2)]]
        rooms = [{"id": "hall", "component": "c", "floor": 0, "sceneIds": ["a", "b", "c"], "confidence": .75, "outline": polygon}]
        rooms += [{"id": name, "component": "c", "floor": 0, "sceneIds": [name], "confidence": .8, "outline": polygon} for name in ["one", "two", "three"]]
        scenes = [{"id": name, "position": {"x": 0, "z": z}} for name, z in [("a", -1.5), ("b", 0), ("c", 1.5)]]
        connections = [{"a": "hall", "b": name, "scenePairs": [{"a": "a", "b": name, "confidence": .85}]} for name in ["one", "two", "three"]]
        original = copy.deepcopy(rooms)
        result = core.infer_corridor_observations(rooms, scenes, connections, [{"sceneId": "a", "kind": "bedroom", "confidence": .58}])
        self.assertEqual({item["sceneId"] for item in result}, {"a", "b", "c"})
        self.assertTrue(all(item["kind"] == "corridor" and item["confidence"] == .78 and item["needsReview"] for item in result))
        self.assertEqual(rooms, original)
        self.assertEqual(core.infer_corridor_observations(rooms, scenes, connections[:2]), [])
        near_cameras = [{**scene, "position": {"x": 0, "z": scene["position"]["z"] * .1}} for scene in scenes]
        self.assertEqual(core.infer_corridor_observations(rooms, near_cameras, connections), [])
        wide_rooms = copy.deepcopy(rooms)
        for point in wide_rooms[0]["outline"]:
            point["x"] *= 2
        self.assertEqual(core.infer_corridor_observations(wide_rooms, scenes, connections), [])
        strong_bed = [{"sceneId": "a", "kind": "bedroom", "confidence": .8}]
        self.assertEqual(core.infer_corridor_observations(rooms, scenes, connections, strong_bed), [])


class ObliqueWallReconstructionTests(unittest.TestCase):
    def test_extra_collinear_corner_peak_does_not_reject_oblique_room(self):
        polygon = np.array([[-2., -2.], [2., -2.], [3., 2.], [-2., 2.]])
        angles = (np.arange(1024) / 1024 - .5) * 2 * np.pi
        radii = core.polygon_radii(polygon, angles)
        points = np.column_stack((np.sin(angles) * radii, -np.cos(angles) * radii))
        probabilities = np.zeros(1024)
        for corner in [*polygon, np.array([-2., 0.])]:
            probabilities[np.argmin(np.linalg.norm(points - corner, axis=1))] = 1
        actual, info = core.regularize_outline(radii, corner_probabilities=probabilities)
        self.assertEqual(info.get("method"), "observed-independent-wall-lines")
        self.assertEqual(len(actual), 4)
        self.assertLess(float(np.max(np.min(np.linalg.norm(actual[:, None] - polygon[None, :], axis=2), axis=0))), .025)

    def test_noisy_trapezoid_retains_its_observed_slanted_wall(self):
        polygon = np.array([[-3., -2.], [2., -2.], [3.2, 2.], [-3., 2.]])
        angles = (np.arange(2048) / 2048 - .5) * 2 * np.pi
        exact = core.polygon_radii(polygon, angles)
        noisy = exact + np.random.default_rng(31).normal(0, .008, len(exact))
        actual, info = core.regularize_outline(noisy)
        self.assertEqual(info.get("method"), "observed-independent-wall-lines")
        self.assertEqual(len(actual), 4)
        # Match geometric corners independently of polygon winding/start index.
        error = np.min(np.linalg.norm(actual[:, None] - polygon[None, :], axis=2), axis=0)
        self.assertLess(float(np.max(error)), .04)
        recovered = core.polygon_radii(actual, angles)
        self.assertLess(float(np.quantile(np.abs(recovered - exact), .95)), .025)

    def test_oblique_fit_is_invariant_under_camera_rotation(self):
        polygon = np.array([[-3., -2.], [2., -2.], [3.2, 2.], [-3., 2.]])
        angle = .47
        rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
        expected = polygon @ rotation.T
        angles = (np.arange(2048) / 2048 - .5) * 2 * np.pi
        actual, info = core.regularize_outline(core.polygon_radii(expected, angles))
        self.assertTrue(info["regularized"])
        error = np.min(np.linalg.norm(actual[:, None] - expected[None, :], axis=2), axis=0)
        self.assertLess(float(np.max(error)), .04)


if __name__ == "__main__":
    unittest.main()
