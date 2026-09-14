import * as THREE from "three";
import type {Plan,Scene} from "../../lib/imo3d/model";
import {currentTexturedMesh} from "../../lib/imo3d/mesh-model";
import {TexturedApartmentModel} from "./TexturedApartmentModel";

/** Orthographic projection of the same connected surfaces used in the dollhouse. */
export async function texturedFloorPlanPng(plan:Plan,scenes:Scene[],title:string,signal:AbortSignal):Promise<Blob>{
  const metadata=currentTexturedMesh(plan,scenes);if(!metadata)throw Error("المجسّم غير متاح لهذا الدور.");
  let apartment:TexturedApartmentModel|undefined,renderer:THREE.WebGLRenderer|undefined,target:THREE.WebGLRenderTarget|undefined;
  const abort=()=>{if(signal.aborted)throw new DOMException("أُلغي تجهيز المخطط.","AbortError");};
  try{
    apartment=await TexturedApartmentModel.load(metadata,{x:0,z:0},signal);apartment.setLowWalls(false);abort();
    const bounds=apartment.visibleBounds(),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    if(bounds.isEmpty()||size.x<=0||size.z<=0)throw Error("حدود المجسّم غير صالحة للتصدير.");
    const scale=2400/Math.max(size.x,size.z),width=Math.max(320,Math.round(size.x*scale)),height=Math.max(320,Math.round(size.z*scale));
    const camera=new THREE.OrthographicCamera(-size.x*.54,size.x*.54,size.z*.54,-size.z*.54,.01,1000);
    camera.up.set(0,0,-1);camera.position.set(center.x,bounds.max.y+30,center.z);camera.lookAt(center.x,0,center.z);camera.updateProjectionMatrix();
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setSize(width,height,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.localClippingEnabled=true;
    const world=new THREE.Scene();world.background=new THREE.Color(0xffffff);world.add(apartment.mesh);
    target=new THREE.WebGLRenderTarget(width,height,{samples:4});renderer.setRenderTarget(target);renderer.render(world,camera);
    const pixels=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);abort();
    const canvas=document.createElement("canvas");canvas.width=width+120;canvas.height=height+240;const context=canvas.getContext("2d");if(!context)throw Error("تعذر تجهيز صورة المخطط.");
    context.fillStyle="#ffffff";context.fillRect(0,0,canvas.width,canvas.height);
    const picture=new ImageData(width,height),row=width*4;for(let y=0;y<height;y++)picture.data.set(pixels.subarray((height-1-y)*row,(height-y)*row),y*row);context.putImageData(picture,60,120);
    context.textAlign="center";context.direction="rtl";context.fillStyle="#293b32";context.font="600 30px Arial, sans-serif";context.fillText(`${title} · ${plan.label}`,canvas.width/2,62,canvas.width-80);
    context.font="22px Arial, sans-serif";context.fillStyle="#607065";context.fillText("مسقط علوي من المجسّم · تقديري بمقياس نسبي",canvas.width/2,canvas.height-42,canvas.width-80);
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>{try{abort();if(!blob)throw Error("تعذر حفظ صورة المخطط.");resolve(blob);}catch(error){reject(error);}},"image/png"));
  }finally{target?.dispose();apartment?.dispose();if(renderer){renderer.dispose();renderer.forceContextLoss();}}
}
