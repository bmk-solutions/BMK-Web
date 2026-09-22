import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import {parseProcessingJob,tourWorkflowCoverage,type ProcessingJob} from '../src/lib/imo3d/processing-model';
import type {Tour} from '../src/lib/imo3d/model';
import {changePhotoEdit} from '../src/lib/imo3d/photo-edits';
import {applySceneFloorAssignments} from '../src/lib/imo3d/floor-assignment';

function job(tour:Tour,overrides:Partial<ProcessingJob>={}):ProcessingJob{return {id:'processing-test',tourId:tour.id,status:'review',progress:100,stage:'Finished',createdAt:tour.createdAt,updatedAt:tour.updatedAt,error:null,warnings:[],result:{registered:tour.scenes.length,total:tour.scenes.length,links:10,components:1,scale:'relative',analyzedPhotos:tour.scenes.length,analyzedSceneIds:tour.scenes.map(scene=>scene.id),analyzedSources:tour.scenes.map(({id,image,floor})=>({id,image,floor}))},...overrides};}
function reviewFloor(tour:Tour,floor:number){const plan=tour.plans.find(item=>item.floor===floor)!;plan.architectureReview='reviewed';plan.architecture={version:1,floor,scale:{status:'estimated',metersPerUnit:null,displayUnit:'m'},walls:[],openings:[],columns:[],rooms:[{id:`room-${floor}`,name:'Synthetic',polygon:[{x:0,z:0},{x:10,z:0},{x:10,z:10},{x:0,z:10}],wallIds:[],cameraIds:tour.scenes.filter(scene=>scene.floor===floor).map(scene=>scene.id),confidence:.8}]};}

test('photo evidence coverage is separate from a shared camera frame',()=>{
 const tour=syntheticTour();tour.scenes[4].position=null;tour.scenes[5].position=null;
 const result=job(tour);Object.assign(result.result!,{registered:4,positionedLocalPhotos:5,independentFrames:2,unmatchedPhotos:1});
 const coverage=tourWorkflowCoverage(tour,result);
 assert.equal(coverage.analyzed,6);assert.equal(coverage.analysisComplete,true);assert.equal(coverage.positioned,4);assert.equal(coverage.unpositioned,2);assert.equal(coverage.localPositioned,5);assert.equal(coverage.unmatched,1);assert.equal(coverage.spatialComplete,false);assert.equal(coverage.ready,false);
});
test('legacy recognized labels or successful execution do not certify photo coverage',()=>{
 const tour=syntheticTour(),result=job(tour);delete result.result!.analyzedPhotos;result.result!.recognizedPhotos=6;
 const coverage=tourWorkflowCoverage(tour,result);assert.equal(coverage.analyzed,null);assert.equal(coverage.analysisComplete,false);assert.equal(coverage.ready,false);
});
test('stale, cancelled, unrelated and changed-size jobs do not complete analysis',()=>{
 const tour=syntheticTour();
 for(const result of [job(tour,{status:'cancelled'}),job(tour,{status:'stale'}),job(tour,{status:'failed'}),job(tour,{tourId:'other-tour'}),job(tour,{result:{...job(tour).result!,total:7}})])assert.equal(tourWorkflowCoverage(tour,result).analysisComplete,false);
});
test('a positioned but disconnected or explicitly blocked floor is not fully linked',()=>{
 const tour=syntheticTour();tour.scenes.forEach((scene,index)=>{scene.links=index<3?tour.scenes.slice(0,3).map(item=>item.id):tour.scenes.slice(3).map(item=>item.id);});
 assert.equal(tourWorkflowCoverage(tour,job(tour)).spatialComplete,false);
 tour.scenes[0].links.push(tour.scenes[3].id);tour.scenes[3].links.push(tour.scenes[0].id);
 assert.equal(tourWorkflowCoverage(tour,job(tour)).spatialComplete,true);
 tour.scenes[3].blockedLinks=[tour.scenes[0].id];assert.equal(tourWorkflowCoverage(tour,job(tour)).spatialComplete,false);
});
test('one reviewed floor never completes a multi-floor tour',()=>{
 const tour=syntheticTour();tour.scenes.slice(3).forEach(scene=>scene.floor=1);tour.plans.push({...structuredClone(tour.plans[0]),floor:1});reviewFloor(tour,0);
 let coverage=tourWorkflowCoverage(tour,job(tour));assert.equal(coverage.floors,2);assert.equal(coverage.reviewedFloors,1);assert.equal(coverage.planComplete,false);assert.equal(coverage.ready,false);
 reviewFloor(tour,1);coverage=tourWorkflowCoverage(tour,job(tour));assert.equal(coverage.planComplete,true);assert.equal(coverage.ready,true);
});
test('a rejected plan or missing scene assignment cannot pass floor review coverage',()=>{
 const tour=syntheticTour();reviewFloor(tour,0);tour.plans[0].architecture!.rooms[0].cameraIds.pop();assert.equal(tourWorkflowCoverage(tour,job(tour)).planComplete,false);
 reviewFloor(tour,0);tour.plans[0].reviewStatus='rejected';assert.equal(tourWorkflowCoverage(tour,job(tour)).planComplete,false);
});
test('empty tours and invalid count reports never become ready',()=>{
 const tour=syntheticTour(),result=job(tour);result.result!.analyzedPhotos=7;result.result!.positionedLocalPhotos=-1;
 assert.equal(tourWorkflowCoverage(tour,result).analyzed,null);assert.equal(tourWorkflowCoverage(tour,result).localPositioned,null);
 tour.scenes=[];tour.plans=[];assert.equal(tourWorkflowCoverage(tour,job(tour)).ready,false);
});
test('coverage response preserves separate counts with bounded validation',()=>{
 const tour=syntheticTour(),result=job(tour);Object.assign(result.result!,{positionedLocalPhotos:5,independentFrames:2,unmatchedPhotos:1});
 assert.deepEqual(parseProcessingJob(result)?.result,result.result);
 assert.throws(()=>parseProcessingJob({...result,result:{...result.result,analyzedPhotos:1.5}}));
});

