import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import sharp from 'sharp';
import type {Tour} from '../model';
import {signedValue,verifiedValue} from './chatgpt-auth';
import {cloudDownloadObject,cloudQuery,cloudSignedUpload} from './client';
import {getAsset} from './repository';
import {json,fail,readJSON} from './http';
const mime=z.enum(['image/jpeg','image/png','image/webp','video/mp4','audio/mpeg','audio/wav']);
const permit=z.object({purpose:z.literal('hotspot-media'),tourId:z.string().uuid(),id:z.string().uuid(),key:z.string(),mime,size:z.number().int().positive().max(50_000_000),expires:z.number()}).strict();
export async function hotspotMedia(request:Request,tour:Tour){
 if(request.method!=='POST')return fail('العملية غير متاحة.',405);
 const raw=await readJSON(request,8000);
 if(z.object({action:z.string()}).parse(raw).action==='init'){
  const input=z.object({action:z.literal('init'),mime,size:z.number().int().positive().max(50_000_000)}).strict().parse(raw);
  if(input.mime.startsWith('image/')&&input.size>10_000_000)return fail('حجم الصورة الأقصى 10 ميغابايت.');
  const id=randomUUID(),key=`hotspots/${tour.id}/${id}`;
  return json({upload:await cloudSignedUpload(key),permit:signedValue({purpose:'hotspot-media',tourId:tour.id,id,key,mime:input.mime,size:input.size,expires:Date.now()+30*60_000})});
 }
 const input=z.object({action:z.literal('finalize'),permit:z.string().max(6000)}).strict().parse(raw),parsed=permit.safeParse(verifiedValue(input.permit));
 if(!parsed.success)return fail('تصريح الرفع غير صالح.',400);
 const p=parsed.data;
 if(p.tourId!==tour.id||p.key!==`hotspots/${tour.id}/${p.id}`||p.expires<Date.now())return fail('انتهى تصريح الرفع.',403);
 const existing=await getAsset(p.id);if(existing)return existing.tour_id===tour.id?json({url:`/api/imo3d/assets/${p.id}`}):fail('الملف غير متاح.',404);
 const bytes=Buffer.from(await cloudDownloadObject(p.key));
 if(bytes.length!==p.size)return fail('حجم الملف لا يطابق طلب الرفع.');
 if(p.mime.startsWith('image/')){const info=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();if(!['jpeg','png','webp'].includes(info.format??''))return fail('صيغة الصورة غير مدعومة.');}
 else if(p.mime==='video/mp4'&&bytes.toString('ascii',4,8)!=='ftyp')return fail('ارفع ملف MP4 صحيحًا.');
 else if(p.mime==='audio/wav'&&(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'))return fail('ارفع ملف WAV صحيحًا.');
 else if(p.mime==='audio/mpeg'&&bytes.toString('ascii',0,3)!=='ID3'&&!(bytes[0]===255&&(bytes[1]&224)===224))return fail('ارفع ملف MP3 صحيحًا.');
 await cloudQuery('assets','','POST',{id:p.id,tour_id:tour.id,file:`hotspot-${p.id}`,mime:p.mime,storage_key:p.key,byte_size:bytes.length});
 return json({url:`/api/imo3d/assets/${p.id}`});
}
