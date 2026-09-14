import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("architecture",Path(__file__).resolve().parents[1]/"scripts/imo3d-depth-architecture.py")
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core);np=core.np

def scenes():return [{"id":"a","position":{"x":-.3,"y":0,"z":0},"floor":0},{"id":"b","position":{"x":.3,"y":0,"z":0},"floor":0}]
def wall(a,b,index="w"):
    return {"id":index,"normal":{"x":0.,"z":1.},"offset":-2.,"segments":[{"a":{"x":a[0],"z":a[1]},"b":{"x":b[0],"z":b[1]}}]}

class ArchitectureEvidence(unittest.TestCase):
    def test_repeated_crop_ids_do_not_count_as_multiple_cameras(self):
        samples=[{"x":0,"y":0,"z":-2,"confidence":.9,"sceneIds":["a","a","a"]}]
        points,_,_,rejected,_=core.prepare_samples(samples,scenes());self.assertEqual(len(points),0);self.assertEqual(rejected,1)

    def test_raw_network_confidence_cannot_be_mistaken_for_normalized_support(self):
        samples=[{"x":0,"y":0,"z":-2,"confidence":8.25,"sceneIds":["a","b"]}]
        self.assertEqual(len(core.prepare_samples(samples,scenes())[0]),0)

    def test_missing_wall_does_not_become_convex_closure(self):
        walls=[wall((-2,-2),(2,-2),"south"),wall((2,-2),(2,2),"east"),wall((2,2),(-2,2),"north")]
        self.assertEqual(core.observed_room_cycles(walls),[])
        walls.append(wall((-2,2),(-2,-2),"west"));result=core.observed_room_cycles(walls)
        self.assertEqual(len(result),1);self.assertAlmostEqual(result[0]["areaCameraHeightSquared"],16)

    def test_unsupported_corner_extensions_and_uninhabited_boxes_are_not_rooms(self):
        walls=[wall((-2,-2),(1.5,-2),"south"),wall((2,-2),(2,2),"east"),wall((2,2),(-2,2),"north"),wall((-2,2),(-2,-2),"west")]
        self.assertEqual(core.observed_room_cycles(walls),[])
        walls[0]=wall((-2,-2),(2,-2),"south")
        self.assertEqual(core.observed_room_cycles(walls,camera_centers=[np.array([4,4])]),[])

    def test_no_points_in_wall_gap_is_not_a_doorway(self):
        candidate=wall((-2,-2),(-.4,-2));candidate["segments"]+=wall((.4,-2),(2,-2))["segments"]
        points=np.array([[x,y,-1] for x in np.linspace(-.5,.5,12) for y in np.linspace(-.8,.2,12)])
        self.assertEqual(core.infer_openings([candidate],points,[{"a","b"} for _ in points],scenes(),-1),[])

    def test_door_void_requires_rays_from_two_cameras_and_height_coverage(self):
        candidate=wall((-2,-2),(-.4,-2));candidate["segments"]+=wall((.4,-2),(2,-2))["segments"]
        points=np.array([[x,y,-3] for x in np.linspace(-.4,.4,12) for y in np.linspace(-.8,.2,12)])
        output=core.infer_openings([candidate],points,[{"a","b"} for _ in points],scenes(),-1)
        self.assertEqual(len(output),1);self.assertFalse(output[0]["verified"]);self.assertEqual(output[0]["widthInterpretation"],"visible_span_lower_bound")
        self.assertEqual(core.infer_openings([candidate],points,[{"a"} for _ in points],scenes(),-1),[])

    def test_upper_window_rays_and_closed_door_returns_do_not_create_walkthrough_apertures(self):
        candidate=wall((-2,-2),(-.4,-2));candidate['segments']+=wall((.4,-2),(2,-2))['segments']
        upper=np.array([[x,y,-3] for x in np.linspace(-.4,.4,12) for y in np.linspace(.4,1.2,12)])
        closed=np.array([[x,y,-2] for x in np.linspace(-.4,.4,12) for y in np.linspace(-.8,.8,12)])
        for points in [upper,closed]:self.assertEqual(core.infer_openings([candidate],points,[{'a','b'} for _ in points],scenes(),-1),[])

    def test_floor_and_low_furniture_do_not_become_vertical_room_walls(self):
        points=np.array([[x,y,-2] for x in np.arange(-2,2,.045) for y in np.arange(-.95,-.35,.045)])
        normal=np.tile([0.,0.,1.],(len(points),1));planar=np.ones(len(points),bool)
        result=core.fit_wall_planes(points,[{"a","b"} for _ in points],np.ones(len(points))*.9,normal,planar,-1)
        self.assertEqual(result,[])

    def test_observed_tall_multicamera_surface_has_supported_extent(self):
        points=np.array([[x,y,-2] for x in np.arange(-2,2,.045) for y in np.arange(-.95,.8,.045)])
        normal=np.tile([0.,0.,1.],(len(points),1));planar=np.ones(len(points),bool)
        result=core.fit_wall_planes(points,[{"a","b"} for _ in points],np.ones(len(points))*.9,normal,planar,-1)
        self.assertEqual(len(result),1);self.assertAlmostEqual(abs(result[0]["offset"]),2);self.assertEqual(result[0]["supportCameras"],["a","b"])

    def test_independent_floors_or_components_are_not_merged(self):
        mixed=scenes();mixed[1]["floor"]=1
        with self.assertRaises(ValueError):core.reconstruct_architecture({"scenes":mixed,"pointSamples":[]})
        mixed=scenes();mixed[0]["componentId"]="one";mixed[1]["componentId"]="two"
        with self.assertRaises(ValueError):core.reconstruct_architecture({"scenes":mixed,"pointSamples":[]})

    def test_bounded_refinement_keeps_identity_apertures_and_unsupported_lines(self):
        room={'id':'room','outline':[{'x':-2,'z':-2},{'x':2,'z':-2},{'x':2,'z':2},{'x':-2,'z':2}],'openings':[0],'doorwayCandidates':[{'edge':1,'offset':.4,'width':.1}]}
        west=wall((-2.1,-2),(-2.1,2),'west');west.update(normal={'x':1.,'z':0.},offset=-2.1,residual=.01,supportPoints=800,supportCameras=['a','b'])
        south=wall((-2,-2.08),(2,-2.08),'south');south.update(residual=.01,offset=-2.08,supportPoints=700,supportCameras=['a','b'])
        proposals,rejected=core.refine_room_outlines([room],[west,south],scenes())
        self.assertEqual(rejected,[]);self.assertEqual(len(proposals),1);result=proposals[0]
        self.assertEqual(result['id'],room['id']);self.assertEqual(len(result['outline']),4);self.assertEqual(result['openings'],room['openings']);self.assertEqual(result['doorwayCandidates'],room['doorwayCandidates'])
        self.assertLess(result['refinement']['maxCornerShift'],.2);self.assertEqual(result['refinement']['unchangedEdgeLines'],[1,2])
        self.assertEqual(result['outline'][1]['x'],2);self.assertEqual(result['outline'][2],{'x':2.,'z':2.});self.assertEqual(result['outline'][3]['z'],2)

    def test_refinement_never_changes_authored_rooms_or_accepts_large_motion(self):
        room={'id':'room','authored':True,'outline':[{'x':-2,'z':-2},{'x':2,'z':-2},{'x':2,'z':2},{'x':-2,'z':2}]}
        self.assertEqual(core.refine_room_outlines([room],[],scenes())[1][0]['reason'],'authored_state_preserved')
        changed=wall((-2,-2.5),(2,-2.5),'south');changed.update(residual=.01,offset=-2.5,supportPoints=700,supportCameras=['a','b'])
        room['authored']=False;self.assertEqual(core.refine_room_outlines([room],[changed],scenes())[0],[])

if __name__=="__main__":unittest.main()
