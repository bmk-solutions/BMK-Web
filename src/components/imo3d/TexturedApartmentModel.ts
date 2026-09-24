import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import type {TexturedMesh} from "../../lib/imo3d/model";
import {maxMeshBytes,validateTexturedMeshGlb} from "../../lib/imo3d/mesh-model";
import {storedAssetPath} from "../../lib/imo3d/base-path";

export type ApartmentModelState={status:"unavailable"|"loading"|"ready"|"error";active:boolean};
const aborted=()=>new DOMException("أُلغي تحميل المجسّم.","AbortError");

/** Read one private, self-contained GLB; the parser never resolves remote resources. */
export async function loadApartmentMeshBytes(model:TexturedMesh,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<ArrayBuffer>{
  if(!/^\/api\/imo3d\/assets\/[\w-]{1,80}$/.test(storedAssetPath(model.url))||!Number.isInteger(model.byteLength)||model.byteLength<28||model.byteLength>maxMeshBytes)throw Error("ملف المجسّم غير صالح.");
  if(signal.aborted)throw aborted();
  const response=await fetcher(model.url,{signal,credentials:"same-origin",cache:"no-store",redirect:"error"});
  const length=response.headers.get("content-length");
  if(!response.ok||response.redirected||length!==null&&(!/^\d+$/.test(length)||Number(length)!==model.byteLength)){
    await response.body?.cancel().catch(()=>{});throw Error("تعذر تحميل المجسّم المحلي.");
  }
  if(!response.body)throw Error("ملف المجسّم فارغ.");
  const reader=response.body.getReader(),bytes=new Uint8Array(model.byteLength);let offset=0,complete=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{
    for(;;){if(signal.aborted)throw aborted();const result=await reader.read();if(result.done)break;if(offset+result.value.byteLength>bytes.length)throw Error("تجاوز ملف المجسّم الحجم المسموح.");bytes.set(result.value,offset);offset+=result.value.byteLength;}
    if(signal.aborted)throw aborted();if(offset!==bytes.length)throw Error("لم يكتمل تحميل المجسّم.");
    validateTexturedMeshGlb(bytes.buffer,model);complete=true;return bytes.buffer;
  }finally{signal.removeEventListener("abort",abort);if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Connected indexed surfaces with the apartment's own image textures. */
export class TexturedApartmentModel{
  readonly mesh:THREE.Group;
  private disposed=false;private cutHeight=Infinity;
  private plane=new THREE.Plane(new THREE.Vector3(0,-1,0),10000);
  private bounds=new THREE.Box3();private raycaster=new THREE.Raycaster();
  private geometries=new Set<THREE.BufferGeometry>();private materials=new Set<THREE.Material>();private textures=new Set<THREE.Texture>();
  constructor(group:THREE.Group,origin:{x:number;z:number},floorHeight:number){
    this.mesh=group;group.name="imo-textured-apartment";group.position.set(-origin.x,-floorHeight,-origin.z);
    group.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return;this.geometries.add(object.geometry);
      const originals=Array.isArray(object.material)?object.material:[object.material];
      const replacement=originals.map(original=>{
        const source=original as THREE.MeshStandardMaterial;
        if(source.map){source.map.colorSpace=THREE.SRGBColorSpace;source.map.anisotropy=4;this.textures.add(source.map);}
        // Photographs already contain the scene lighting; preserve those colors.
        const material=new THREE.MeshBasicMaterial({map:source.map,color:source.color??0xffffff,side:THREE.DoubleSide,clippingPlanes:[this.plane],toneMapped:false});
        this.materials.add(material);original.dispose();return material;
      });object.material=Array.isArray(object.material)?replacement:replacement[0];
    });
    group.updateMatrixWorld(true);this.bounds.setFromObject(group);
  }
  static async load(model:TexturedMesh,origin:{x:number;z:number},signal:AbortSignal){
    const bytes=await loadApartmentMeshBytes(model,signal);
    const manager=new THREE.LoadingManager();
    // GLB validation permits only embedded image bufferViews. A future loader
    // feature cannot quietly introduce an external request through this path.
    manager.setURLModifier(url=>{if(!url.startsWith("blob:"))throw Error("المجسّم يجب أن يحتوي موارده داخله.");return url;});
    const result=await new GLTFLoader(manager).parseAsync(bytes,"");
    const apartment=new TexturedApartmentModel(result.scene,origin,model.floorHeight);
    if(signal.aborted){apartment.dispose();throw aborted();}return apartment;
  }
  setLowWalls(low:boolean){this.cutHeight=low?1.35:Infinity;this.plane.constant=low?1.35:10000;}
  visibleBounds(){const bounds=this.bounds.clone();bounds.max.y=Math.min(bounds.max.y,this.cutHeight);return bounds;}
  pick(ray:THREE.Ray):THREE.Vector3|null{
    if(this.disposed||!this.mesh.visible)return null;this.raycaster.ray.copy(ray);
    const hit=this.raycaster.intersectObject(this.mesh,true).find(hit=>hit.point.y<=this.cutHeight+1e-6);return hit?.point.clone()??null;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.mesh.removeFromParent();
    for(const geometry of this.geometries)geometry.dispose();for(const material of this.materials)material.dispose();
    for(const texture of this.textures){texture.dispose();const source=texture.source?.data;if(source&&typeof source.close==="function")source.close();}
    this.geometries.clear();this.materials.clear();this.textures.clear();
  }
}
