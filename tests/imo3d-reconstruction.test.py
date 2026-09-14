"""Independent geometry tests; no reference tour coordinates are used in worker input."""
import importlib.util
import math
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("reconstruction", Path(__file__).resolve().parents[1] / "scripts/imo3d-reconstruction.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
np = core.np


def observations(count=160, yaw=.3, translation=np.array([.8, 0., -.4])):
    rng = np.random.default_rng(281)
    points = rng.normal(size=(count, 3))
    points /= np.linalg.norm(points, axis=1, keepdims=True)
    points *= rng.uniform(3, 10, size=(count, 1))
    rotation = np.array([[np.cos(yaw), 0, np.sin(yaw)], [0, 1, 0], [-np.sin(yaw), 0, np.cos(yaw)]])
    second = points @ rotation.T + translation
    return points / np.linalg.norm(points, axis=1, keepdims=True), second / np.linalg.norm(second, axis=1, keepdims=True), rotation, translation


class ReconstructionGeometry(unittest.TestCase):
    def test_visual_bearings_are_reciprocal_without_map_coordinates(self):
        forward, reverse = core.visual_pair_bearings({"direction": np.array([1., 0., -1.])}, math.radians(340))
        self.assertAlmostEqual(forward, 25)
        self.assertAlmostEqual(reverse, 205)

    def test_panorama_rays_follow_viewer_convention(self):
        rays = core.pixel_bearings(np.array([[100, 50], [150, 50], [0, 50], [100, 0]]), 200, 100)
        np.testing.assert_allclose(rays, [[0, 0, -1], [1, 0, 0], [0, 0, 1], [0, 1, 0]], atol=1e-12)

    def test_spherical_pose_works_behind_camera(self):
        first, second, expected_rotation, expected_translation = observations()
        self.assertTrue(np.any(first[:, 2] < 0) and np.any(first[:, 2] > 0))
        matrix = core.essential_from_bearings(first, second)
        rotation, translation, mask, _ = core.recover_spherical_pose(matrix, first, second)
        np.testing.assert_allclose(rotation, expected_rotation, atol=1e-8)
        np.testing.assert_allclose(translation, expected_translation / np.linalg.norm(expected_translation), atol=1e-8)
        self.assertEqual(int(mask.sum()), len(first))

    def test_ransac_rejects_incorrect_feature_matches(self):
        first, second, rotation, _ = observations(180)
        rng = np.random.default_rng(34)
        second[:50] = second[rng.permutation(50)]
        matrix, mask = core.robust_essential(first, second, np.random.default_rng(35))
        self.assertIsNotNone(matrix)
        self.assertGreater(int(mask[50:].sum()), 120)
        self.assertLess(int(mask[:50].sum()), 8)
        recovered, _, _, _ = core.recover_spherical_pose(matrix, first[mask], second[mask])
        np.testing.assert_allclose(recovered, rotation, atol=.015)

    def test_unrelated_rays_are_not_supported(self):
        rng = np.random.default_rng(77)
        first = rng.normal(size=(150, 3)); first /= np.linalg.norm(first, axis=1, keepdims=True)
        second = rng.normal(size=(150, 3)); second /= np.linalg.norm(second, axis=1, keepdims=True)
        _, mask = core.robust_essential(first, second, np.random.default_rng(72))
        self.assertLess(int(mask.sum()), 25)

    def test_collapsing_refinement_retains_consistent_matrix_and_mask(self):
        first, second, _, _ = observations(80)
        supported = core.essential_from_bearings(first, second)
        collapsed = np.eye(3)
        threshold = .0035
        self.assertLess(int((core.epipolar_error(collapsed, first, second) < threshold).sum()), 16)
        with patch.object(core, "essential_from_bearings", side_effect=[supported, collapsed]):
            matrix, mask = core.robust_essential(first, second, np.random.default_rng(5), max_trials=1)
        np.testing.assert_array_equal(matrix, supported)
        np.testing.assert_array_equal(mask, core.epipolar_error(matrix, first, second) < threshold)
        self.assertEqual(int(mask.sum()), len(first))

    def test_singular_refinement_keeps_last_supported_solution(self):
        first, second, _, _ = observations(80)
        supported = core.essential_from_bearings(first, second)
        with patch.object(core, "essential_from_bearings", side_effect=[supported, np.linalg.LinAlgError("degenerate refit")]):
            matrix, mask = core.robust_essential(first, second, np.random.default_rng(5), max_trials=1)
        np.testing.assert_array_equal(matrix, supported)
        np.testing.assert_array_equal(mask, core.epipolar_error(matrix, first, second) < .0035)

    def test_components_do_not_invent_missing_connections(self):
        self.assertEqual(core.connected_components(5, [{"i": 0, "j": 2}, {"i": 1, "j": 3}]), [[0, 2], [1, 3], [4]])

    def test_duplicate_panorama_does_not_create_fake_camera_translation(self):
        rng = np.random.default_rng(932)
        rays = rng.normal(size=(120, 3)); rays /= np.linalg.norm(rays, axis=1, keepdims=True)
        descriptors = rng.uniform(size=(120, 128)).astype(np.float32)
        features = {"bearings": rays, "descriptors": descriptors}
        pair, _ = core.match_pair(features, features, np.random.default_rng(26))
        self.assertIsNone(pair)

    def test_rotation_in_place_is_not_a_walkable_baseline(self):
        rng = np.random.default_rng(144)
        rays = rng.normal(size=(120, 3)); rays /= np.linalg.norm(rays, axis=1, keepdims=True)
        descriptors = rng.uniform(size=(120, 128)).astype(np.float32)
        yaw = .62
        rotation = np.array([[np.cos(yaw), 0, np.sin(yaw)], [0, 1, 0], [-np.sin(yaw), 0, np.cos(yaw)]])
        pair, _ = core.match_pair({"bearings": rays, "descriptors": descriptors},
                                  {"bearings": rays @ rotation.T, "descriptors": descriptors}, np.random.default_rng(66))
        self.assertIsNone(pair)

    def test_pose_graph_recovers_baseline_ratios_without_ground_truth_inputs(self):
        positions = np.array([[0., 0.], [1., 0.], [1.2, -1.], [-.1, -1.6]])
        yaws = np.array([0., .2, -.4, .8])
        pairs = []
        for i in range(4):
            for j in range(i + 1, 4):
                direction = positions[j] - positions[i]
                local = core.rotate_horizontal(np.array([direction[0], 0., direction[1]]), -yaws[i])
                local /= np.linalg.norm(local)
                pairs.append({"i": i, "j": j, "confidence": .9, "inliers": 100,
                              "yaw": yaws[j] - yaws[i], "direction": np.array([local[0], 0., local[1]]), "_points": np.zeros((0, 3))})
        predicted, rotations, rigid, error, accepted, _ = core.solve_component([0, 1, 2, 3], pairs)
        self.assertTrue(rigid)
        self.assertLess(error, .01)
        self.assertEqual(len(accepted), 6)
        np.testing.assert_allclose(predicted, positions, atol=.002)
        np.testing.assert_allclose(rotations, yaws, atol=.002)

    def test_chain_is_labelled_topology_not_reconstructed_dimensions(self):
        pairs = [{"i": i, "j": i + 1, "confidence": .9, "inliers": 100, "yaw": 0.,
                  "direction": np.array([1., 0., -.1 * i]), "_points": np.zeros((0, 3))} for i in range(3)]
        _, _, rigid, _, _, _ = core.solve_component([0, 1, 2, 3], pairs)
        self.assertFalse(rigid)

    def test_shared_tracks_recover_baseline_ratios(self):
        tracks = np.arange(30)
        scene_depths = [np.linspace(5 + i, 15 + i, 30) for i in range(4)]
        lengths = [2., 1., 3.]
        pairs = [{"i": i, "j": i + 1, "_indices1": tracks, "_indices2": tracks,
                  "_depths1": scene_depths[i] / lengths[i], "_depths2": scene_depths[i + 1] / lengths[i]} for i in range(3)]
        scales = core.baseline_scales(pairs)
        np.testing.assert_allclose([scales[i] for i in range(3)], [1., .5, 1.5], atol=.001)

    def test_inconsistent_depth_tracks_do_not_impose_scale(self):
        tracks = np.arange(30)
        pairs = [{"i": 0, "j": 1, "_indices2": tracks, "_depths2": np.ones(30) * 5},
                 {"i": 1, "j": 2, "_indices1": tracks, "_depths1": np.linspace(.5, 25, 30)}]
        scales = core.baseline_scales(pairs)
        self.assertEqual(scales, {0: 1.})

    def test_observed_floor_anchors_fix_camera_height_gauge_across_tracks(self):
        tracks = np.arange(30)
        scene_depths = [np.linspace(5 + i, 15 + i, 30) for i in range(4)]
        lengths = [2., 1., 3.]
        pairs = [{"i": i, "j": i + 1, "_indices1": tracks, "_indices2": tracks,
                  "_depths1": scene_depths[i] / lengths[i], "_depths2": scene_depths[i + 1] / lengths[i]} for i in range(3)]
        pairs[1]["_floorBaseline"] = {"baseline": 1., "confidence": .9}
        scales = core.baseline_scales(pairs)
        np.testing.assert_allclose([scales[i] for i in range(3)], lengths, atol=.001)

    def test_floor_supported_chain_recovers_lengths_instead_of_unit_diagram(self):
        expected = np.array([[0., 0.], [.6, 0.], [.6, -1.4], [1.7, -1.4]])
        pairs = []
        for i in range(3):
            direction = expected[i + 1] - expected[i]
            length = np.linalg.norm(direction)
            pairs.append({"i": i, "j": i + 1, "confidence": .9, "inliers": 100, "yaw": 0.,
                          "direction": np.array([direction[0] / length, 0., direction[1] / length]), "_points": np.zeros((0, 3)),
                          "_floorBaseline": {"baseline": length, "confidence": .9}})
        predicted, _, rigid, error, valid, _ = core.solve_component([0, 1, 2, 3], pairs)
        self.assertTrue(rigid)
        self.assertEqual(len(valid), 3)
        self.assertLess(error, .01)
        np.testing.assert_allclose(predicted, expected, atol=.002)

    def test_unanchored_track_group_retains_ratios_without_claiming_absolute_scale(self):
        tracks = np.arange(30)
        for anchor in (None, .6, 3.2):
            for vertical in (0., .3):
                with self.subTest(anchor=anchor, vertical=vertical):
                    horizontal = math.sqrt(1 - vertical ** 2)
                    pairs = [
                        {"i": 0, "j": 1, "confidence": .99, "inliers": 200, "yaw": 0.,
                         "direction": np.array([1., 0., 0.]), "_points": np.zeros((0, 3))},
                        {"i": 1, "j": 2, "confidence": .9, "inliers": 100, "yaw": 0.,
                         "direction": np.array([horizontal, vertical, 0.]), "_points": np.zeros((0, 3)),
                         "_indices2": tracks, "_depths2": np.linspace(4., 8., 30)},
                        {"i": 2, "j": 3, "confidence": .9, "inliers": 90, "yaw": 0.,
                         "direction": np.array([0., 0., -1.]), "_points": np.zeros((0, 3)),
                         "_indices1": tracks, "_depths1": np.linspace(2., 4., 30)},
                    ]
                    if anchor is not None:
                        pairs[0]["_floorBaseline"] = {"baseline": anchor, "confidence": .95}
                    # The separate ratio group cannot inherit the unrelated anchor.
                    self.assertEqual(set(core.baseline_scales(pairs)), {0})
                    constraints = core.baseline_ratio_constraints(pairs)
                    self.assertEqual(len(constraints), 1)
                    self.assertAlmostEqual(math.exp(constraints[0][2]), 2.)
                    for ordered in (pairs, list(reversed(pairs))):
                        positions, _, rigid, error, accepted, _ = core.solve_component([0, 1, 2, 3], ordered)
                        self.assertFalse(rigid, "the unanchored group's absolute length is still unknown")
                        self.assertEqual(len(accepted), 3)
                        self.assertLess(error, .01)
                        lengths = np.linalg.norm(np.diff(positions, axis=0), axis=1)
                        self.assertAlmostEqual(lengths[0], anchor if anchor is not None else 1., places=5)
                        self.assertAlmostEqual(lengths[2] / lengths[1], 2. / horizontal, places=5)

    def test_relative_ratio_group_rejects_noisy_depth_ratio(self):
        tracks = np.arange(30)
        pairs = [{"i": 0, "j": 1, "_indices2": tracks, "_depths2": np.ones(30) * 5},
                 {"i": 1, "j": 2, "_indices1": tracks, "_depths1": np.linspace(.5, 25, 30)}]
        self.assertEqual(core.baseline_ratio_constraints(pairs), [])
    def test_vertical_surface_detector_excludes_floor_plane(self):
        rng = np.random.default_rng(52)
        floor = np.column_stack((rng.uniform(-3, 3, 180), np.zeros(180), rng.uniform(-3, 3, 180)))
        self.assertEqual(core.vertical_surfaces(floor, np.random.default_rng(10)), [])
        wall = np.column_stack((rng.uniform(-2, 2, 160), rng.uniform(-1, 2, 160), rng.normal(2, .01, 160)))
        surfaces = core.vertical_surfaces(np.concatenate((floor, wall)), np.random.default_rng(10))
        self.assertGreaterEqual(len(surfaces), 1)
        self.assertTrue(all(surface["classification"] == "unverified" for surface in surfaces))
        strongest = max(surfaces, key=lambda surface: surface["supportPoints"])
        self.assertAlmostEqual(strongest["a"]["z"], 2, delta=.1)
        self.assertAlmostEqual(strongest["b"]["z"], 2, delta=.1)

    def test_tilted_baseline_projects_camera_distance_without_contracting_cloud(self):
        # Independent full-3D baselines: one unit without an anchor, two camera
        # heights with a floor anchor. The graph reports only their XZ projection.
        for vertical in (0., .3):
            for full_length, anchored in ((1., False), (2., True)):
                with self.subTest(vertical=vertical, anchored=anchored):
                    horizontal = math.sqrt(1 - vertical ** 2)
                    point = np.array([[2., 1., -3.]])
                    pair = {"i": 0, "j": 1, "confidence": .9, "inliers": 100,
                            "yaw": 0., "direction": np.array([horizontal, vertical, 0.]),
                            "_points": point}
                    if anchored:
                        pair["_floorBaseline"] = {"baseline": full_length, "confidence": .9}
                    positions, _, rigid, error, valid, cloud = core.solve_component([0, 1], [pair])
                    self.assertTrue(rigid)
                    self.assertEqual(len(valid), 1)
                    self.assertLess(error, .01)
                    np.testing.assert_allclose(positions, [[0., 0.], [full_length * horizontal, 0.]], atol=1e-6)
                    np.testing.assert_allclose(cloud, point * full_length, atol=1e-6)

    def test_floor_anchored_chain_projects_each_baseline_independently(self):
        baselines = [np.array([1.2, .3, 0.]), np.array([0., -.4, -1.8])]
        pairs = []
        for i, baseline in enumerate(baselines):
            full_length = np.linalg.norm(baseline)
            pairs.append({"i": i, "j": i + 1, "confidence": .9, "inliers": 100,
                          "yaw": 0., "direction": baseline / full_length,
                          "_points": np.zeros((0, 3)),
                          "_floorBaseline": {"baseline": full_length, "confidence": .9}})
        positions, _, rigid, _, accepted, _ = core.solve_component([0, 1, 2], pairs)
        self.assertTrue(rigid)
        self.assertEqual(len(accepted), 2)
        np.testing.assert_allclose(positions, [[0., 0.], [1.2, 0.], [1.2, -1.8]], atol=1e-6)


if __name__ == "__main__":
    unittest.main()

