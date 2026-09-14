import * as THREE from "three";
import type {SurfaceModel} from "../../lib/imo3d/model";
import {decodeSurfaceModel,surfaceHeaderBytes,surfaceRecordBytes,maxSurfacePoints} from "../../lib/imo3d/surface-model";

export type PhotographicState={status:"unavailable"|"loading"|"ready"|"error";active:boolean};
type Decoded=ReturnType<typeof decodeSurfaceModel>;
const abortError=()=>new DOMException("أُلغي تحميل العرض.","AbortError");

/** The private asset must fit both the wire-format bound and its current plan metadata. */
export async function loadPhotographicSamples(model:SurfaceModel,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<Decoded>{
  if(!/^\/api\/imo3d\/assets\/[\w-]{1,80}$/.test(model.url)||!Number.isInteger(model.pointCount)||model.pointCount<1||model.pointCount>maxSurfacePoints||!Number.isFinite(model.floorHeight))throw new Error("بيانات العرض من الصور غير صالحة.");
  if(signal.aborted)throw abortError();
  const expected=surfaceHeaderBytes+surfaceRecordBytes*model.pointCount;
  const response=await fetcher(model.url,{signal,credentials:"same-origin",cache:"no-store",redirect:"error"});
  const declared=response.headers.get("content-length");
  if(!response.ok||response.redirected||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==expected)){await response.body?.cancel().catch(()=>{});throw new Error("تعذر تحميل العرض من الصور. المخطط متاح.");}
  if(!response.body)throw new Error("ملف العرض من الصور فارغ.");
  const reader=response.body.getReader(),bytes=new Uint8Array(expected);let length=0,complete=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try{
    for(;;){if(signal.aborted)throw abortError();const chunk=await reader.read();if(chunk.done)break;if(length+chunk.value.byteLength>expected)throw new Error("حجم العرض من الصور لا يطابق المخطط.");bytes.set(chunk.value,length);length+=chunk.value.byteLength;}
    if(signal.aborted)throw abortError();
    if(length!==expected)throw new Error("لم يكتمل تحميل العرض من الصور.");
    const decoded=decodeSurfaceModel(bytes.buffer);
    if(decoded.count!==model.pointCount||Math.abs(decoded.floorHeight-model.floorHeight)>1e-4)throw new Error("إحداثيات العرض من الصور لا تطابق المخطط.");
    complete=true;return decoded;
  }finally{signal.removeEventListener("abort",abort);if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Small normal-oriented discs cover observed samples only; no triangle joins two samples. */
export class PhotographicFloorModel{
  readonly mesh:THREE.Mesh<THREE.InstancedBufferGeometry,THREE.ShaderMaterial>;
  readonly positions:Float32Array;readonly normals:Float32Array;
  private disposed=false;private maxHeight=1.2;private radius=.022;
  constructor(data:Decoded,origin:{x:number;z:number}){
    this.positions=new Float32Array(data.positions.length);this.normals=data.normals;
    for(let i=0;i<data.count;i++){this.positions[i*3]=data.positions[i*3]-origin.x;this.positions[i*3+1]=data.positions[i*3+1]-data.floorHeight;this.positions[i*3+2]=data.positions[i*3+2]-origin.z;}
    const source=new THREE.PlaneGeometry(2,2),geometry=new THREE.InstancedBufferGeometry();
    geometry.setIndex(source.index!.clone());geometry.setAttribute("position",source.getAttribute("position").clone());geometry.setAttribute("uv",source.getAttribute("uv").clone());source.dispose();geometry.instanceCount=data.count;
    geometry.setAttribute("samplePosition",new THREE.InstancedBufferAttribute(this.positions,3));geometry.setAttribute("sampleNormal",new THREE.InstancedBufferAttribute(data.normals,3));geometry.setAttribute("sampleColor",new THREE.InstancedBufferAttribute(data.colors,3,true));
    geometry.boundingBox=new THREE.Box3().setFromArray(this.positions).expandByScalar(this.radius);geometry.boundingSphere=geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,toneMapped:false,uniforms:{radius:{value:this.radius},maxHeight:{value:this.maxHeight}},vertexShader:`
      attribute vec3 samplePosition;attribute vec3 sampleNormal;attribute vec3 sampleColor;uniform float radius;varying vec2 discUv;varying vec3 rgb;varying float height;
      vec3 linearRGB(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
      void main(){vec3 tangent;vec3 bitangent;if(length(sampleNormal)>.5){vec3 n=normalize(sampleNormal);tangent=normalize(cross(abs(n.y)>.9?vec3(1.,0.,0.):vec3(0.,1.,0.),n));bitangent=cross(n,tangent);}else{tangent=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);bitangent=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);}vec3 p=samplePosition+(tangent*position.x+bitangent*position.y)*radius;discUv=uv;rgb=linearRGB(sampleColor);height=p.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}
    `,fragmentShader:`varying vec2 discUv;varying vec3 rgb;varying float height;uniform float maxHeight;void main(){if(dot(discUv-vec2(.5),discUv-vec2(.5))>.25||height>maxHeight)discard;gl_FragColor=vec4(rgb,1.);
      #include <colorspace_fragment>
    }`});
    this.mesh=new THREE.Mesh(geometry,material);this.mesh.name="imo-photographic-surfaces";
  }
  setLowWalls(low:boolean){this.maxHeight=low?1.2:Infinity;this.mesh.material.uniforms.maxHeight.value=low?1.2:10000;}
  visibleBounds(){const box=new THREE.Box3(),point=new THREE.Vector3();for(let i=0;i<this.positions.length;i+=3)if(this.positions[i+1]<=this.maxHeight+this.radius)box.expandByPoint(point.set(this.positions[i],Math.min(this.positions[i+1],this.maxHeight),this.positions[i+2]));return box.isEmpty()?box:box.expandByScalar(this.radius);}
  /** O(N) only on a completed click. Ray-disc intersections respect the rendered cut. */
  pick(ray:THREE.Ray):THREE.Vector3|null{
    if(this.disposed||!this.mesh.visible)return null;const o=ray.origin,d=ray.direction,r2=this.radius*this.radius;let best=Infinity;
    for(let i=0;i<this.positions.length;i+=3){const x=this.positions[i],y=this.positions[i+1],z=this.positions[i+2];if(y>this.maxHeight+this.radius)continue;const nx=this.normals[i],ny=this.normals[i+1],nz=this.normals[i+2],denominator=d.x*nx+d.y*ny+d.z*nz;let distance:number;
      if(nx*nx+ny*ny+nz*nz>.25){if(Math.abs(denominator)<1e-5)continue;distance=((x-o.x)*nx+(y-o.y)*ny+(z-o.z)*nz)/denominator;}else distance=(x-o.x)*d.x+(y-o.y)*d.y+(z-o.z)*d.z;
      if(distance<=0||distance>=best||o.y+d.y*distance>this.maxHeight)continue;const dx=o.x+d.x*distance-x,dy=o.y+d.y*distance-y,dz=o.z+d.z*distance-z;if(dx*dx+dy*dy+dz*dz<=r2)best=distance;
    }return Number.isFinite(best)?ray.at(best,new THREE.Vector3()):null;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.mesh.removeFromParent();this.mesh.geometry.dispose();this.mesh.material.dispose();}
}
