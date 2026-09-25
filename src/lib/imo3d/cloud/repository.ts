import {randomUUID} from 'node:crypto';
import type {Project,Tour} from '../model';
import {cloudQuery,cloudRpc} from './client';
import type {CloudAsset,CloudOriginal,CloudPlanRef,CloudJob,CloudTourRow,SceneUploadAssets,SceneUploadOriginal} from './types';
const eq=(value:string)=>encodeURIComponent(value);
export async function getTour(id:string):Promise<Tour|null>{return (await cloudQuery<CloudTourRow[]>('tours',`id=eq.${eq(id)}&select=payload&limit=1`))[0]?.payload??null;}
export async function listTours(projectId?:string):Promise<Tour[]>{return (await cloudQuery<CloudTourRow[]>('tours',`select=payload${projectId?`&project_id=eq.${eq(projectId)}`:''}`)).map(row=>row.payload);}
/** Dashboard projection omits heavy render arrays before the database response. */
export async function listTourSummaries(projectId?:string):Promise<Tour[]>{return cloudRpc<Tour[]>('list_tour_summaries',{p_project_id:projectId??null});}
export async function listProjects():Promise<Project[]>{
  const [projects,links]=await Promise.all([cloudQuery<{id:string;name:string;location:string;created_at:string}[]>('projects','select=*&order=created_at.desc'),cloudQuery<{project_id:string;developer_id:string}[]>('project_developers','select=*')]);
  const developers=new Map(links.map(row=>[row.project_id,row.developer_id]));return projects.map(row=>({id:row.id,name:row.name,location:row.location,createdAt:row.created_at,...(developers.has(row.id)?{developerId:developers.get(row.id)}:{})}));
}
export async function createProject(name:string,location:string,developerId?:string|null):Promise<Project>{
  return cloudRpc<Project>('create_project',{p_id:randomUUID(),p_name:name,p_location:location,p_developer_id:developerId??null});
}
export async function saveTour(tour:Tour,expectedRevision?:number):Promise<Tour>{return cloudRpc<Tour>('save_tour',{p_tour:tour,p_expected_revision:expectedRevision??null});}
export async function deleteTour(id:string,expectedRevision?:number):Promise<string[]>{return cloudRpc<string[]>('delete_tour',{p_tour_id:id,p_expected_revision:expectedRevision??null});}
export async function deleteProject(id:string):Promise<string[]>{return cloudRpc<string[]>('delete_project',{p_project_id:id});}
export async function commitSceneUpload(tourId:string,expectedRevision:number,scene:Tour['scenes'][number],assets:SceneUploadAssets[],original:SceneUploadOriginal):Promise<Tour>{return cloudRpc<Tour>('commit_scene_upload',{p_tour_id:tourId,p_expected_revision:expectedRevision,p_scene:scene,p_assets:assets,p_original:original});}
export async function getAsset(id:string):Promise<CloudAsset|null>{return (await cloudQuery<CloudAsset[]>('assets',`id=eq.${eq(id)}&limit=1`))[0]??null;}
export async function getOriginal(sceneId:string):Promise<CloudOriginal|null>{return (await cloudQuery<CloudOriginal[]>('scene_originals',`scene_id=eq.${eq(sceneId)}&limit=1`))[0]??null;}
export async function latestAIPlan(tourId:string):Promise<CloudJob|null>{return (await cloudQuery<CloudJob[]>('ai_plan_jobs',`tour_id=eq.${eq(tourId)}&order=created_at.desc,id.desc&limit=1`))[0]??null;}
export async function getPlanRefs(tourId:string):Promise<CloudPlanRef[]>{return cloudQuery<CloudPlanRef[]>('approved_plan_refs',`tour_id=eq.${eq(tourId)}&order=floor.asc`);}
export async function getBranding(projectId:string){
  const row=(await cloudQuery<{name:string;accent:string;logo_asset_id:string|null;logo_style:string}[]>('project_branding',`project_id=eq.${eq(projectId)}&limit=1`))[0];
  return row?{name:row.name,accent:row.accent,...(row.logo_asset_id?{logo:`/api/imo3d/branding-assets/${row.logo_asset_id}`}:{ }),logoStyle:row.logo_style as 'clean'|'original'}:{name:'IMO 3D',accent:'#24b18b'};
}
/** The project's own name and place, for the buyer's title and the shared card. */
export async function getProjectCard(projectId:string):Promise<{name:string;location:string}|null>{return (await cloudQuery<{name:string;location:string}[]>('projects',`id=eq.${eq(projectId)}&select=name,location&limit=1`))[0]??null;}
export async function withinRateLimit(key:string,limit:number,windowMs:number){return cloudRpc<boolean>('rate_limit',{p_key:key,p_limit:limit,p_window_ms:windowMs});}
