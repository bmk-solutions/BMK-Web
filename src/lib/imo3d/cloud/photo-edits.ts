import {randomUUID} from 'node:crypto';
import type {Tour} from '../model';
import {changePhotoEdit} from '../photo-edits';
import {json,fail,readJSON} from './http';
import {saveTour} from './repository';
import {subscriptionPlanStatus} from './subscription-plans';
export async function cloudPhotoEdits(request:Request,tour:Tour){
 if(request.method==='GET'){const worker=await subscriptionPlanStatus(tour);return json({jobs:tour.photoEdits??[],workerOnline:worker.workerOnline,revision:tour.revision});}
 if(request.method!=='POST')return fail('العملية غير متاحة.',405);
 const input=await readJSON(request,6000);
 try{return json(await saveTour(changePhotoEdit(tour,input,randomUUID()),tour.revision));}catch(error){if(error instanceof Error&&!('code' in error))return fail(error.message,409);throw error;}
}
