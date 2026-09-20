import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestRasterScene,rasterViewHeading} from '../src/components/imo3d/raster-navigation';
import type {Scene} from '../src/lib/imo3d/model';
import type {RasterNavigation} from '../src/lib/imo3d/ai-plan-jobs';
const map:RasterNavigation={width:1000,height:2000,source:'reviewed-photo-registration',points:[{sceneId:'a',x:.1,y:.3},{sceneId:'b',x:.3,y:.1},{sceneId:'c',x:.8,y:.9}]};
test('view heading follows registered orientation and refuses inconsistent anchors',()=>{
 const scene=(id:string,x:number,z:number,links:string[])=>({id,floor:0,position:{x,y:1.6,z},links} as Scene);
 const scenes=[scene('a',0,0,['b','c']),scene('b',0,-2,['a']),scene('c',2,0,['a'])];
 const registered:RasterNavigation={...map,width:1000,height:1000,points:[{sceneId:'a',x:.5,y:.5},{sceneId:'b',x:.7,y:.5},{sceneId:'c',x:.5,y:.7}]};
 assert.ok(Math.abs(rasterViewHeading(registered,scenes,'a',0)!-90)<1e-8);
 assert.ok(Math.abs(rasterViewHeading(registered,scenes,'a',Math.PI/2)!-180)<1e-8);
 assert.equal(rasterViewHeading({...registered,points:registered.points.slice(0,2)},scenes,'a',0),undefined);
 assert.equal(rasterViewHeading({...registered,points:[...registered.points.slice(0,2),{sceneId:'c',x:.5,y:.3}]},scenes,'a',0),undefined);
});
test('map distance uses rendered aspect ratio, not distorted normalized distance',()=>{assert.equal(nearestRasterScene(map,.1,.1,new Set(['a','b'])),'b');});
test('empty image margins still select closest capture without a distance cutoff',()=>{assert.equal(nearestRasterScene(map,1.5,1.5,new Set(['a','b','c'])),'c');});
test('map filters deleted captures and captures belonging to another floor',()=>{assert.equal(nearestRasterScene(map,.8,.9,new Set(['a'])),'a');assert.equal(nearestRasterScene(map,.8,.9,new Set()),null);});
test('invalid coordinates are a silent no-op and current capture can remain nearest',()=>{assert.equal(nearestRasterScene(map,NaN,0,new Set(['a'])),null);assert.equal(nearestRasterScene(map,.1,.3,new Set(['a','b'])),'a');});

test('heading tolerates illustrated registration noise and rejects a minority outlier',()=>{
 const scenes=[{id:'a',floor:0,links:['b','c','d'],visualLinks:[{targetId:'b',yaw:0},{targetId:'c',yaw:0},{targetId:'d',yaw:0}]} as Scene,...['b','c','d'].map(id=>({id,floor:0,links:['a'],visualLinks:[{targetId:'a',yaw:180}]} as Scene))];
 const point=(sceneId:string,degrees:number)=>({sceneId,x:.5+.2*Math.sin(degrees*Math.PI/180),y:.5-.2*Math.cos(degrees*Math.PI/180)});
 const registered:RasterNavigation={...map,width:1000,height:1000,points:[{sceneId:'a',x:.5,y:.5},point('b',-4),point('c',21),point('d',38)]};
 assert.ok(Number.isFinite(rasterViewHeading(registered,scenes,'a',0)));
 registered.points=[{sceneId:'a',x:.5,y:.5},point('b',0),point('c',2),point('d',140)];
 assert.ok(Math.abs(rasterViewHeading(registered,scenes,'a',0)!-1)<1e-8);
 assert.ok(Math.abs(rasterViewHeading(registered,scenes,'a',Math.PI/2)!-91)<1e-8);
});
