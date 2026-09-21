import type {AIPlanJob} from '@/lib/imo3d/ai-plan-jobs';
export type ViewerPlanEntry={status:{job:AIPlanJob|null;stale:boolean}|null;src?:string;updated:number};

/** Private, viewer-scoped cache: never shares an authenticated plan across sessions. */
export function createViewerPlanCache(){
 const entries=new Map<string,ViewerPlanEntry>(),pending=new Map<string,Promise<ViewerPlanEntry>>();
 const images=new Map<string,string>();let generation=0;
 return {
  peek:(key:string)=>entries.get(key),
  async get(key:string):Promise<ViewerPlanEntry>{
   const old=entries.get(key);if(old&&Date.now()-old.updated<15000)return old;
   const inflight=pending.get(key);if(inflight)return inflight;
   const version=generation;
   const request=(async()=>{
    const response=await fetch(key,{cache:'no-store'});
    if(response.status===401||response.status===403||response.status===404){const entry={status:null,updated:Date.now()};if(version===generation)entries.set(key,entry);return entry;}
    if(!response.ok)throw Error('تعذر تحميل المخطط. حاول مرة أخرى.');
    const status:NonNullable<ViewerPlanEntry['status']>=await response.json();
    const floor=Number(new URL(key,location.origin).searchParams.get('floor'));
    const job=status.job,draft=job?.status==='draft'&&!status.stale?job.result?.floors.find(item=>item.floor===floor):undefined;
    let src:string|undefined;
    if(draft&&job){
     const imageUrl=key.split('?')[0]+`/image?job=${encodeURIComponent(job.id)}&floor=${floor}`;
     src=images.get(imageUrl);
     if(!src){
      const image=await fetch(imageUrl);if(!image.ok)throw Error('تعذر تحميل صورة المخطط.');
      const blob=await image.blob();if(version!==generation)throw Error('انتهت معاينة المخطط.');
      src=URL.createObjectURL(blob);images.set(imageUrl,src);
     }
    }
    const entry={status,src,updated:Date.now()};if(version===generation)entries.set(key,entry);return entry;
   })();
   pending.set(key,request);
   try{return await request;}finally{if(pending.get(key)===request)pending.delete(key);}
  },
  dispose(){generation++;for(const src of images.values())URL.revokeObjectURL(src);images.clear();entries.clear();pending.clear();}
 };
}
export type ViewerPlanCache=ReturnType<typeof createViewerPlanCache>;
