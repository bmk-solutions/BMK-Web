import importlib.util, unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('bundle',Path(__file__).resolve().parents[1]/'scripts/imo3d-bundle-adjust.py')
bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)
class GeometryTests(unittest.TestCase):
 def test_three_views_recover_a_point_above_camera(self):
  origins=np.array([[0.,0,0],[1.,0,0],[0.,0,1.]])
  point=np.array([2.,2.,-4.]);rays=point-origins;rays/=np.linalg.norm(rays,axis=1)[:,None]
  np.testing.assert_allclose(bundle.triangulate(origins,rays),point,atol=1e-10)
 def test_parallel_rays_do_not_invent_depth(self):
  self.assertIsNone(bundle.triangulate(np.array([[0.,0,0],[1.,0,0]]),np.array([[0.,0,-1.],[0.,0,-1.]])))
 def test_backward_intersection_is_rejected(self):
  origins=np.array([[0.,0,0],[1.,0,0]])
  rays=np.array([[0.,0,1.],[1.,0,1.]]);rays/=np.linalg.norm(rays,axis=1)[:,None]
  self.assertIsNone(bundle.triangulate(origins,rays))
 def test_yaw_convention_matches_reconstruction(self):
  np.testing.assert_allclose(bundle.world_rays(np.array([[0.,0,-1.]]),np.array([np.pi/2])),[[1.,0,0]],atol=1e-10)
if __name__=='__main__':unittest.main()
