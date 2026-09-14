import type {Tour} from '../model';
export type CloudAsset={id:string;tour_id:string;file:string;mime:string;storage_key:string;sha256:string|null;byte_size:number|null};
export type CloudOriginal={scene_id:string;tour_id:string;file:string;mime:string;width:number;height:number;storage_key:string;sha256:string|null;byte_size:number|null};
export type CloudBrandAsset={id:string;project_id:string;mime:string;storage_key:string;sha256:string;byte_size:number;created_at:string};
export type CloudPlanRef={tour_id:string;floor:number;job_id:string;storage_key:string;sha256:string;navigation:unknown;public_metadata:unknown;scene_ids:string[];input_hash:string};
export type CloudJob={id:string;tour_id:string;status:string;progress:number;stage:string;created_at:string;updated_at:string;input_hash:string;lease_owner?:string|null;lease_until:number;cancel_requested?:boolean;attempts?:number;error:string|null;result:unknown;warnings?:string[]};
export type SceneUploadAssets=Pick<CloudAsset,'id'|'file'|'mime'|'storage_key'> & Partial<Pick<CloudAsset,'sha256'|'byte_size'>>;
export type SceneUploadOriginal=Omit<CloudOriginal,'scene_id'|'tour_id'|'sha256'|'byte_size'> & Partial<Pick<CloudOriginal,'sha256'|'byte_size'>>;
export type CloudTourRow={id:string;project_id:string;revision:number;published:boolean;payload:Tour};
