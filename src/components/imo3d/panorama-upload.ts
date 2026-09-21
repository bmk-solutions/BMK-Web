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
 let offset=0,needsConfirmation=false;
 while(offset<file.size){
  let confirmed=false;
  for(let attempt=0;attempt<4;attempt++){
   try{
    if(needsConfirmation){const head=await fetch(location,{method:'HEAD',credentials:'omit',headers,signal:AbortSignal.timeout(30000)});if(!head.ok)throw Error('تعذر التحقق من الجزء المرفوع.');
    const value=head.headers.get('Upload-Offset');const next=value===null?NaN:Number(value);if(!Number.isSafeInteger(next)||next<offset||next>file.size)throw Error('موضع استئناف الرفع غير صالح.');offset=next;needsConfirmation=false;if(offset===file.size){confirmed=true;break;}}
    const end=Math.min(offset+CHUNK,file.size);
    const response=await fetch(location,{method:'PATCH',credentials:'omit',headers:{...headers,'Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:file.slice(offset,end),signal:AbortSignal.timeout(120000)});
    if(!response.ok||Number(response.headers.get('Upload-Offset'))!==end)throw Error('توقف الاتصال أثناء رفع الصورة.');
    offset=end;onProgress?.(offset/file.size);confirmed=true;break;
   }catch(error){needsConfirmation=true;if(attempt===3)throw error;await delay(1500*(attempt+1));}
  }
  if(!confirmed)throw Error('تعذر إكمال رفع الصورة.');
 }
 onProgress?.(1);
}
export type UploadProgress={done:number;total:number;uploadedBytes:number;totalBytes:number;stage:'uploading'|'preparing'};
type UploadFailure={file:File;message:string};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'فشل الرفع';
/** Three original transfers overlap; ordered commits preserve scene order and revisions. */
export async function uploadPanoramas(initial:Tour,files:File[],floor:number,options:{onSaved:(tour:Tour)=>void;onProgress?:(progress:UploadProgress)=>void;isActive?:()=>boolean}){
 const mode=await api<{cloud?:boolean}>('session');let tour=initial,done=0,uploaded=0;
 const failures:UploadFailure[]=[],bytes=files.map(()=>0),totalBytes=files.reduce((sum,file)=>sum+file.size,0);
 const report=(stage:UploadProgress['stage'])=>options.onProgress?.({done,total:files.length,uploadedBytes:bytes.reduce((a,b)=>a+b,0),totalBytes,stage});
 const validate=(file:File)=>{if(file.size>100*1024*1024)throw Error('الحد الأقصى للصورة 100 MiB.');if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('اختر صورة JPG أو PNG أو WEBP.');};
 const save=(updated:Tour)=>{tour=updated;uploaded++;options.onSaved(updated);};
 if(!mode.cloud){
  for(let index=0;index<files.length;index++){
   if(options.isActive&&!options.isActive())break;
   const file=files[index];try{validate(file);const body=new FormData();body.set('file',file);body.set('floor',String(floor));save(await api<Tour>(`tours/${tour.id}/images`,{method:'POST',body}));bytes[index]=file.size;}catch(error){failures.push({file,message:errorMessage(error)});}done++;report('uploading');
  }
 }else{
  type Transfer={session?:SignedPanoramaUpload;error?:string};
  const transfers=new Map<number,Promise<Transfer>>();
  // Reserve only while no commit is running. Transfer the next original while
  // the previous images are being prepared; never wait for an entire batch.
  const reserve=async(index:number)=>{
   const file=files[index];let session:SignedPanoramaUpload;
   try{validate(file);session=await api<SignedPanoramaUpload>(`tours/${tour.id}/images-init`,{method:'POST',body:JSON.stringify({name:file.name,size:file.size,type:file.type,floor,revision:tour.revision})});}
   catch(error){transfers.set(index,Promise.resolve({error:errorMessage(error)}));return;}
   transfers.set(index,uploadResumable(file,session,fraction=>{bytes[index]=fraction*file.size;report('uploading');}).then(()=>({session}),error=>({error:errorMessage(error)})));
  };
  if(!options.isActive||options.isActive())await Promise.all(files.slice(0,3).map((_,index)=>reserve(index)));
  for(let index=0;transfers.has(index);index++){
   const transfer=await transfers.get(index)!;transfers.delete(index);
   try{
    if(!transfer.session)throw Error(transfer.error);
    report('preparing');
    for(let attempt=0;;attempt++){try{save(await api<Tour>(`tours/${tour.id}/images-finalize`,{method:'POST',body:JSON.stringify({uploadId:transfer.session.uploadId,revision:tour.revision})}));break;}catch(error){if(attempt>=2)throw error;await delay(2000*(attempt+1));}}
   }catch(error){failures.push({file:files[index],message:errorMessage(error)});}
   done++;report('uploading');
   if(index+3<files.length&&(!options.isActive||options.isActive()))await reserve(index+3);
  }
 }
 return {tour,uploaded,failures};
}
export async function uploadPanorama(tour:Tour,file:File,floor:number,onProgress?:(fraction:number)=>void){
 const result=await uploadPanoramas(tour,[file],floor,{onSaved:()=>{},onProgress:progress=>onProgress?.(progress.uploadedBytes/file.size)});
 if(result.failures.length)throw Error(result.failures[0].message);return result.tour;
}
