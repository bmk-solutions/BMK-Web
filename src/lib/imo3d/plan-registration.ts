import {z} from 'zod';
import type {RasterNavigation} from './ai-plan-jobs';

const point=z.object({x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1)});
export const planRegistrationSchema=z.object({
 points:z.array(point.extend({sceneId:z.string().min(1).max(80)})).min(1).max(500),
 outline:z.array(point).min(3).max(200),
}).strict();
/** Coordinates must refer to this final image and cover precisely this floor. */
export function validatePlanRegistration(value:unknown,sceneIds:string[]){
 const result=planRegistrationSchema.parse(value),ids=result.points.map(p=>p.sceneId);
 if(ids.length!==sceneIds.length||new Set(ids).size!==ids.length||ids.some(id=>!sceneIds.includes(id)))throw Error('REGISTRATION_COVERAGE');
 const area=result.outline.reduce((sum,p,i)=>{const next=result.outline[(i+1)%result.outline.length];return sum+p.x*next.y-next.x*p.y;},0);
 if(Math.abs(area)<.0001)throw Error('REGISTRATION_OUTLINE');
 return result;
}
export function imagePlanRegistration(value:unknown,sceneIds:string[],width:number,height:number):RasterNavigation{
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>20000||height>20000)throw Error('REGISTRATION_IMAGE_SIZE');
 return {...validatePlanRegistration(value,sceneIds),width,height,source:'reviewed-photo-registration'};
}
