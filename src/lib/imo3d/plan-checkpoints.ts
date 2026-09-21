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
