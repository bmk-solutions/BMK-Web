import {z} from 'zod';
import type {Tour,Scene} from './model';
export type EditedPhoto={image:string;preview:string;thumbnail:string;width:number;height:number};
export type PhotoEdit={id:string;sceneId:string;source:string;prompt:string;yaw:number;pitch:number;fov:number;status:'queued'|'running'|'draft'|'applied'|'cancelled'|'failed';createdAt:string;updatedAt:string;worker?:string;result?:EditedPhoto;error?:string;review?:string};
export const photoEditRequest=z.object({revision:z.number().int().nonnegative(),action:z.enum(['create','apply','cancel','restore']),sceneId:z.string().min(1).max(80),jobId:z.string().uuid().optional(),prompt:z.string().trim().min(5).max(1200).optional(),yaw:z.number().finite().min(-180).max(180).optional(),pitch:z.number().finite().min(-90).max(90).optional(),fov:z.number().finite().min(10).max(100).optional()}).strict();
export function changePhotoEdit(tour:Tour,raw:unknown,id:string):Tour{
 const input=photoEditRequest.parse(raw);if(input.revision!==tour.revision)throw Error('تغيّرت الجولة؛ أعد تحميل النسخة الأخيرة.');
 const scene=tour.scenes.find(s=>s.id===input.sceneId);if(!scene)throw Error('الصورة غير موجودة.');
 const now=new Date().toISOString(),rows=tour.photoEdits??[];
 if(input.action==='create'){
  if(!input.prompt||input.yaw===undefined||input.pitch===undefined||input.fov===undefined)throw Error('حدّد المكان واكتب التعديل المطلوب.');
  if(rows.some(r=>['queued','running'].includes(r.status)&&r.sceneId===scene.id))throw Error('هناك تعديل قيد المعالجة لهذه الصورة.');
  if(rows.length>=200)throw Error('بلغت هذه الجولة الحد الأقصى لمسودات التحرير.');
  return{...tour,photoEdits:[...rows,{id,sceneId:scene.id,source:scene.presentation?.image??scene.image,prompt:input.prompt,yaw:input.yaw,pitch:input.pitch,fov:input.fov,status:'queued',createdAt:now,updatedAt:now}]};
 }
 if(input.action==='restore')return{...tour,scenes:tour.scenes.map(s=>s.id===scene.id?{...s,presentation:undefined}:s),photoEdits:rows.map(r=>r.sceneId===scene.id&&['queued','running','applied'].includes(r.status)?{...r,status:'cancelled',updatedAt:now}:r)};
 const job=rows.find(r=>r.id===input.jobId&&r.sceneId===scene.id);if(!job)throw Error('المسودة غير موجودة.');
 if(input.action==='cancel'&&job.status==='applied')throw Error('استخدم استعادة الصورة الأصلية لإلغاء تعديل معتمد.');
 if(input.action==='cancel')return{...tour,photoEdits:rows.map(r=>r.id===job.id?{...r,status:'cancelled',updatedAt:now}:r)};
 if(job.status!=='draft'||!job.result)throw Error('المسودة ليست جاهزة للاعتماد.');
 if(job.source!==(scene.presentation?.image??scene.image))throw Error('تغيّرت نسخة الصورة. أنشئ تعديلًا جديدًا.');
 return{...tour,scenes:tour.scenes.map(s=>s.id===scene.id?{...s,presentation:job.result}:s),photoEdits:rows.map(r=>r.id===job.id?{...r,status:'applied',updatedAt:now}:r)};
}
export function presentationScene(scene:Scene):Scene{return scene.presentation?{...scene,...scene.presentation,detail:undefined}:scene;}
