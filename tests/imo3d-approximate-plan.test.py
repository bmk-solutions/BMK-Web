import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('plan',Path(__file__).resolve().parents[1]/'scripts/imo3d-approximate-plan.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(jagged=True,two=False):
 rooms=[];scenes=[]
 for i in range(2 if two else 1):
  sid=str(i);offset=i*6
  local=[[-2,-2],[0,-2.01],[2,-2],[2,2],[-2,2]] if jagged else [[-2,-2],[2,-2],[2,2],[-2,2]]
  rectangle=[{'x':x,'z':z} for x,z in [[-2,-2],[2,-2],[2,2],[-2,2]]]
  rooms.append({'id':'r'+sid,'sceneIds':[sid],'representativeSceneId':sid,'component':'c','floor':0,'outline':[{'x':x+offset,'z':z} for x,z in local],'openings':[{'edgeIndex':1,'kind':'door'}],'doorwayCandidates':[{'edge':1}]})
  scenes.append({'id':sid,'position':{'x':offset,'z':0},'yaw':0,'roomEnvelope':{'outline':rectangle,'evidence':{'regularized':True}}})
 return {'scenes':scenes,'roomLayout':{'rooms':rooms},'components':[]}
class ApproximatePlan(unittest.TestCase):
 def test_changed_contour_does_not_keep_stale_opening_edge_indices(self):
  result=m.build(fixture());room=result['rooms'][0]
  self.assertEqual(len(room['outline']),4)
  self.assertEqual(room['openings'],[]);self.assertEqual(room['doorwayCandidates'],[])
  self.assertEqual(room['openingReview']['status'],'pending')
 def test_unchanged_outline_preserves_openings(self):
  data=fixture(False);room=m.build(data)['rooms'][0]
  self.assertEqual(room['openings'],data['roomLayout']['rooms'][0]['openings'])
  self.assertNotIn('openingReview',room)
 def test_combined_neighbor_overlap_reverts_a_proposal(self):
  data=fixture(two=True)
  # Each proposal vs an original is harmless; combining both is not.
  with patch.object(m,'overlap',side_effect=lambda a,b:1. if len(a)==4 and len(b)==4 else 0.):
   result=m.build(data)
  self.assertEqual(sorted(len(r['outline']) for r in result['rooms']),[4,5])
  restored=next(r for r in result['rooms'] if len(r['outline'])==5)
  self.assertEqual(restored['candidateEvidence']['rejectedProposalReason'],'combined_neighbor_overlap')
  self.assertEqual(restored['openings'],[{'edgeIndex':1,'kind':'door'}])
if __name__=='__main__':unittest.main()
