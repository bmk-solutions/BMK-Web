import type {Tour} from '@/lib/imo3d/model';
import {api} from './client';
export type SignedPanoramaUpload={uploadId:string;url:string;token:string;bucket:string;objectKey:string;endpoint:string;expiresIn:number};
const CHUNK=6*1024*1024;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const allowedUploadURL=(candidate:string,endpoint:string)=>{const url=new URL(candidate,endpoint),base=new URL(endpoint);if(url.origin!==base.origin||!url.pathname.startsWith('/storage/v1/upload/resumable/sign'))throw Error('عنوان الرفع غير صالح.');return url.href;};
/** TUS offset confirmation prevents replaying a chunk after a lost response. */
export async function uploadResumable(file:File,session:SignedPanoramaUpload,onProgress?:(fraction:number)=>void){
 const endpoint=new URL(session.endpoint);if(endpoint.protocol!=='https:'||!endpoint.hostname.endsWith('.storage.supabase.co')||endpoint.pathname!=='/storage/v1/upload/resumable/sign')throw Error('عنوان التخزين غير صالح.');
 const headers={'Tus-Resumable':'1.0.0','x-signature':session.token};
 const metadata=Object.entries({bucketName:session.bucket,objectName:session.objectKey,contentType:file.type,cacheControl:'3600'}).map(([key,value])=>`${key} ${btoa(value)}`).join(',');
 let location='';
 for(let attempt=0;attempt<3;attempt++){
  try{const response=await fetch(endpoint,{method:'POST',credentials:'omit',headers:{...headers,'Upload-Length':String(file.size),'Upload-Metadata':metadata},signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('تعذر بدء رفع الصورة إلى التخزين.');const value=response.headers.get('Location');if(!value)throw Error('لم يصل عنوان متابعة الرفع.');location=allowedUploadURL(value,endpoint.href);break;}catch(error){if(attempt===2)throw error;await delay(1500*(attempt+1));}
 }
 let offset=0;
 while(offset<file.size){
  let confirmed=false;
  for(let attempt=0;attempt<4;attempt++){
   try{
    const head=await fetch(location,{method:'HEAD',credentials:'omit',headers,signal:AbortSignal.timeout(30000)});if(!head.ok)throw Error('تعذر التحقق من الجزء المرفوع.');
    const value=head.headers.get('Upload-Offset');const next=value===null?NaN:Number(value);if(!Number.isSafeInteger(next)||next<offset||next>file.size)throw Error('موضع استئناف الرفع غير صالح.');offset=next;if(offset===file.size){confirmed=true;break;}
    const end=Math.min(offset+CHUNK,file.size);
    const response=await fetch(location,{method:'PATCH',credentials:'omit',headers:{...headers,'Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:file.slice(offset,end),signal:AbortSignal.timeout(120000)});
    if(!response.ok||Number(response.headers.get('Upload-Offset'))!==end)throw Error('توقف الاتصال أثناء رفع الصورة.');
    offset=end;onProgress?.(offset/file.size);confirmed=true;break;
   }catch(error){if(attempt===3)throw error;await delay(1500*(attempt+1));}
  }
  if(!confirmed)throw Error('تعذر إكمال رفع الصورة.');
 }
 onProgress?.(1);
}
export async function uploadPanorama(tour:Tour,file:File,floor:number,onProgress?:(fraction:number)=>void){
 if(file.size>100*1024*1024)throw Error('الحد الأقصى للصورة 100 MiB.');
 const mode=await api<{cloud?:boolean}>('session');
 if(!mode.cloud){const body=new FormData();body.set('file',file);body.set('floor',String(floor));return api<Tour>(`tours/${tour.id}/images`,{method:'POST',body});}
 const signed=await api<SignedPanoramaUpload>(`tours/${tour.id}/images-init`,{method:'POST',body:JSON.stringify({name:file.name,size:file.size,type:file.type,floor,revision:tour.revision})});
 await uploadResumable(file,signed,onProgress);
 for(let attempt=0;;attempt++){
  try{return await api<Tour>(`tours/${tour.id}/images-finalize`,{method:'POST',body:JSON.stringify({uploadId:signed.uploadId,revision:tour.revision})});}catch(error){if(attempt>=2)throw error;await delay(2000*(attempt+1));}
 }
}

