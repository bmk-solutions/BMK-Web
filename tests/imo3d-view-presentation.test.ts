import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEntryView,constrainedView,sceneEntryView} from '../src/lib/imo3d/view-presentation';
import {roomChoices} from '../src/components/imo3d/room-labels';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import {createViewerPlanCache} from '../src/components/imo3d/viewer-plan-cache';

test('bottom of the full viewport stays above the tripod at every supported zoom',()=>{
 for(const fov of [10,40,60,74,95,150])for(const pitch of [-10,-1,0,1,10]){
  const view=constrainedView(pitch,fov);
  assert.ok(view.pitch*180/Math.PI-view.fov/2>=-65-1e-8);
  assert.ok(view.fov>=40&&view.fov<=95);
 }
});
test('room entry is image-relative and selects the authored photo without modifying pose or links',()=>{
 const original=syntheticTour(),view={yaw:45,pitch:0,fov:60};
 const scenes=applyEntryView(original,{sceneId:original.scenes[1].id,view});
 assert.equal(roomChoices(scenes,0)[0].scene.id,scenes[1].id);
 assert.deepEqual(scenes[1].position,original.scenes[1].position);assert.deepEqual(scenes[1].links,original.scenes[1].links);
 assert.equal(sceneEntryView({...scenes[1],yaw:90})?.yaw,135*Math.PI/180);
 const otherFloor={...scenes[1],id:'upstairs',floor:1};
 const changed=applyEntryView({...original,scenes:[...scenes,otherFloor]},{sceneId:scenes[0].id,view});
 assert.equal(changed[1].entryView,undefined);assert.deepEqual(changed.at(-1)?.entryView,view);
 assert.throws(()=>applyEntryView(original,{sceneId:'foreign',view}));
});
test('compact and expanded plans reuse one private image request and revoke it when viewer closes',async()=>{
 const originalFetch=globalThis.fetch,originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
 const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{value:{origin:'https://example.test'},configurable:true});
 let calls=0;const revoked:string[]=[];
 URL.createObjectURL=()=> 'blob:private-plan';URL.revokeObjectURL=url=>revoked.push(url);
 globalThis.fetch=async input=>{calls++;return String(input).includes('/image?')?new Response('image',{headers:{'content-type':'image/png'}}):Response.json({job:{id:'job-1',status:'draft',result:{floors:[{floor:0}]}},stale:false});};
 const cache=createViewerPlanCache(),key='/api/imo3d/tours/test/ai-plan?viewer=1&floor=0';
 try{
  const [compact,expanded]=await Promise.all([cache.get(key),cache.get(key)]);
  assert.equal(calls,2);assert.equal(compact,expanded);assert.equal(compact.src,'blob:private-plan');assert.equal(cache.peek(key),compact);
  await cache.get(key);assert.equal(calls,2);
  cache.dispose();assert.equal(cache.peek(key),undefined);assert.deepEqual(revoked,['blob:private-plan']);
  globalThis.fetch=async()=>new Response(null,{status:401});
  assert.deepEqual((await cache.get(key)).status,null);assert.equal(cache.peek(key)?.src,undefined);
 }finally{cache.dispose();globalThis.fetch=originalFetch;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else Reflect.deleteProperty(globalThis,'location');}
});
