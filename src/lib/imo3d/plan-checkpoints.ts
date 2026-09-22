import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';

// A changed image, floor, tour or pipeline version must never reuse a different analysis.
export function planCheckpointDirectory(root:string,tourId:string,inputHash:string){
 const key=createHash('sha256').update(JSON.stringify(['photo-plan-v3',tourId,inputHash])).digest('hex');
 return path.join(root,'work','subscription-plan-cache',key);
}
export async function readPlanCheckpoint<T>(directory:string,name:string,validate:(value:unknown)=>T):Promise<T|null>{
 try{return validate(JSON.parse(await readFile(path.join(directory,name+'.json'),'utf8')));}catch{return null;}
}
export async function savePlanCheckpoint(directory:string,name:string,value:unknown){
 await mkdir(directory,{recursive:true});
 const target=path.join(directory,name+'.json'),temporary=target+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value));await rename(temporary,target);
}
/** Geometry repair reuses the complete photo transcript; attach diverse views of
 * every identified room instead of repeating all near-identical capture stops. */
export function selectPlanRepairPhotos<T extends {sceneId:string;floor:number}>(photos:readonly T[],floors:readonly {floor:number;layout:{rooms:readonly {evidenceSceneIds:readonly string[]}[]}}[],budget=48):T[]{
 if(photos.length<=budget)return [...photos];
 const byId=new Map(photos.map((p,i)=>[p.sceneId,{p,i}])),selected=new Set<string>();
 const groups=floors.flatMap(f=>f.layout.rooms.map(r=>r.evidenceSceneIds.filter(id=>byId.get(id)?.p.floor===f.floor).sort((a,b)=>byId.get(a)!.i-byId.get(b)!.i))).filter(g=>g.length);
 // Room/floor coverage takes priority over a soft attachment budget.
 for(const group of groups)selected.add(group[0]);
 for(const floor of new Set(photos.map(p=>p.floor)))selected.add(photos.find(p=>p.floor===floor)!.sceneId);
 for(const group of groups)if(selected.size<budget)selected.add(group.at(-1)!);
 for(const group of groups)if(selected.size<budget)selected.add(group[Math.floor(group.length/2)]);
 // Spread remaining evidence across capture order when room grouping is incomplete.
 const covered=new Set(groups.flat()),uncovered=photos.filter(p=>!covered.has(p.sceneId));
 const remaining=Math.max(0,budget-selected.size);
 for(let i=0;i<Math.min(remaining,uncovered.length);i++)selected.add(uncovered[Math.floor(i*uncovered.length/remaining)].sceneId);
 return photos.filter(p=>selected.has(p.sceneId));
}
/** Bounded workers retain input order and finish in-flight work before reporting an error. */
export async function preparePlanPhotos<T,R>(items:T[],prepare:(item:T,index:number)=>Promise<R>,concurrency=3):Promise<R[]>{
 const results:R[]=new Array(items.length);let next=0,failed=false,failure:unknown;
 await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,concurrency))},async()=>{
  while(!failed){const index=next++;if(index>=items.length)return;
   try{results[index]=await prepare(items[index],index);}catch(error){failed=true;failure=error;}
  }
 }));
 if(failed)throw failure;return results;
}

/** Cache each checked photo batch before synthesizing the apartment. A failed
 * batch does not discard evidence from batches already completed. */
export async function analyzePlanPhotoBatches<T extends {sceneId:string;floor:number},E extends {sceneId:string}>(options:{
 photos:readonly T[];cache:string;signal:AbortSignal;batchSize?:number;concurrency?:number;
 analyze:(photos:T[],index:number)=>Promise<E[]>;validate:(value:unknown)=>E[];
 progress?:(completed:number,total:number)=>Promise<void>;
}):Promise<E[]>{
 const {photos,cache,signal}=options,size=Math.max(1,Math.min(24,options.batchSize??12));
 const batches=Array.from({length:Math.ceil(photos.length/size)},(_,i)=>photos.slice(i*size,(i+1)*size));
 let completed=0,progress=Promise.resolve();
 const result=await preparePlanPhotos(batches,async(batch,index)=>{
  signal.throwIfAborted();
  const ids=new Set(batch.map(p=>p.sceneId));
  const validate=(raw:unknown)=>{
   const value=options.validate(raw);
   if(value.length!==batch.length||new Set(value.map(e=>e.sceneId)).size!==ids.size||value.some(e=>!ids.has(e.sceneId)))throw Error('PHOTO_COVERAGE');
   const byId=new Map(value.map(e=>[e.sceneId,e]));return batch.map(p=>byId.get(p.sceneId)!);
  };
  const key='photo-batch-v1-'+createHash('sha256').update(JSON.stringify(batch)).digest('hex');
  let evidence=await readPlanCheckpoint(cache,key,validate);
  if(!evidence){evidence=validate(await options.analyze(batch,index));signal.throwIfAborted();await savePlanCheckpoint(cache,key,evidence);}
  completed+=batch.length;const done=completed;
  progress=progress.then(()=>options.progress?.(done,photos.length));await progress;
  return evidence;
 },options.concurrency??2);
 signal.throwIfAborted();return result.flat();
}
