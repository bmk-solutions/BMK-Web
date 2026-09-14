import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestRasterScene} from '../src/components/imo3d/raster-navigation';
import type {RasterNavigation} from '../src/lib/imo3d/ai-plan-jobs';
const map:RasterNavigation={width:1000,height:2000,source:'reviewed-photo-registration',points:[{sceneId:'a',x:.1,y:.3},{sceneId:'b',x:.3,y:.1},{sceneId:'c',x:.8,y:.9}]};
test('map distance uses rendered aspect ratio, not distorted normalized distance',()=>{assert.equal(nearestRasterScene(map,.1,.1,new Set(['a','b'])),'b');});
test('empty image margins still select closest capture without a distance cutoff',()=>{assert.equal(nearestRasterScene(map,1.5,1.5,new Set(['a','b','c'])),'c');});
test('map filters deleted captures and captures belonging to another floor',()=>{assert.equal(nearestRasterScene(map,.8,.9,new Set(['a'])),'a');assert.equal(nearestRasterScene(map,.8,.9,new Set()),null);});
test('invalid coordinates are a silent no-op and current capture can remain nearest',()=>{assert.equal(nearestRasterScene(map,NaN,0,new Set(['a'])),null);assert.equal(nearestRasterScene(map,.1,.3,new Set(['a','b'])),'a');});
