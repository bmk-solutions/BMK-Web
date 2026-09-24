import type {Plan,Scene,SurfaceModel} from "./model";
import type {JointPoint} from "./joint-depth";
import {storedAssetPath} from "./base-path.ts";

export const surfaceModelMime="application/vnd.imo3d.points";
export const surfaceHeaderBytes=16,surfaceRecordBytes=20,maxSurfacePoints=150_000;
const magic=0x534f4d49; // IMOS, little endian
const finiteCoordinate=(value:number)=>Number.isFinite(value)&&Math.abs(value)<=1000;

/** Color/normal samples describe observed geometry only, in relative camera units. */
export function encodeSurfaceModel(points:readonly JointPoint[],floorHeight:number):Uint8Array{
  if(!points.length||points.length>maxSurfacePoints||!finiteCoordinate(floorHeight))throw new Error("Invalid surface model bounds");
  const bytes=new Uint8Array(surfaceHeaderBytes+points.length*surfaceRecordBytes),view=new DataView(bytes.buffer);
  view.setUint32(0,magic,true);view.setUint16(4,1,true);view.setUint16(6,surfaceRecordBytes,true);view.setUint32(8,points.length,true);view.setFloat32(12,floorHeight,true);
  points.forEach((point,index)=>{
    if(![point.x,point.y,point.z].every(finiteCoordinate)||![point.r,point.g,point.b].every(v=>Number.isInteger(v)&&v>=0&&v<=255)||!Number.isFinite(point.confidence)||point.confidence<.45||point.confidence>1||new Set(point.sceneIds).size<2)throw new Error("Invalid surface sample");
    const offset=surfaceHeaderBytes+index*surfaceRecordBytes;
    view.setFloat32(offset,point.x,true);view.setFloat32(offset+4,point.y,true);view.setFloat32(offset+8,point.z,true);
    view.setUint8(offset+12,point.r);view.setUint8(offset+13,point.g);view.setUint8(offset+14,point.b);view.setUint8(offset+15,Math.round(point.confidence*255));
    const normal=point.normal;if(normal&&[normal.x,normal.y,normal.z].every(Number.isFinite)&&Math.abs(Math.hypot(normal.x,normal.y,normal.z)-1)<.02){view.setInt8(offset+16,Math.round(normal.x*127));view.setInt8(offset+17,Math.round(normal.y*127));view.setInt8(offset+18,Math.round(normal.z*127));}
  });return bytes;
}

export function decodeSurfaceModel(buffer:ArrayBuffer):{count:number;floorHeight:number;positions:Float32Array;colors:Uint8Array;normals:Float32Array;confidence:Uint8Array}{
  if(buffer.byteLength<surfaceHeaderBytes||buffer.byteLength>surfaceHeaderBytes+maxSurfacePoints*surfaceRecordBytes)throw new Error("Invalid surface model size");
  const view=new DataView(buffer),count=view.getUint32(8,true),floorHeight=view.getFloat32(12,true);
  if(view.getUint32(0,true)!==magic||view.getUint16(4,true)!==1||view.getUint16(6,true)!==surfaceRecordBytes||!count||count>maxSurfacePoints||buffer.byteLength!==surfaceHeaderBytes+count*surfaceRecordBytes||!finiteCoordinate(floorHeight))throw new Error("Invalid surface model header");
  const positions=new Float32Array(count*3),colors=new Uint8Array(count*3),normals=new Float32Array(count*3),confidence=new Uint8Array(count);
  for(let index=0;index<count;index++){
    const offset=surfaceHeaderBytes+index*surfaceRecordBytes;
    for(let axis=0;axis<3;axis++){const value=view.getFloat32(offset+axis*4,true);if(!finiteCoordinate(value))throw new Error("Invalid surface coordinate");positions[index*3+axis]=value;colors[index*3+axis]=view.getUint8(offset+12+axis);normals[index*3+axis]=view.getInt8(offset+16+axis)/127;}
    confidence[index]=view.getUint8(offset+15);if(confidence[index]<114)throw new Error("Unsupported surface sample");
  }return{count,floorHeight,positions,colors,normals,confidence};
}

/** A moved, replaced or deleted source camera invalidates its photographic model. */
export function currentSurfaceModel(plan:Pick<Plan,"floor"|"surfaceModel">,scenes:readonly Scene[]):SurfaceModel|undefined{
  const model=plan.surfaceModel;
  if(!model||model.source!=="da3-base-pose-conditioned-multiview"||model.units!=="camera_height"||!/^\/api\/imo3d\/assets\/[\w-]{1,80}$/.test(storedAssetPath(model.url))||!Number.isInteger(model.pointCount)||model.pointCount<1||model.pointCount>maxSurfacePoints||!finiteCoordinate(model.floorHeight)||!Array.isArray(model.cameras)||model.cameras.length<2||model.cameras.length>300||model.cameras.some(camera=>!camera||typeof camera!=="object")||new Set(model.cameras.map(camera=>camera.id)).size!==model.cameras.length)return;
  const byId=new Map(scenes.map(scene=>[scene.id,scene]));
  for(const camera of model.cameras){const scene=byId.get(camera.id);if(!scene||scene.floor!==plan.floor||scene.image!==camera.image||!scene.position||!camera.position||![camera.position.x,camera.position.y,camera.position.z,camera.yaw].every(Number.isFinite)||scene.yaw!==camera.yaw||["x","y","z"].some(axis=>scene.position![axis as "x"|"y"|"z"]!==camera.position[axis as "x"|"y"|"z"]))return;}
  return model;
}

export function surfaceModelFloorHeight(points:readonly JointPoint[],scenes:readonly Pick<Scene,"position">[]):number{
  const floor=points.filter(point=>(point.floorConfidence??0)>=.5).map(point=>point.y).filter(finiteCoordinate).sort((a,b)=>a-b);
  if(floor.length>=50)return floor[Math.floor(floor.length/2)];
  const centers=scenes.flatMap(scene=>scene.position?[scene.position.y]:[]).sort((a,b)=>a-b);return(centers[Math.floor(centers.length/2)]??0)-1;
}
