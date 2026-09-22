import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPlanGeometryCurrent,planImageDigest,matchesPlanImageDigest} from '../src/lib/imo3d/plan-render-integrity';

const cameras=[{id:'a',image:'/a.jpg',floor:0,position:{x:1,y:1.27,z:2},yaw:0,manualLinks:[{targetId:'b',yaw:15}]},{id:'b',image:'/b.jpg',floor:0,position:{x:2,y:1.27,z:2},yaw:20}];
test('plan can finish after harmless camera ordering changes',()=>{
 assert.doesNotThrow(()=>assertPlanGeometryCurrent(cameras,[...cameras].reverse(),false));
});
test('spatial reprocessing, manual links and source changes invalidate an in-flight plan',()=>{
 for(const changed of [
  cameras.map(s=>({...s,yaw:s.yaw+1})),
  cameras.map(s=>({...s,position:{...s.position,x:s.position.x+1}})),
  cameras.map(s=>({...s,manualLinks:[]})),
  cameras.map(s=>({...s,image:s.image+'?replacement=1'})),
  cameras.map(s=>({...s,floor:1})),
 ])assert.throws(()=>assertPlanGeometryCurrent(cameras,changed,false),/STALE_GEOMETRY/);
 assert.throws(()=>assertPlanGeometryCurrent(cameras,cameras,true),/STALE_GEOMETRY/);
});
test('a replaced PNG cannot inherit the cached image audit',()=>{
 const png=Buffer.from('original rendered bytes'),digest=planImageDigest(png);
 assert.equal(matchesPlanImageDigest(Buffer.from(png),digest),true);
 assert.equal(matchesPlanImageDigest(Buffer.from('different rendered bytes'),digest),false);
 assert.equal(matchesPlanImageDigest(png,undefined),false);
 assert.equal(matchesPlanImageDigest(png,'not-a-sha'),false);
});
