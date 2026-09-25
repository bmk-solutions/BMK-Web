import type {AIPlanJob} from '@/lib/imo3d/ai-plan-jobs';
export type ViewerPlanEntry={status:{job:AIPlanJob|null;stale:boolean}|null;src?:string;updated:number};
/** `mini`: a ≤600 px WebP for the compact map; `webp`: the plan at full size for the dialog. The PNG is only opened on request. */
export type ViewerPlanVariant='mini'|'webp';
export const planImageURL=(base:string,jobId:string,floor:number,variant?:ViewerPlanVariant)=>`${base}/image?job=${encodeURIComponent(jobId)}&floor=${floor}${variant?`&variant=${variant}`:''}`;

/** Private, viewer-scoped cache: never shares an authenticated plan across sessions. */
export function createViewerPlanCache(){
 const entries=new Map<string,ViewerPlanEntry>(),pending=new Map<string,Promise<ViewerPlanEntry>>();
 const images=new Map<string,string>();let generation=0;
 const id=(key:string,variant:ViewerPlanVariant)=>`${key}#${variant}`;
 return {
  peek:(key:string,variant:ViewerPlanVariant='webp')=>entries.get(id(key,variant)),
  async get(key:string,variant:ViewerPlanVariant='webp'):Promise<ViewerPlanEntry>{
   const slot=id(key,variant),old=entries.get(slot);if(old&&Date.now()-old.updated<15000)return old;
   const inflight=pending.get(slot);if(inflight)return inflight;
   const version=generation;
   const request=(async()=>{
    const response=await fetch(key,{cache:'no-store'});
    if(response.status===401||response.status===403||response.status===404){const entry={status:null,updated:Date.now()};if(version===generation)entries.set(slot,entry);return entry;}
    if(!response.ok)throw Error('تعذر تحميل المخطط. حاول مرة أخرى.');
    const status:NonNullable<ViewerPlanEntry['status']>=await response.json();
    const floor=Number(new URL(key,location.origin).searchParams.get('floor'));
    const job=status.job,draft=job?.status==='draft'&&!status.stale?job.result?.floors.find(item=>item.floor===floor):undefined;
    let src:string|undefined;
    if(draft&&job){
     const imageUrl=planImageURL(key.split('?')[0],job.id,floor,variant);
     src=images.get(imageUrl);
     if(!src){
      const image=await fetch(imageUrl);if(!image.ok)throw Error('تعذر تحميل صورة المخطط.');
      const blob=await image.blob();if(version!==generation)throw Error('انتهت معاينة المخطط.');
      src=URL.createObjectURL(blob);images.set(imageUrl,src);
     }
    }
    const entry={status,src,updated:Date.now()};if(version===generation)entries.set(slot,entry);return entry;
   })();
   pending.set(slot,request);
   try{return await request;}finally{if(pending.get(slot)===request)pending.delete(slot);}
  },
  dispose(){generation++;for(const src of images.values())URL.revokeObjectURL(src);images.clear();entries.clear();pending.clear();}
 };
}
export type ViewerPlanCache=ReturnType<typeof createViewerPlanCache>;
