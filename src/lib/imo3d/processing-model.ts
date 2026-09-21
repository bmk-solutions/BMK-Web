import {z} from "zod";
export type ProcessingStatus="queued"|"running"|"completed"|"review"|"failed"|"cancelled"|"stale";
export type ProcessingJob={
  id:string;tourId:string;status:ProcessingStatus;progress:number;stage:string;
  createdAt:string;updatedAt:string;error:string|null;warnings:string[];
  result?:{registered:number;total:number;links:number;components:number;scale:"relative"|"metric";boundaryPhotos?:number;recognizedPhotos?:number;rooms?:number;jointDepthPhotos?:number;jointPoints?:number};
};
export const processingActive=(job:ProcessingJob|null|undefined)=>job?.status==="queued"||job?.status==="running";

const processingJobResponse=z.object({
 id:z.string(),tourId:z.string(),status:z.enum(['queued','running','completed','review','failed','cancelled','stale']),
 progress:z.number().finite(),stage:z.string(),createdAt:z.string(),updatedAt:z.string(),error:z.string().nullable(),warnings:z.array(z.string()).default([]),
 result:z.object({registered:z.number(),total:z.number(),links:z.number(),components:z.number(),scale:z.enum(['relative','metric']),boundaryPhotos:z.number().optional(),recognizedPhotos:z.number().optional(),rooms:z.number().optional(),jointDepthPhotos:z.number().optional(),jointPoints:z.number().optional()}).optional(),
}).nullable();
/** Validate before updating React state: API versions may differ during deployment. */
export function parseProcessingJob(value:unknown):ProcessingJob|null{
 const parsed=processingJobResponse.safeParse(value);
 if(!parsed.success)throw Error('تعذر قراءة حالة المعالجة. أعد المحاولة أو حدّث الصفحة؛ صورك محفوظة.');
 return parsed.data;
}
