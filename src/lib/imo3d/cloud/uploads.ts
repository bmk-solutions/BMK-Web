import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {Scene,Tour} from '../model';
import {initialRoomSemantic} from '../room-semantics';
import {mergeTourSpatial} from '../tour-merge';
import {cloudConfig,cloudObjectPath,cloudQuery,cloudRpc,cloudSignedUpload,cloudUploadObject} from './client';
import {CloudHTTPError,fail,json,readJSON} from './http';
import {MAX_PANORAMA_BYTES,MAX_PANORAMA_PIXELS,panoramaProblem,uploadConflict,uploadFinalizeSchema,uploadInitSchema} from './upload-policy';

type Session={id:string;tour_id:string;name:string;size:number;mime:string;floor:number;object_key:string;scene_id:string;status:string;expires_at:string;lease_token:string|null};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function originalBytes(session:Session){
 const {url,bucket,serviceRoleKey}=cloudConfig();
 const response=await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${cloudObjectPath(session.object_key)}`,{cache:'no-store',headers:{apikey:serviceRoleKey,Authorization:`Bearer ${serviceRoleKey}`},signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw new CloudHTTPError('لم يكتمل رفع الصورة بعد. أعد المحاولة.',409);
 if(Number(response.headers.get('content-length'))>MAX_PANORAMA_BYTES)throw new CloudHTTPError('حجم الصورة يتجاوز 100 MiB.',413);
 const reader=response.body?.getReader();if(!reader)throw new CloudHTTPError('ملف الصورة فارغ.',422);
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>session.size||size>MAX_PANORAMA_BYTES){await reader.cancel();throw new CloudHTTPError('حجم الصورة المرفوعة لا يطابق الملف المختار.',413);}chunks.push(value);}
 if(size!==session.size)throw new CloudHTTPError('الصورة المرفوعة غير مكتملة.',422);
 return Buffer.concat(chunks);
}
/** Only called after route authentication, project scope and same-origin checks. */
export async function handleCloudUpload(request:Request,tour:Tour):Promise<Response>{
 const action=new URL(request.url).pathname.split('/').pop();
 if(action==='images')return fail('ارفع الصورة مباشرة إلى التخزين عبر images-init ثم images-finalize.',413);
 if(action==='images-init'){
  const input=uploadInitSchema.parse(await readJSON(request));const conflict=uploadConflict(tour,input);if(conflict)return fail(conflict,409);
  const id=randomUUID(),sceneId=randomUUID(),objectKey=`uploads/${tour.id}/${id}/original`;
  await cloudRpc('begin_upload',{p_id:id,p_tour_id:tour.id,p_revision:input.revision,p_name:input.name,p_size:input.size,p_mime:input.type,p_floor:input.floor,p_object_key:objectKey,p_scene_id:sceneId});
  const signed=await cloudSignedUpload(objectKey);const config=cloudConfig();const storageHost=new URL(config.url).hostname.replace('.supabase.co','.storage.supabase.co');
  return json({uploadId:id,url:signed.url,token:signed.token,bucket:config.bucket,objectKey,endpoint:`https://${storageHost}/storage/v1/upload/resumable/sign`,expiresIn:7200},201);
 }
 if(action!=='images-finalize')return fail('المسار غير موجود.',404);
 const input=uploadFinalizeSchema.parse(await readJSON(request));
 const rows=await cloudQuery<Session[]>('upload_sessions',`id=eq.${input.uploadId}&tour_id=eq.${tour.id}&limit=1`);const session=rows[0];
 if(!session)return fail('جلسة الرفع غير موجودة.',404);
 if(session.status==='completed')return json(tour);
 const conflict=uploadConflict(tour,{name:session.name,revision:input.revision});if(conflict)return fail(conflict,409);
 const lease=randomUUID();await cloudRpc('claim_upload',{p_id:session.id,p_tour_id:tour.id,p_revision:input.revision,p_lease:lease});
 try{
  const bytes=await originalBytes(session);
  let meta:sharp.Metadata;try{meta=await sharp(bytes,{limitInputPixels:MAX_PANORAMA_PIXELS,animated:false}).metadata();}catch{throw new CloudHTTPError('تعذر قراءة الصورة أو دقتها تتجاوز الحد الآمن.',422);}
  const problem=panoramaProblem(meta);if(problem)throw new CloudHTTPError(problem,422);
  const variants:Record<string,string>={},assets:Record<string,unknown>[]=[];let detail:Scene['detail'];
  for(const [kind,width,quality] of [['image',4096,86],['preview',2048,78],['thumbnail',512,72],...(meta.width!>4096?[['detail',8192,94] as const]:[])] as const){
   const id=randomUUID(),key=`tours/${tour.id}/scenes/${session.scene_id}/${lease}/${id}.webp`;
   const output=await sharp(bytes,{limitInputPixels:MAX_PANORAMA_PIXELS,animated:false}).rotate().resize({width,withoutEnlargement:true}).webp({quality}).toBuffer({resolveWithObject:true});
   await cloudUploadObject(key,output.data,'image/webp');assets.push({id,file:`${id}.webp`,mime:'image/webp',storage_key:key,sha256:hash(output.data),byte_size:output.data.length});
   variants[kind]=`/api/imo3d/assets/${id}`;if(kind==='detail')detail={image:variants[kind],width:output.info.width,height:output.info.height};
  }
  const scene:Scene={id:session.scene_id,name:session.name.replace(/\.[^.]+$/,'').trim().slice(0,100)||'لقطة 360',sourceName:session.name,room:'لقطات تحتاج تسمية',roomSemantic:initialRoomSemantic(session.scene_id),floor:session.floor,image:variants.image,preview:variants.preview,thumbnail:variants.thumbnail,...(detail?{detail}:{}),position:null,yaw:0,links:[]};
  const prepared:Tour={...tour,...mergeTourSpatial(tour,[...tour.scenes,scene])};
  const preparedScene=prepared.scenes.find(value=>value.id===scene.id);if(!preparedScene)throw new CloudHTTPError("تعذر إتمام دمج اللقطة في الجولة.",422);
  const saved=await cloudRpc<Tour>('commit_upload_v2',{p_id:session.id,p_tour_id:tour.id,p_lease:lease,p_expected_revision:input.revision,p_tour:prepared,p_scene:preparedScene,p_assets:assets,p_original:{file:`${session.scene_id}.original.${meta.format}`,mime:`image/${meta.format}`,width:meta.width,height:meta.height,storage_key:session.object_key,sha256:hash(bytes),byte_size:bytes.length}});
  return json(saved,201);
 }catch(error){await cloudRpc('release_upload',{p_id:session.id,p_lease:lease}).catch(()=>{});throw error;}
}