test('replacing one photo at the same total invalidates the older analysis coverage',()=>{
 const tour=syntheticTour(),result=job(tour);tour.scenes[0]={...tour.scenes[0],id:'replacement-photo'};
 const coverage=tourWorkflowCoverage(tour,result);assert.equal(coverage.analyzed,null);assert.equal(coverage.analysisComplete,false);assert.equal(coverage.localPositioned,null);
});
test('partly inspected evidence may report its current subset without claiming completion',()=>{
 const tour=syntheticTour(),result=job(tour);result.result!.analyzedPhotos=2;result.result!.analyzedSceneIds=tour.scenes.slice(0,2).map(scene=>scene.id);result.result!.analyzedSources=result.result!.analyzedSources!.slice(0,2);
 assert.equal(tourWorkflowCoverage(tour,result).analyzed,2);assert.equal(tourWorkflowCoverage(tour,result).analysisComplete,false);
 result.result!.analyzedSceneIds=[tour.scenes[0].id,tour.scenes[0].id];assert.equal(tourWorkflowCoverage(tour,result).analyzed,null);
});

test('changing a source image or its floor invalidates same-ID coverage',()=>{
 const tour=syntheticTour(),result=job(tour);
 const changedImage={...tour,scenes:tour.scenes.map((scene,index)=>index?scene:{...scene,image:'/api/imo3d/assets/replacement-original'})};
 assert.equal(tourWorkflowCoverage(changedImage,result).analyzed,null);
 const reassigned={...tour,...applySceneFloorAssignments(tour,tour.scenes.map((scene,index)=>index?scene:{...scene,floor:1}))};
 assert.equal(tourWorkflowCoverage(reassigned,result).analyzed,null);assert.equal(tourWorkflowCoverage(reassigned,result).analysisComplete,false);
});
test('actual retouch application and restoration preserve the original evidence source',()=>{
 const tour=syntheticTour(),result=job(tour),scene=tour.scenes[0],editId='86e9d2f1-cf1f-46bc-b57c-674a7a8f5432';
 tour.photoEdits=[{id:editId,sceneId:scene.id,source:scene.image,prompt:'Remove the tripod',yaw:0,pitch:-60,fov:60,status:'draft',createdAt:tour.createdAt,updatedAt:tour.updatedAt,result:{image:'/api/imo3d/assets/edited-display',preview:'/api/imo3d/assets/edited-preview',thumbnail:'/api/imo3d/assets/edited-thumb',width:4000,height:2000}}];
 const applied=changePhotoEdit(tour,{revision:tour.revision,action:'apply',sceneId:scene.id,jobId:editId},editId);
 assert.equal(applied.scenes[0].image,scene.image);assert.notEqual(applied.scenes[0].presentation?.image,scene.image);assert.equal(tourWorkflowCoverage(applied,result).analysisComplete,true);
 const restored=changePhotoEdit(applied,{revision:applied.revision,action:'restore',sceneId:scene.id},editId);
 assert.equal(restored.scenes[0].presentation,undefined);assert.equal(tourWorkflowCoverage(restored,result).analysisComplete,true);
});
test('source evidence cannot expose filesystem paths through processing response',()=>{
 const tour=syntheticTour(),result=job(tour);result.result!.analyzedSources![0].image='C:/private/photo.jpg';
 assert.throws(()=>parseProcessingJob(result));
});
