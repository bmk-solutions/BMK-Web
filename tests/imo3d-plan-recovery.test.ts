import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recoverCompletePlan} from '../src/lib/imo3d/plan-recovery.ts';

const scenes=Array.from({length:90},(_,i)=>({id:`s${i}`,floor:0}));
const photos=scenes.map(s=>({sceneId:s.id,floor:s.floor,file:`${s.id}.jpg`}));
function fixture(complete=false){return {floors:[{
 floor:0,geometryBasis:'image-supported',evidence:scenes.map(s=>({sceneId:s.id,roomCategory:'unknown',visibleEvidence:['A wall and a doorway are visible.'],openings:[],distinctiveFeatures:[],uncertainties:[]})),
 layout:{rooms:[
  {id:'left',label:'Living room',evidenceSceneIds:scenes.slice(0,60).map(s=>s.id),polygon:[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.9},{x:.1,y:.9}] as {x:number;y:number}[]|null,uncertainty:'Estimated'},
  {id:'right',label:'Bedroom',evidenceSceneIds:scenes.slice(60).map(s=>s.id),polygon:complete?[{x:.5,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.5,y:.9}]:null as {x:number;y:number}[]|null,uncertainty:'Estimated'},
 ],openings:complete?[{id:'door',roomId:'left',otherRoomId:'right',kind:'door',edgeIndex:1,offset:.4,width:.2,evidenceSceneIds:['s0','s60'],uncertainty:'Estimated'}]:[],uncertainties:['Photo-based estimate.']},
 audit:{verdict:'consistent',reviewedSceneIds:scenes.map(s=>s.id),issues:[] as string[],limitations:['Not surveyed.']},
}]};}
type Analysis=ReturnType<typeof fixture>;
function environment(analysis=fixture()){
 const controller=new AbortController(),cache=new Map<string,Analysis>(),events:string[]=[];
 return {controller,cache,events,options:{analysis,scenes,photos,signal:controller.signal,
  load:async(key:string)=>{events.push('load');return cache.get(key)??null;},
  save:async(key:string,value:Analysis)=>{events.push('save');cache.set(key,structuredClone(value));},
  progress:async(pass:number)=>{events.push(`progress:${pass}`);},
 }};
}

test('complete evidence skips model, checkpoint writes and recovery progress',async()=>{
 const env=environment(fixture(true));let modelCalls=0;
 const result=await recoverCompletePlan({...env.options,recover:async()=>{modelCalls++;return fixture(true);}});
 assert.equal(result.quality.readyForRender,true);assert.equal(result.analysis,env.options.analysis);
 assert.equal(modelCalls,0);assert.deepEqual(env.events,[]);
});

test('unresolved rooms get targeted evidence first and every source photo on the second pass',async()=>{
 const env=environment(),calls:{pass:number;ids:string[];roomIds:string[]}[]=[];
 const result=await recoverCompletePlan({...env.options,recover:async(input)=>{
  calls.push({pass:input.pass,ids:input.photos.map(p=>p.sceneId),roomIds:input.tasks.flatMap(t=>t.roomIds)});
  return fixture(input.pass===2);
 }});
 assert.equal(result.quality.readyForRender,true);assert.equal(calls.length,2);
 assert.ok(calls[0].ids.length<photos.length);assert.ok(calls[0].ids.includes('s60'));assert.ok(calls[0].ids.includes('s89'));
 assert.ok(calls[0].roomIds.includes('right'));assert.deepEqual(calls[1].ids,photos.map(p=>p.sceneId));
 assert.deepEqual(env.events,['progress:1','load','save','progress:2','load','save']);
});

test('incomplete recovery remains gated after two bounded reviews and preserves the analysis',async()=>{
 const env=environment();let calls=0;
 const result=await recoverCompletePlan({...env.options,recover:async()=>{calls++;return fixture();}});
 assert.equal(calls,2);assert.equal(result.quality.readyForRender,false);assert.equal(result.quality.status,'needs-recovery');
 assert.equal(result.analysis.floors[0].layout.rooms[1].polygon,null);
 assert.ok(result.quality.issues.some(i=>i.code==='ROOMS_UNRESOLVED'));
});

test('cancelled model result is neither checkpointed nor followed by another pass',async()=>{
 const env=environment();let calls=0;
 await assert.rejects(recoverCompletePlan({...env.options,recover:async()=>{calls++;env.controller.abort();return fixture(true);}}),{name:'AbortError'});
 assert.equal(calls,1);assert.equal(env.cache.size,0);assert.deepEqual(env.events,['progress:1','load']);
});

test('pre-cancelled work starts no progress, cache access or model call',async()=>{
 const env=environment();env.controller.abort();let calls=0;
 await assert.rejects(recoverCompletePlan({...env.options,recover:async()=>{calls++;return fixture(true);}}),{name:'AbortError'});
 assert.equal(calls,0);assert.deepEqual(env.events,[]);
});

