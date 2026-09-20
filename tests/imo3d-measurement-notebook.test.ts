import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementStore,readMeasurements} from '../src/lib/imo3d/measurement-notebook';
const item={id:'one',sceneId:'a',label:'Door',meters:2.1};
test('saved measurements survive reopen, remain isolated, and removal persists',()=>{
 const data=new Map<string,string>();
 const storage=()=>({getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}});
 const store=createMeasurementStore('tour-a:1',new Set(['a']),storage);
 store.save(item);store.save(item);
 assert.equal(store.getSnapshot().length,1);
 const reopened=createMeasurementStore('tour-a:1',new Set(['a']),storage);
 assert.deepEqual(reopened.getSnapshot(),[item]);
 assert.deepEqual(createMeasurementStore('tour-b:1',new Set(['a']),storage).getSnapshot(),[]);
 assert.deepEqual(createMeasurementStore('tour-a:2',new Set(['a']),storage).getSnapshot(),[]);
 reopened.remove(item.id);
 assert.deepEqual(createMeasurementStore('tour-a:1',new Set(['a']),storage).getSnapshot(),[]);
});
test('corrupt storage, removed scenes and invalid dimensions cannot produce measurements',()=>{
 assert.deepEqual(readMeasurements('{oops',new Set(['a'])),[]);
 assert.deepEqual(readMeasurements(JSON.stringify([item]),new Set(['b'])),[]);
 assert.deepEqual(readMeasurements(JSON.stringify([{...item,meters:-1},{...item,endpoints:[{},{}]}]),new Set(['a'])),[]);
});
test('unavailable storage still allows saving and removing in the active tour',()=>{
 const store=createMeasurementStore('a',new Set(['a']),()=>{throw Error('denied');});
 store.save(item);assert.deepEqual(store.getSnapshot(),[item]);
 store.remove(item.id);assert.deepEqual(store.getSnapshot(),[]);
});

import {measurementValue,formatMeasurement} from '../src/lib/imo3d/measurement-units';
test('unit switching converts original meters without changing stored dimensions',()=>{
 const meters=2.54;
 assert.equal(measurementValue(meters,'cm'),254);
 assert.equal(measurementValue(meters,'in'),100);
 assert.equal(measurementValue(meters,'m'),meters);
 assert.equal(formatMeasurement(meters,'in'),'100.0 in');
 assert.equal(formatMeasurement(NaN,'cm'),'—');
 assert.equal(formatMeasurement(-1,'m'),'—');
 assert.equal(item.meters,2.1);
});

import {estimatedMeasurementPoint,ASSUMED_CAMERA_HEIGHT_METERS,measurementDepthSample} from '../src/lib/imo3d/estimated-measurement';
import type {Scene} from '../src/lib/imo3d/model';
test('estimated depth measures vertical and horizontal rays without becoming metric data',()=>{
 const scene={yaw:0,position:{x:0,y:0,z:0},displayDepth:{source:'da3-base-pose-conditioned-multiview',purpose:'display_only',units:'camera_height',width:8,height:4,confidence:.9,coverage:1,values:Array(32).fill(2)}} as Scene;
 assert.deepEqual(estimatedMeasurementPoint(scene,0,0),{x:0,y:0,z:-2*ASSUMED_CAMERA_HEIGHT_METERS});
 assert.ok(estimatedMeasurementPoint(scene,0,Math.PI/4)!.y>0);
 assert.equal(scene.depth,undefined);
 assert.equal(estimatedMeasurementPoint({...scene,displayDepth:undefined},0,0),null);
 assert.equal(estimatedMeasurementPoint(scene,NaN,0),null);
 const saved={...item,estimated:true,label:'Estimated, assumed height 1.60 m'};
 assert.deepEqual(readMeasurements(JSON.stringify([saved]),new Set(['a'])),[saved]);
});

test('wall depth fills a small supported hole without bridging a doorway or a large gap',()=>{
 const depth={width:128,height:64,values:Array(8192).fill(2)} as NonNullable<Scene['displayDepth']>;
 depth.values[32*128+64]=0;
 assert.equal(measurementDepthSample(depth,64,32),2);
 depth.values[32*128+65]=5;
 assert.equal(measurementDepthSample(depth,64,32),null);
 depth.values[32*128+65]=0;depth.values[31*128+64]=0;
 assert.equal(measurementDepthSample(depth,64,32),null);
});
