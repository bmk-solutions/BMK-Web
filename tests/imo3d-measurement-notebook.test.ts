import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementStore,readMeasurements,rescaleSavedEstimate} from '../src/lib/imo3d/measurement-notebook';
const item={id:'one',sceneId:'a',label:'Door',meters:2.1};
test('shared capture default rescales existing estimates once, preserves rays, ids and metric measurements',()=>{
 const legacy={...item,estimated:true,meters:3.2,endpoints:[{x:2,y:2,z:3},{x:2,y:5.2,z:3}] as [{x:number;y:number;z:number},{x:number;y:number;z:number}]};
 const context={origin:{x:2,y:1,z:3},heightMeters:1.27};
 const next=rescaleSavedEstimate(legacy,context);
 assert.equal(next.id,legacy.id);assert.equal(next.sceneId,'a');assert.equal(next.meters,2.54);assert.equal(next.lensHeightMeters,1.27);
 assert.ok(Math.abs(next.endpoints![1].y-next.endpoints![0].y-2.54)<1e-10);
 assert.deepEqual(rescaleSavedEstimate(next,context),next);
 assert.deepEqual(rescaleSavedEstimate(legacy,{...context,legacyHeightMeters:1.27}),legacy);
 assert.deepEqual(rescaleSavedEstimate({...legacy,estimated:false},context),{...legacy,estimated:false});
 assert.equal(rescaleSavedEstimate(legacy,undefined),legacy);
 const storage=new Map([['project:4',JSON.stringify([legacy])]]);
 const store=createMeasurementStore('project:4',new Set(['a']),()=>({getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);}}),measurement=>rescaleSavedEstimate(measurement,context));
 assert.equal(store.getSnapshot()[0].meters,2.54);store.refresh();assert.equal(store.getSnapshot()[0].meters,2.54);
 store.remove(legacy.id);assert.deepEqual(store.getSnapshot(),[]);
});
test('clear removes the whole tour notebook persistently but preserves other tours and revisions',()=>{
 const data=new Map<string,string>();
 const storage=()=>({getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}});
 const store=createMeasurementStore('tour-a:1',new Set(['a','b']),storage);
 store.save(item);store.save({...item,id:'two',sceneId:'b'});
 const other=createMeasurementStore('tour-b:1',new Set(['a']),storage);
 const revision=createMeasurementStore('tour-a:2',new Set(['a']),storage);
 other.save(item);revision.save(item);
 let notifications=0;store.subscribe(()=>notifications++);
 store.clear();
 assert.equal(notifications,1);
 assert.deepEqual(store.getSnapshot(),[]);
 assert.deepEqual(createMeasurementStore('tour-a:1',new Set(['a','b']),storage).getSnapshot(),[]);
 assert.deepEqual(other.getSnapshot(),[item]);assert.deepEqual(revision.getSnapshot(),[item]);
 assert.deepEqual(JSON.parse(data.get('tour-b:1')!),[item]);
 store.save(item);assert.deepEqual(store.getSnapshot(),[item]);
});
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

