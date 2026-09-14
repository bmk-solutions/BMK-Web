import {z} from 'zod';
import type {Tour} from '../model';
export const MAX_PANORAMA_BYTES=100*1024*1024;
export const MAX_PANORAMA_PIXELS=268_435_456;
export const uploadInitSchema=z.object({name:z.string().trim().min(1).max(200),size:z.number().int().min(1).max(MAX_PANORAMA_BYTES),type:z.enum(['image/jpeg','image/png','image/webp']),floor:z.number().int().min(-10).max(200),revision:z.number().int().nonnegative()});
export const uploadFinalizeSchema=z.object({uploadId:z.string().uuid(),revision:z.number().int().nonnegative()});
export const normalizedImageName=(name:string)=>name.normalize('NFC').toLowerCase();
export function uploadConflict(tour:Tour,input:{name:string;revision:number}){
 if(tour.revision!==input.revision)return 'تغيّرت الجولة. أعد تحميلها قبل إضافة الصور.';
 if(tour.scenes.length>=500)return 'الحد الحالي 500 لقطة للجولة.';
 if(tour.scenes.some(scene=>normalizedImageName(scene.sourceName)===normalizedImageName(input.name)))return 'توجد لقطة بهذا الاسم بالفعل. غيّر اسم الملف قبل رفعه.';
 return null;
}
export function panoramaProblem(meta:{format?:string;width?:number;height?:number;pages?:number;orientation?:number}){
 if(!['jpeg','png','webp'].includes(meta.format??''))return 'اختر صورة JPG أو PNG أو WEBP صالحة.';
 if(!meta.width||!meta.height||Math.abs(meta.width/meta.height-2)>0.03||meta.width<1024)return 'يلزم صورة 360 كاملة بنسبة 2:1 وعرض 1024 بكسل على الأقل.';
 if((meta.pages??1)>1)return 'اختر بانوراما ثابتة؛ الصور المتحركة غير مدعومة.';
 if(meta.width*meta.height>MAX_PANORAMA_PIXELS)return 'دقة الصورة تتجاوز الحد الآمن البالغ 268 مليون بكسل.';
 if([5,6,7,8].includes(meta.orientation??1))return 'صدّر البانوراما بنسبة 2:1 دون تدوير EXIF عمودي.';
 return null;
}
