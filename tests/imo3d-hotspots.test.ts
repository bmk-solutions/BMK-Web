import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import {hotspotSchema,validateHotspots,hotspotPoint} from '../src/lib/imo3d/hotspots';
import {changePhotoEdit,presentationScene} from '../src/lib/imo3d/photo-edits';
import {compositePhotoPatch,extractPhotoPatch} from '../src/lib/imo3d/photo-edit-projection';
import {removeTourScene} from '../src/lib/imo3d/scene-removal';
const row=()=>hotspotSchema.parse({id:randomUUID(),sceneId:'synthetic-0',kind:'text',title:'A note',yaw:0,pitch:0});
test('hotspots reject unsafe URLs, foreign scenes, duplicate IDs and self transitions',()=>{
 const tour=syntheticTour(),note=row();assert.equal(validateHotspots(tour,[note]).length,1);
 for(const url of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:pass@example.com'])assert.equal(hotspotSchema.safeParse({...note,kind:'link',url}).success,false);
 assert.throws(()=>validateHotspots(tour,[note,note]));assert.throws(()=>validateHotspots(tour,[{...note,sceneId:'foreign'}]));
 assert.throws(()=>validateHotspots(tour,[{...note,kind:'point',targetSceneId:note.sceneId}]));
 assert.throws(()=>validateHotspots(tour,[{...note,kind:'point',targetSceneId:'foreign'}]));
 assert.equal(hotspotSchema.safeParse({...note,kind:'image',url:'/api/imo3d/assets/'+randomUUID()}).success,true);
});
test('removing a scene removes both hosted hotspots and incoming point links',()=>{
 const tour=syntheticTour();tour.hotspots=[row(),{...row(),id:randomUUID(),sceneId:'synthetic-1',kind:'point',targetSceneId:'synthetic-0'},{...row(),id:randomUUID(),sceneId:'synthetic-2'}];
 const result=removeTourScene(tour,'synthetic-0')!;assert.equal(result.hotspots?.length,1);assert.equal(result.hotspots?.[0].sceneId,'synthetic-2');assert.equal(tour.hotspots.length,3);
});
test('hotspot projection follows the source compass and camera position',()=>{const scene=syntheticTour().scenes[0];const p=hotspotPoint({...scene,yaw:90},0,0);assert.ok(Math.abs(p.x-scene.position!.x-3)<1e-6);assert.ok(Math.abs(p.z-scene.position!.z)<1e-6);});
test('retouch requires a ready draft, preserves geometry/originals and restores reversibly',()=>{
 const tour=syntheticTour(),id=randomUUID(),sceneId=tour.scenes[0].id;
 let next=changePhotoEdit(tour,{revision:0,action:'create',sceneId,prompt:'Remove the camera',yaw:0,pitch:-90,fov:85},id);
 assert.equal(next.photoEdits?.[0].status,'queued');assert.deepEqual(next.scenes,tour.scenes);assert.throws(()=>changePhotoEdit(next,{revision:1,action:'restore',sceneId},id));
 assert.throws(()=>changePhotoEdit(next,{revision:0,action:'apply',sceneId,jobId:id},id));
 const result={image:'/new.webp',preview:'/preview.webp',thumbnail:'/thumb.webp',width:4096,height:2048};next.photoEdits![0]={...next.photoEdits![0],status:'draft',result};
 next=changePhotoEdit(next,{revision:0,action:'apply',sceneId,jobId:id},id);
 assert.equal(next.scenes[0].image,tour.scenes[0].image);assert.equal(presentationScene(next.scenes[0]).image,result.image);assert.deepEqual(next.scenes[0].position,tour.scenes[0].position);assert.deepEqual(next.plans,tour.plans);
 assert.throws(()=>changePhotoEdit(next,{revision:0,action:'cancel',sceneId,jobId:id},id));
 const restored=changePhotoEdit(next,{revision:0,action:'restore',sceneId},id);assert.equal(presentationScene(restored.scenes[0]).image,tour.scenes[0].image);assert.equal(restored.photoEdits![0].status,'cancelled');
});
test('rejected/cancelled jobs cannot be applied and duplicate active jobs are refused',()=>{
 const tour=syntheticTour(),sceneId=tour.scenes[0].id,id=randomUUID(),request={revision:0,action:'create',sceneId,prompt:'Remove object',yaw:0,pitch:0,fov:50};
 const next=changePhotoEdit(tour,request,id);assert.throws(()=>changePhotoEdit(next,request,randomUUID()));
 const cancelled=changePhotoEdit(next,{revision:0,action:'cancel',sceneId,jobId:id},id);assert.throws(()=>changePhotoEdit(cancelled,{revision:0,action:'apply',sceneId,jobId:id},id));assert.equal(changePhotoEdit(cancelled,request,randomUUID()).photoEdits!.length,2);
});
for(const [yaw,pitch] of [[0,0],[180,0],[0,-90],[0,90]])test(`patch editing preserves unrelated pixels and handles seam/poles (${yaw},${pitch})`,()=>{
 const original={width:128,height:64,data:new Uint8Array(128*64*3).fill(50)},copy=new Uint8Array(original.data),region={yaw,pitch,fov:70};
 const patch=extractPhotoPatch(original,region,32);assert.equal(patch.data.every(v=>v===50),true);
 patch.data.fill(200);const result=compositePhotoPatch(original,patch,region);assert.deepEqual(original.data,copy);assert.equal(result.width,128);assert.equal(result.height,64);
 const changed=result.data.filter(v=>v!==50).length;assert.ok(changed>0&&changed<result.data.length/3);
 const oppositeY=pitch<0?0:pitch>0?63:32,oppositeX=yaw===180?64:0;assert.equal(result.data[(oppositeY*128+oppositeX)*3],50);
});
