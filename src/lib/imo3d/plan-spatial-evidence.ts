import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {Tour} from './model';
import {aiPlanFingerprint} from './ai-plan-jobs.ts';
import {imageFingerprint} from './processing-jobs.ts';

const coord=z.number().finite().min(-10000).max(10000),id=z.string().regex(/^[\w-]{1,80}$/);
const point=z.object({x:coord,z:coord}),position=point.extend({y:coord});
const envelope=z.object({outline:z.array(point).min(3).max(128),confidence:z.number().min(0).max(1),scale:z.literal('camera_height'),classification:z.literal('estimated_room_envelope')});
const scene=z.object({id,floor:z.number().int(),component:id,position:position.nullable(),yaw:z.number().finite(),roomEnvelope:envelope.optional()});
const room=envelope.extend({sceneIds:z.array(id).min(1).max(300),floor:z.number().int(),component:id,frame:z.literal('component')});
const component=z.object({id,sceneIds:z.array(id).min(1).max(300),layout:z.enum(['relative_reconstruction','topology_only']),scaleBasis:z.enum(['camera_height','unscaled']).optional(),rooms:z.array(room).max(300).optional()});
const geometrySchema=z.object({version:z.literal(1),scale:z.literal('relative'),scenes:z.array(scene).min(2).max(300),components:z.array(component).min(1).max(300)});
const packetSchema=z.object({version:z.literal(1),tourId:id,projectId:id,inputHash:z.string().length(64),cameraHash:z.string().length(64),geometry:geometrySchema});
export type PlanSpatialEvidence=z.infer<typeof packetSchema>;

/** Geometry hypotheses retain their independent frames; no inferred metric or access claim. */
export function buildPlanSpatialEvidence(tour:Tour,raw:unknown):PlanSpatialEvidence{
 const geometry=geometrySchema.parse(raw),byScene=new Map(tour.scenes.map(s=>[s.id,s]));
 if(geometry.scenes.length!==byScene.size||new Set(geometry.scenes.map(s=>s.id)).size!==byScene.size||geometry.scenes.some(s=>byScene.get(s.id)?.floor!==s.floor))throw Error('SPATIAL_PHOTO_MISMATCH');
 const frames=new Map(geometry.components.map(c=>[c.id,c]));
 const members=geometry.components.flatMap(c=>c.sceneIds);
 if(frames.size!==geometry.components.length||members.length!==byScene.size||new Set(members).size!==byScene.size)throw Error('SPATIAL_FRAME_MISMATCH');
 for(const s of geometry.scenes)if(!frames.get(s.component)?.sceneIds.includes(s.id))throw Error('SPATIAL_FRAME_MISMATCH');
 for(const c of geometry.components)for(const r of c.rooms??[])if(r.component!==c.id||r.sceneIds.some(s=>!c.sceneIds.includes(s)||byScene.get(s)?.floor!==r.floor))throw Error('SPATIAL_ROOM_MISMATCH');
 return {version:1,tourId:tour.id,projectId:tour.projectId,inputHash:aiPlanFingerprint(tour.scenes),cameraHash:imageFingerprint(tour.scenes),geometry};
}
function fileFor(root:string,tour:Tour){
 const key=createHash('sha256').update(JSON.stringify([tour.projectId,tour.id,aiPlanFingerprint(tour.scenes)])).digest('hex');
 return path.join(root,'work','plan-spatial-evidence',key+'.json');
}
export async function savePlanSpatialEvidence(root:string,tour:Tour,raw:unknown){
 const packet=buildPlanSpatialEvidence(tour,raw),file=fileFor(root,tour),temporary=file+'.'+randomUUID()+'.tmp';
 await mkdir(path.dirname(file),{recursive:true});await writeFile(temporary,JSON.stringify(packet),{flag:'wx'});await rename(temporary,file);return packet;
}
export async function readPlanSpatialEvidence(root:string,tour:Tour):Promise<PlanSpatialEvidence|null>{
 try{
  const file=fileFor(root,tour),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)return null;
  const packet=packetSchema.parse(JSON.parse(await readFile(file,'utf8')));
  if(packet.tourId!==tour.id||packet.projectId!==tour.projectId||packet.inputHash!==aiPlanFingerprint(tour.scenes)||packet.cameraHash!==imageFingerprint(tour.scenes))return null;
  return buildPlanSpatialEvidence(tour,packet.geometry);
 }catch{return null;}
}
