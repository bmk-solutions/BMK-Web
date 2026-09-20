import test from 'node:test';
import assert from 'node:assert/strict';
import {imagePlanRegistration,validatePlanRegistration} from '../src/lib/imo3d/plan-registration';
const registration={points:[{sceneId:'a',x:.2,y:.3},{sceneId:'b',x:.7,y:.6}],outline:[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}]};
test('each apartment registers its own images at the actual final image size',()=>{
 const first=imagePlanRegistration(registration,['a','b'],1200,1600);
 const second=imagePlanRegistration({...registration,points:[{sceneId:'new',x:.4,y:.4}]},['new'],800,900);
 assert.equal(first.width,1200);assert.equal(second.width,800);
 assert.deepEqual(second.points,[{sceneId:'new',x:.4,y:.4}]);
 assert.equal(first.points.length,2);
});
test('registration rejects foreign scenes, missing scenes, duplicate scenes and invalid coordinates',()=>{
 assert.throws(()=>validatePlanRegistration(registration,['a','other']),/COVERAGE/);
 assert.throws(()=>validatePlanRegistration(registration,['a','b','c']),/COVERAGE/);
 assert.throws(()=>validatePlanRegistration({...registration,points:[registration.points[0],registration.points[0]]},['a','b']),/COVERAGE/);
 assert.throws(()=>validatePlanRegistration({...registration,points:[{sceneId:'a',x:2,y:0}]},['a']));
 assert.throws(()=>imagePlanRegistration(registration,['a','b'],NaN,500));
 assert.throws(()=>validatePlanRegistration({...registration,outline:[{x:0,y:0},{x:.5,y:.5},{x:1,y:1}]},['a','b']),/OUTLINE/);
});