import {estimatedMeasurementPoint,DEFAULT_CAPTURE_HEIGHT_METERS,measurementDepthSample,continuousMeasurementDepth,recordedMeasurementHeight} from '../src/lib/imo3d/estimated-measurement';
import type {Scene} from '../src/lib/imo3d/model';
test('recorded height scales distances in every direction without altering geometry or covering new photos',()=>{
 const scene={id:'a',yaw:0,position:{x:4,y:2,z:8},displayDepth:{source:'da3-base-pose-conditioned-multiview',purpose:'display_only',units:'camera_height',width:8,height:4,confidence:.9,coverage:1,values:Array(32).fill(2)}} as Scene;
 const tour={measurementScale:{heightMeters:2,source:'operator_measured' as const,sceneIds:['a']}},before=JSON.stringify(scene);
 assert.equal(recordedMeasurementHeight(tour,'a'),2);assert.equal(recordedMeasurementHeight(tour,'new-photo'),null);
 assert.equal(recordedMeasurementHeight({},'a'),null);
 for(const height of [NaN,Infinity,0,-2,11]){
  assert.equal(recordedMeasurementHeight({measurementScale:{...tour.measurementScale,heightMeters:height}},'a'),null);
  assert.equal(estimatedMeasurementPoint(scene,0,0,height),null);
 }
 const origin=scene.position!;
 for(const [yaw,pitch] of [[0,0],[.5,.7],[-.8,-.4],[0,Math.PI/2]]){
  const first=estimatedMeasurementPoint(scene,yaw,pitch,1)!,second=estimatedMeasurementPoint(scene,yaw,pitch,2)!;
  for(const key of ['x','y','z'] as const)assert.ok(Math.abs((second[key]-origin[key])-2*(first[key]-origin[key]))<1e-8);
 }
 assert.equal(JSON.stringify(scene),before);
});
test('every existing or new project uses the shared 1.27 m rig unless its capture height is overridden',()=>{
 assert.equal(DEFAULT_CAPTURE_HEIGHT_METERS,1.27);
 for(const id of ['hamra','existing-project','new-project']){
  const scene={id,yaw:0,position:null,displayDepth:{source:'da3-base-pose-conditioned-multiview',purpose:'display_only',units:'camera_height',width:8,height:4,confidence:.9,coverage:1,values:Array(32).fill(2)}} as Scene;
  assert.equal(estimatedMeasurementPoint(scene,0,0)!.z,-2.54);
  assert.equal(estimatedMeasurementPoint(scene,0,0,2)!.z,-4);
 }
});
test('estimated depth measures vertical and horizontal rays without becoming metric data',()=>{
 const scene={yaw:0,position:{x:0,y:0,z:0},displayDepth:{source:'da3-base-pose-conditioned-multiview',purpose:'display_only',units:'camera_height',width:8,height:4,confidence:.9,coverage:1,values:Array(32).fill(2)}} as Scene;
 assert.deepEqual(estimatedMeasurementPoint(scene,0,0),{x:0,y:0,z:-2*DEFAULT_CAPTURE_HEIGHT_METERS});
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

test('subpixel wall measurements remain smooth across depth pixel boundaries',()=>{
 const width=128,height=64;
 // A front-facing wall at z=-3 in camera-height units, with all pixels on it.
 const values=Array.from({length:width*height},(_,i)=>{
  const yaw=((i%width+.5)/width-.5)*2*Math.PI,pitch=(.5-(Math.floor(i/width)+.5)/height)*Math.PI;
  return 3/(Math.cos(yaw)*Math.cos(pitch));
 });
 const depth={width,height,values} as NonNullable<Scene['displayDepth']>;
 for(const [u,v] of [[.51,.4],[.57,.53],[.6,.61]]){
  const yaw=(u-.5)*2*Math.PI,pitch=(.5-v)*Math.PI,expected=3/(Math.cos(yaw)*Math.cos(pitch));
  assert.ok(Math.abs(continuousMeasurementDepth(depth,u,v)!-expected)/expected<.002);
 }
 const boundary=73/width,v=.47,epsilon=1e-6;
 assert.ok(Math.abs(continuousMeasurementDepth(depth,boundary-epsilon,v)!-continuousMeasurementDepth(depth,boundary+epsilon,v)!)<.001);
 assert.ok(Math.abs(measurementDepthSample(depth,72,30)!-measurementDepthSample(depth,73,30)!)>.01);
});

test('subpixel measurements never blend across an open doorway or invent missing depth',()=>{
 const depth={width:128,height:64,values:Array(8192).fill(2)} as NonNullable<Scene['displayDepth']>;
 for(let y=0;y<64;y++)for(let x=64;x<128;x++)depth.values[y*128+x]=7;
 assert.equal(continuousMeasurementDepth(depth,.4999,.5),2);
 assert.equal(continuousMeasurementDepth(depth,.5001,.5),7);
 for(let y=30;y<=34;y++)for(let x=61;x<=65;x++)depth.values[y*128+x]=0;
 assert.equal(continuousMeasurementDepth(depth,63.5/128,32.5/64),null);
 assert.equal(continuousMeasurementDepth(depth,NaN,.5),null);
 assert.equal(continuousMeasurementDepth(depth,.5,1.1),null);
});

test('subpixel measurement wraps panorama seam and retains pole samples',()=>{
 const depth={width:128,height:64,values:Array(8192).fill(2)} as NonNullable<Scene['displayDepth']>;
 assert.equal(continuousMeasurementDepth(depth,0,.5),2);
 assert.equal(continuousMeasurementDepth(depth,1,.5),2);
 assert.equal(continuousMeasurementDepth(depth,0,0),2);
 assert.equal(continuousMeasurementDepth(depth,0,1),2);
});
