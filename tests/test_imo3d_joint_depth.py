import importlib.util
from pathlib import Path
import unittest
import copy
import json

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('joint_depth',ROOT/'scripts/imo3d-joint-depth.py')
joint=importlib.util.module_from_spec(spec);spec.loader.exec_module(joint)
np=joint.np


def scene(sid,x,component='main'):
    return {'id':sid,'position':{'x':x,'y':0,'z':0},'yaw':0,'componentId':component}


def flat_view(sid,x,color=100,depth=3):
    rotation=joint.basis(0,0);center=np.array([x,0,0],np.float32)
    return {'id':sid,'scene':scene(sid,x),'center':center,'rotation':rotation,'image':np.full((joint.SIZE,joint.SIZE,3),color,np.uint8),'depth':np.full((joint.SIZE,joint.SIZE),depth,np.float32),'confidence':np.full((joint.SIZE,joint.SIZE),5,np.float32)}


class JointDepthTests(unittest.TestCase):
    def test_never_groups_disconnected_or_different_components(self):
        scenes=[scene('a',0),scene('b',1),scene('c',2),scene('d',.3,'other')]
        groups=joint.select_groups(scenes,[{'from':'a','to':'b'},{'from':'a','to':'d'}])
        self.assertEqual([{s['id'] for s in group} for group in groups],[{'a','b'}])

    def test_rejects_zero_baseline_and_distant_link(self):
        scenes=[scene('a',0),scene('b',0),scene('c',7)]
        self.assertEqual(joint.select_groups(scenes,[{'from':'a','to':'b'},{'from':'a','to':'c'}]),[])

    def test_same_component_different_floor_is_not_a_joint_group(self):
        a,b=scene('a',0),scene('b',1)
        a['floor']=0;b['floor']=1
        self.assertEqual(joint.select_groups([a,b],[{'from':'a','to':'b'}]),[])

    def test_same_voxel_on_independent_floors_or_components_is_preserved(self):
        points=[{'x':1,'y':0,'z':1,'confidence':.8,'sceneIds':['a','b']},{'x':1,'y':0,'z':1,'confidence':.9,'sceneIds':['c','d']}]
        for domains in [{'a':('one',0),'b':('one',0),'c':('one',1),'d':('one',1)},{'a':('one',0),'b':('one',0),'c':('two',0),'d':('two',0)}]:
            self.assertEqual(len(joint.cap_points(points,scene_domains=domains)),2)
        same={key:('one',0) for key in ['a','b','c','d']}
        self.assertEqual(len(joint.cap_points(points,scene_domains=same)),1)

    def test_mixed_floor_point_evidence_is_rejected(self):
        point={'x':1,'y':0,'z':1,'confidence':.8,'sceneIds':['a','b']}
        self.assertEqual(joint.cap_points([point],scene_domains={'a':('one',0),'b':('one',1)}),[])

    def test_perspective_and_panorama_conventions(self):
        center=np.array([0,0,1],np.float32)
        for heading in [0,90,180,270]:
            rotation=joint.basis(heading,0)
            self.assertAlmostEqual(float(np.linalg.det(rotation)),1,places=5)
            ray=center@rotation.T
            u,v=joint.pano_coordinates(ray)
            self.assertAlmostEqual(float(u%1),float((heading/360+.5)%1),places=5)
            self.assertAlmostEqual(float(v),.5,places=5)
            np.testing.assert_allclose(ray@rotation,center,atol=1e-6)

    def test_alignment_recovers_known_scale(self):
        ext=np.repeat(np.eye(4)[None],3,axis=0);ext[:,:3,3]=[[0,0,0],[-1,0,0],[0,0,-1]]
        predicted=ext.copy();predicted[:,:3,3]*=2.5
        scale,error=joint.align_scale(ext,predicted[:,:3])
        self.assertAlmostEqual(scale,2.5,places=5);self.assertLess(error,1e-6)

    def test_same_camera_crops_are_not_independent_evidence(self):
        results=joint.validate_surfaces([flat_view('a',0),flat_view('a',0)])
        self.assertEqual(sum(int(item['valid'].sum()) for item in results),0)

    def test_matching_plane_requires_two_physical_views(self):
        results=joint.validate_surfaces([flat_view('a',0),flat_view('b',.5)])
        self.assertGreater(sum(int(item['valid'].sum()) for item in results),30000)
        _,points=joint.pack_surfaces(results,{})
        self.assertGreater(len(points),1000)
        self.assertTrue(all(set(p['sceneIds'])=={'a','b'} for p in points))
        self.assertTrue(all(abs(p['z']+3)<.0001 for p in points))

    def test_photometric_or_depth_disagreement_is_rejected(self):
        for second in [flat_view('b',.5,color=250),flat_view('b',.5,depth=5)]:
            results=joint.validate_surfaces([flat_view('a',0),second])
            self.assertEqual(sum(int(item['valid'].sum()) for item in results),0)

    def test_floor_samples_are_json_serializable_and_supported(self):
        views=[flat_view('a',0,depth=1),flat_view('b',.2,depth=1)]
        for view in views:view['rotation']=joint.basis(0,-90)
        profiles={sid:{'floorBoundaryRadians':[.1]*64} for sid in ['a','b']}
        buckets,points=joint.pack_surfaces(joint.validate_surfaces(views),profiles)
        self.assertTrue(any(point['floorConfidence']>.6 for point in points))
        self.assertGreater(len(json.dumps(points)),100)
        self.assertTrue(all(abs(p['y']+1)<.0001 for p in points))

    def test_conflicting_surface_estimates_leave_hole(self):
        bucket={'weights':np.ones(joint.WIDTH*joint.HEIGHT)*2,'sums':np.ones(joint.WIDTH*joint.HEIGHT)*6,'squares':np.ones(joint.WIDTH*joint.HEIGHT)*20}
        result=joint.finish_depth(bucket)
        self.assertEqual(result['coverage'],0);self.assertTrue(all(x==0 for x in result['values']))
        self.assertEqual(result['purpose'],'display_only')

    def test_cache_requires_model_inputs_and_valid_evidence(self):
        bucket={'weights':np.ones(joint.WIDTH*joint.HEIGHT),'sums':np.ones(joint.WIDTH*joint.HEIGHT)*3,'squares':np.ones(joint.WIDTH*joint.HEIGHT)*9}
        value={'version':joint.VERSION,'cacheKey':'key','depths':{'a':joint.finish_depth(bucket),'b':joint.finish_depth(bucket)},'pointSamples':[{'x':1,'y':0,'z':-3,'r':100,'g':100,'b':100,'confidence':.8,'sceneIds':['a','b'],'floorConfidence':0,'normal':{'x':0,'y':0,'z':1}}]}
        self.assertTrue(joint.valid_cached_group(value,'key',{'a','b'}))
        self.assertFalse(joint.valid_cached_group(value,'changed',{'a','b'}))
        modified=copy.deepcopy(value);modified['pointSamples'][0]['sceneIds']=['a','a']
        self.assertFalse(joint.valid_cached_group(modified,'key',{'a','b'}))
        modified=copy.deepcopy(value);modified['pointSamples'][0]['normal']['x']=float('nan')
        self.assertFalse(joint.valid_cached_group(modified,'key',{'a','b'}))
        for field,bad in [('pointSamples',[3]),('depths',{'a':None,'b':None})]:
            modified=copy.deepcopy(value);modified[field]=bad
            self.assertFalse(joint.valid_cached_group(modified,'key',{'a','b'}))
        modified=copy.deepcopy(value);modified['pointSamples'][0]['sceneIds']=[{},{}]
        self.assertFalse(joint.valid_cached_group(modified,'key',{'a','b'}))

    def test_cache_key_changes_with_pose_image_or_profile(self):
        group=[scene('a',0),scene('b',1)];hashes={'a':'aaa','b':'bbb'}
        original=joint.cache_key(group,hashes,{})
        hashes['b']='changed';self.assertNotEqual(original,joint.cache_key(group,hashes,{}))
        hashes['b']='bbb';group[0]['yaw']=15;self.assertNotEqual(original,joint.cache_key(group,hashes,{}))
        group[0]['yaw']=0;self.assertNotEqual(original,joint.cache_key(group,hashes,{'a':{'floorBoundaryRadians':[.5]*32}}))
        group[0]['floor']=1;self.assertNotEqual(original,joint.cache_key(group,hashes,{}))


if __name__=='__main__':unittest.main()
