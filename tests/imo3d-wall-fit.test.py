import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('fit',Path(__file__).resolve().parents[1]/'scripts/imo3d-wall-fit.py')
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
np=core.np
class WallFit(unittest.TestCase):
 def radii(self,polygon):
  angles=(np.arange(1024)/1024-.5)*2*np.pi
  return core._radii(np.asarray(polygon,dtype=float),angles)
 def test_trapezoid_preserves_oblique_wall(self):
  polygon=np.array([[-2.,-2.],[2.,-2.],[3.,2.],[-2.,2.]])
  result=core.fit(self.radii(polygon))
  self.assertIsNotNone(result)
  fitted,evidence=result
  self.assertEqual(len(fitted),4)
  self.assertLess(evidence['heldOutP95Degrees'],.05)
  for vertex in polygon:self.assertLess(np.min(np.linalg.norm(fitted-vertex,axis=1)),.03)
 def test_concavity_not_replaced_by_hull(self):
  polygon=np.array([[-3.,-2.],[3.,-2.],[3.,1.],[1.,1.],[1.,3.],[-3.,3.]])
  result=core.fit(self.radii(polygon));self.assertIsNotNone(result)
  self.assertEqual(len(result[0]),6)
  for vertex in polygon:self.assertLess(np.min(np.linalg.norm(result[0]-vertex,axis=1)),.04)
 def test_circle_does_not_get_invented_walls(self):
  self.assertIsNone(core.fit(np.ones(1024)*3))
 def test_invalid_input_rejected(self):
  for values in [[],np.ones(100),np.ones(1024)*-1,np.ones(1024)*np.nan]:self.assertIsNone(core.fit(values))
 def test_topology_rejects_crossing_edges(self):
  self.assertFalse(core._simple(np.array([[0.,0.],[2.,2.],[0.,2.],[2.,0.]])))
 def test_rotation_preserves_slanted_room(self):
  polygon=np.array([[-2.,-2.],[2.,-2.],[3.,2.],[-2.,2.]])
  angle=.49;rotation=np.array([[np.cos(angle),-np.sin(angle)],[np.sin(angle),np.cos(angle)]])
  polygon=polygon@rotation.T;result=core.fit(self.radii(polygon));self.assertIsNotNone(result)
  for vertex in polygon:self.assertLess(np.min(np.linalg.norm(result[0]-vertex,axis=1)),.03)
 def test_held_out_spikes_not_hidden_by_fitting(self):
  r=self.radii([[-2.,-2.],[2.,-2.],[3.,2.],[-2.,2.]])
  r[1::4]*=1.5
  self.assertIsNone(core.fit(r))
if __name__=='__main__':unittest.main()

