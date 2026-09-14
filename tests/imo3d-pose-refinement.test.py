import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pose_refinement', Path(__file__).resolve().parents[1]/'scripts/imo3d-pose-refinement-evaluate.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
np = core.np


def walls(height):
    along, y = np.meshgrid(np.linspace(-1, 1, 35), np.linspace(height, height+.2, 12))
    first = np.column_stack([np.full(along.size, 2.), y.ravel(), along.ravel()])
    second = np.column_stack([along.ravel(), y.ravel(), np.full(along.size, 2.)])
    points = np.concatenate([first, second])
    normal = np.concatenate([np.tile([1., 0., 0.], (len(first), 1)), np.tile([0., 0., 1.], (len(second), 1))])
    return points, normal


class PoseRefinement(unittest.TestCase):
    def test_known_shift_improves_unseen_height_band_without_claiming_architecture(self):
        train, hold = walls(-.5), walls(.5)
        delta = np.array([.03, 0, -.02])
        result = core.evaluate_pair((train[0]+delta, train[1]), train, (hold[0]+delta, hold[1]), hold)
        self.assertEqual(result['status'], 'candidate_only')
        self.assertFalse(result['architecturalAcceptance'])
        self.assertLess(result['heldOutMedianAfter'], 1e-5)
        self.assertAlmostEqual(result['translation']['x'], -.03, places=4)
        self.assertAlmostEqual(result['translation']['z'], .02, places=4)

    def test_inconsistent_depth_bands_reject_training_improvement(self):
        train, hold = walls(-.5), walls(.5)
        shift = np.array([.04, 0, -.03])
        result = core.evaluate_pair((train[0]+shift, train[1]), train, (hold[0]-shift, hold[1]), hold)
        self.assertEqual(result['status'], 'rejected')
        self.assertGreater(result['heldOutMedianAfter'], result['heldOutMedianBefore'])

    def test_single_plane_cannot_determine_horizontal_pose(self):
        train, hold = walls(-.5), walls(.5)
        train = tuple(p[:420] for p in train)
        hold = tuple(p[:420] for p in hold)
        result = core.evaluate_pair((train[0]+[.03, 0, 0], train[1]), train, (hold[0]+[.03, 0, 0], hold[1]), hold)
        self.assertFalse(result['observable'])
        self.assertEqual(result['status'], 'rejected')

    def test_sparse_surfaces_are_not_filled(self):
        cloud = (np.zeros((5, 3)), np.ones((5, 3)))
        self.assertEqual(core.evaluate_pair(cloud, cloud, cloud, cloud)['status'], 'insufficient_surface_support')

    def test_rotation_preserves_height_and_pivot(self):
        p = np.array([[1., 2., 3.], [2., 2., 3.]])
        out = core.transform(p, [np.pi/2, 0, 0], p[0])
        np.testing.assert_allclose(out, [[1, 2, 3], [1, 2, 2]], atol=1e-10)


if __name__ == '__main__':
    unittest.main()
