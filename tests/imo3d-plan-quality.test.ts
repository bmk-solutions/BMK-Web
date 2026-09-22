import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessPlanQuality,buildPlanRecoveryTasks,selectPlanRecoveryPhotos,type PlanRecoveryTask} from '../src/lib/imo3d/plan-quality.ts';

const scenes=[{id:'a',floor:0},{id:'b',floor:0}];
const evidence=(sceneId:string)=>({sceneId,roomCategory:'unknown' as const,visibleEvidence:['room boundary'],openings:[],distinctiveFeatures:[],uncertainties:[]});
function fixture(){return {floors:[{
 floor:0,geometryBasis:'image-supported',evidence:scenes.map(s=>evidence(s.id)),
 layout:{rooms:[
  {id:'left',label:'Living room',evidenceSceneIds:['a'],polygon:[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.9},{x:.1,y:.9}] as {x:number;y:number}[]|null,uncertainty:'Photo estimate'},
  {id:'right',label:'Bedroom',evidenceSceneIds:['b'],polygon:[{x:.5,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.5,y:.9}] as {x:number;y:number}[]|null,uncertainty:'Photo estimate'},
 ],openings:[{id:'door',roomId:'left',otherRoomId:'right' as string|null,kind:'door',edgeIndex:1,offset:.4,width:.2,evidenceSceneIds:['a','b'],uncertainty:'Approximate jamb location'}],uncertainties:['Not surveyed; dimensions are not established.']},
 audit:{verdict:'consistent',reviewedSceneIds:['a','b'],issues:[] as string[],limitations:['Estimated geometry is not a certified survey.']},
}]};}

test('complete estimated geometry can render while survey limitations remain explicit',()=>{
 const report=assessPlanQuality(fixture(),scenes);
 assert.equal(report.readyForRender,true);assert.equal(report.status,'complete-estimate');
 assert.deepEqual(report.issues,[]);assert.equal(report.analyzedSceneCount,2);
 assert.deepEqual(report.floors[0].traversableRoomGroups,[['left','right']]);
 assert.deepEqual(buildPlanRecoveryTasks(fixture(),scenes),[]);
});

test('one supported polygon does not make the remaining rooms complete',()=>{
 const input=fixture();input.floors[0].layout.rooms[1].polygon=null;input.floors[0].layout.openings=[];
 const original=structuredClone(input),report=assessPlanQuality(input,scenes);
 assert.equal(report.readyForRender,false);assert.equal(report.status,'needs-recovery');
 assert.equal(report.analyzedSceneCount,2);assert.equal(report.locatedRoomCount,1);
 assert.deepEqual(report.floors[0].unlocatedSceneIds,['b']);
 assert.deepEqual(report.issues.find(i=>i.code==='ROOMS_UNRESOLVED')?.roomIds,['right']);
 assert.deepEqual(input,original,'quality assessment cannot invent geometry or modify cached evidence');
});

test('photo count cannot be satisfied by duplicate, omitted or foreign IDs',()=>{
 for(const ids of [['a','a'],['a','invented'],['a']]){
  const input=fixture();input.floors[0].evidence=ids.map(evidence);
  const report=assessPlanQuality(input,scenes);
  assert.equal(report.readyForRender,false);assert.ok(report.issues.some(i=>i.code==='PHOTO_COVERAGE'));
 }
 const duplicateSource=assessPlanQuality(fixture(),[scenes[0],scenes[0]]);
 assert.ok(duplicateSource.issues.some(i=>i.code==='SOURCE_COVERAGE'));
});

test('a complete audit must cover every same-floor photo exactly once',()=>{
 const input=fixture();input.floors[0].audit.reviewedSceneIds=['a','a'];
 assert.ok(assessPlanQuality(input,scenes).issues.some(i=>i.code==='AUDIT_COVERAGE'));
 const floors=fixture();floors.floors.push({...structuredClone(floors.floors[0]),floor:1});
 const report=assessPlanQuality(floors,[...scenes,{id:'c',floor:1}]);
 assert.equal(report.readyForRender,false);assert.ok(report.issues.some(i=>i.floor===1&&i.code==='PHOTO_COVERAGE'));
});

test('missing or duplicate floors are rejected even when each copy looks valid',()=>{
 const missing=assessPlanQuality(fixture(),[...scenes,{id:'c',floor:2}]);
 assert.ok(missing.issues.some(i=>i.code==='FLOOR_COVERAGE'));
 const duplicate=fixture();duplicate.floors.push(structuredClone(duplicate.floors[0]));
 assert.ok(assessPlanQuality(duplicate,scenes).issues.some(i=>i.code==='FLOOR_COVERAGE'));
});

test('topology-only analysis and inconclusive audit cannot authorize furnishing',()=>{
 const input=fixture();input.floors[0].geometryBasis='topology-only';input.floors[0].audit.verdict='inconclusive';
 const report=assessPlanQuality(input,scenes);assert.equal(report.status,'needs-recovery');
 assert.ok(report.issues.some(i=>i.code==='GEOMETRY_UNRESOLVED'));
 assert.ok(report.issues.some(i=>i.code==='AUDIT_UNRESOLVED'));
 const inconsistent=fixture();inconsistent.floors[0].audit.issues=['A wall contradiction remains.'];
 assert.equal(assessPlanQuality(inconsistent,scenes).readyForRender,false,'consistent label cannot override outstanding issues');
});

