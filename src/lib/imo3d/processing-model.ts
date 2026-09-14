export type ProcessingStatus="queued"|"running"|"completed"|"review"|"failed"|"cancelled"|"stale";
export type ProcessingJob={
  id:string;tourId:string;status:ProcessingStatus;progress:number;stage:string;
  createdAt:string;updatedAt:string;error:string|null;warnings:string[];
  result?:{registered:number;total:number;links:number;components:number;scale:"relative"|"metric";boundaryPhotos?:number;recognizedPhotos?:number;rooms?:number;jointDepthPhotos?:number;jointPoints?:number};
};
export const processingActive=(job:ProcessingJob|null|undefined)=>job?.status==="queued"||job?.status==="running";
