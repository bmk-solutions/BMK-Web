import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measurementLabelAnchor as anchor} from '../src/lib/imo3d/measurement-projection';
const point=(x:number,y:number)=>({x,y,inFront:true});
test('wall height remains selectable with upper endpoint offscreen',()=>{
 assert.deepEqual(anchor(point(200,-300),point(200,400),800,600),{x:200,y:200});
});
test('long wall spanning both screen edges remains selectable',()=>{
 assert.deepEqual(anchor(point(-100,200),point(900,200),800,600),{x:400,y:200});
});
test('offscreen or behind camera measurements do not create misleading labels',()=>{
 assert.equal(anchor(point(-100,200),point(-50,400),800,600),null);
 assert.equal(anchor({...point(200,200),inFront:false},point(400,400),800,600),null);
});
test('edge label stays inside viewport on mobile',()=>{
 assert.deepEqual(anchor(point(1,1),point(1,20),320,600),{x:64,y:28});
});

import {layoutMeasurementLabels} from '../src/lib/imo3d/measurement-projection';
test('overlapping measurement values remain separately selectable',()=>{
 const result=layoutMeasurementLabels([{a:point(200,100),b:point(200,300)},{a:point(210,100),b:point(210,300)}],800,600);
 assert.equal(result.length,2);
 assert.ok(Math.abs(result[0].position.y-result[1].position.y)>=46);
 assert.deepEqual(result[0].anchor,{x:200,y:200});
});