test('cancellation during progress stops before loading or launching an expensive review',async()=>{
 const env=environment();let calls=0;
 await assert.rejects(recoverCompletePlan({...env.options,progress:async()=>{env.controller.abort();},recover:async()=>{calls++;return fixture(true);}}),{name:'AbortError'});
 assert.equal(calls,0);assert.deepEqual(env.events,[]);
});

test('cancellation during cache loading never launches a new expensive model request',async()=>{
 const env=environment();let calls=0;
 await assert.rejects(recoverCompletePlan({...env.options,load:async()=>{env.controller.abort();return null;},recover:async()=>{calls++;return fixture(true);}}),{name:'AbortError'});
 assert.equal(calls,0);assert.equal(env.cache.size,0);
});

test('replaying saved review passes makes no model calls and preserves the same final plan',async()=>{
 const env=environment();let calls=0;
 const first=await recoverCompletePlan({...env.options,recover:async input=>{calls++;return fixture(input.pass===2);}});
 assert.equal(calls,2);assert.equal(env.cache.size,2);
 env.events.length=0;
 const replay=await recoverCompletePlan({...env.options,recover:async()=>{throw Error('Checkpoint replay must not call the model.');}});
 assert.deepEqual(replay,first);assert.deepEqual(env.events,['progress:1','load','progress:2','load']);
});

test('invalid or less complete proposal cannot replace a better supported analysis',async()=>{
 const env=environment(),original=structuredClone(env.options.analysis);let calls=0;
 const result=await recoverCompletePlan({...env.options,recover:async input=>{
  calls++;assert.deepEqual(input.analysis,original,'second pass must use the best retained analysis');
  const worse=fixture();worse.floors[0].layout.rooms[0].polygon=null;worse.floors[0].geometryBasis='topology-only';return worse;
 }});
 assert.equal(calls,2);assert.deepEqual(result.analysis,original);assert.equal(result.quality.locatedRoomCount,1);
});

test('changed source identity does not replay a different photo set recovery',async()=>{
 const env=environment();await recoverCompletePlan({...env.options,recover:async()=>fixture(true)});
 const initialKeys=[...env.cache.keys()];let calls=0;
 await recoverCompletePlan({...env.options,scenes:scenes.map((s,i)=>i? s:{id:'changed-source',floor:0}),recover:async()=>{calls++;return fixture();}});
 assert.equal(calls,2);assert.ok([...env.cache.keys()].some(key=>!initialKeys.includes(key)));
});

test('a complete-looking merged room cannot erase the previously observed room inventory',async()=>{
 const env=environment(),original=structuredClone(env.options.analysis);let calls=0;
 const result=await recoverCompletePlan({...env.options,recover:async input=>{
  calls++;assert.equal(input.analysis.floors[0].layout.rooms.length,2);
  const merged=fixture(true);merged.floors[0].layout.rooms=[{...merged.floors[0].layout.rooms[0],evidenceSceneIds:scenes.map(s=>s.id)}];merged.floors[0].layout.openings=[];return merged;
 }});
 assert.equal(calls,2);assert.deepEqual(result.analysis,original);
 assert.equal(result.quality.readyForRender,false);assert.equal(result.quality.roomCount,2);
});

test('supported room renaming does not trigger the inventory guard',async()=>{
 const env=environment();let calls=0;
 const result=await recoverCompletePlan({...env.options,recover:async()=>{
  calls++;const renamed=fixture(true);renamed.floors[0].layout.rooms[0].id='sitting';renamed.floors[0].layout.rooms[1].id='sleeping';
  renamed.floors[0].layout.openings[0].roomId='sitting';renamed.floors[0].layout.openings[0].otherRoomId='sleeping';return renamed;
 }});
 assert.equal(calls,1);assert.equal(result.quality.readyForRender,true);
 assert.deepEqual(result.analysis.floors[0].layout.rooms.map(r=>r.id),['sitting','sleeping']);
});

test('improved reconstruction context retries cached partial reviews without invalidating identical context',async()=>{
 const env=environment();let calls=0;
 const partial=await recoverCompletePlan({...env.options,contextKey:'geometry-v1',recover:async()=>{calls++;return fixture();}});
 assert.equal(calls,2);assert.equal(partial.quality.readyForRender,false);assert.equal(env.cache.size,2);
 await recoverCompletePlan({...env.options,contextKey:'geometry-v1',recover:async()=>{throw Error('Unchanged context must reuse its saved reviews.');}});
 const improved=await recoverCompletePlan({...env.options,contextKey:'geometry-v2',recover:async()=>{calls++;return fixture(true);}});
 assert.equal(calls,3,'new reconstruction hints must trigger a fresh model review despite identical photo IDs and prior proposal');
 assert.equal(improved.quality.readyForRender,true);assert.equal(env.cache.size,3);
 const replay=await recoverCompletePlan({...env.options,contextKey:'geometry-v2',recover:async()=>{throw Error('Improved context should now have its own completed checkpoint.');}});
 assert.deepEqual(replay,improved);
});