test('invalid overlap and a door through an unrelated wall fail the geometry gate',()=>{
 const overlap=fixture();overlap.floors[0].layout.rooms[1].polygon=overlap.floors[0].layout.rooms[0].polygon;
 assert.ok(assessPlanQuality(overlap,scenes).issues.some(i=>i.code==='GEOMETRY_INVALID'));
 const wrongDoor=fixture();wrongDoor.floors[0].layout.openings[0].edgeIndex=0;
 assert.ok(assessPlanQuality(wrongDoor,scenes).issues.some(i=>i.code==='GEOMETRY_INVALID'));
});

test('windows and unidentified exterior doors do not prove a path between rooms',()=>{
 for(const change of ['window','exterior','missing']){
  const input=fixture();
  if(change==='window')input.floors[0].layout.openings[0].kind='window';
  else if(change==='exterior')input.floors[0].layout.openings[0].otherRoomId=null;
  else input.floors[0].layout.openings=[];
  const report=assessPlanQuality(input,scenes);assert.equal(report.readyForRender,false);
  assert.deepEqual(report.floors[0].traversableRoomGroups,[['left'],['right']]);
  assert.ok(report.issues.some(i=>i.code==='ACCESS_UNRESOLVED'));
 }
});

test('multiple floors need independent valid plans, not a fabricated inter-floor door',()=>{
 const input=fixture(),second=structuredClone(input.floors[0]);second.floor=2;
 second.evidence=[evidence('c'),evidence('d')];second.audit.reviewedSceneIds=['c','d'];
 second.layout.rooms[0].evidenceSceneIds=['c'];second.layout.rooms[1].evidenceSceneIds=['d'];second.layout.openings[0].evidenceSceneIds=['c','d'];
 input.floors.push(second);
 const report=assessPlanQuality(input,[...scenes,{id:'c',floor:2},{id:'d',floor:2}]);
 assert.equal(report.readyForRender,true);assert.equal(report.sceneCount,4);assert.equal(report.roomCount,4);
});

test('targeted recovery retains every unresolved room view and same-floor context',()=>{
 const input=fixture();input.floors[0].layout.rooms[1].polygon=null;input.floors[0].layout.openings=[];
 const source=[scenes[0],{id:'upstairs',floor:1},scenes[1]],tasks=buildPlanRecoveryTasks(input,source);
 const room=tasks.find(t=>t.kind==='room-outline');assert.ok(room);
 assert.deepEqual(room.roomIds,['right']);assert.deepEqual(room.sceneIds,['b']);assert.deepEqual(room.contextSceneIds,['a']);
 assert.match(room.objective,/polygon:null/);assert.ok(!room.contextSceneIds.includes('upstairs'));
});

test('malformed analysis returns an invalid report without erasing source evidence',()=>{
 const report=assessPlanQuality({floors:[{floor:0,layout:'bad'}]},scenes);
 assert.equal(report.status,'invalid');assert.equal(report.sceneCount,2);assert.ok(report.issues.some(i=>i.code==='SCHEMA'));
 assert.deepEqual(buildPlanRecoveryTasks(null,scenes),[]);
});

test('empty source, floor list, room list or source-free extra floor cannot look complete',()=>{
 assert.equal(assessPlanQuality({floors:[]},[]).readyForRender,false);
 assert.equal(assessPlanQuality({floors:[]},scenes).status,'invalid');
 const rooms=fixture();rooms.floors[0].layout.rooms=[];rooms.floors[0].layout.openings=[];
 assert.equal(assessPlanQuality(rooms,scenes).status,'invalid');
 const extra=fixture(),floor=structuredClone(extra.floors[0]);floor.floor=42;floor.evidence=[];floor.audit.reviewedSceneIds=[];
 extra.floors.push(floor);assert.equal(assessPlanQuality(extra,scenes).status,'invalid');
});

test('photo IDs without any observed visual evidence do not prove an image was analyzed',()=>{
 const input=fixture();input.floors[0].evidence[1].visibleEvidence=['  '];
 const report=assessPlanQuality(input,scenes);
 assert.equal(report.readyForRender,false);assert.equal(report.status,'needs-recovery');
 assert.deepEqual(report.issues.find(i=>i.code==='PHOTO_EVIDENCE_EMPTY')?.sceneIds,['b']);
 assert.ok(buildPlanRecoveryTasks(input,scenes).some(t=>t.kind==='photo-coverage'));
});

test('recovery attachment selection covers each room fairly and rejects foreign-floor views',()=>{
 const photos=Array.from({length:12},(_,i)=>({sceneId:String(i),floor:i===11?2:0}));
 const task=(ids:string[],context:string[]=[]):PlanRecoveryTask=>({kind:'room-outline',floor:0,roomIds:[ids[0]],sceneIds:ids,contextSceneIds:context,objective:'Inspect room'});
 const tasks=[task(['0','1','2','3','4'],['5','11']),task(['6','7','8','9','10'],['11'])];
 assert.deepEqual(selectPlanRecoveryPhotos(photos,tasks,2).map(p=>p.sceneId),['0','6']);
 const selected=selectPlanRecoveryPhotos(photos,tasks,6).map(p=>p.sceneId);
 assert.ok(selected.includes('0')&&selected.includes('6')&&selected.includes('4')&&selected.includes('10'));
 assert.ok(!selected.includes('11'));assert.equal(new Set(selected).size,selected.length);
 assert.equal(selectPlanRecoveryPhotos(photos,tasks,1).length,2,'soft budget preserves both room anchors');
});
