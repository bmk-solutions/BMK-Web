"use client";
import {useEffect,useRef,useState} from "react";
import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {wallRuns,type Architecture} from "@/lib/imo3d/architecture";
import type {Scene} from "@/lib/imo3d/model";
import type {ArchitectureLayers} from "./ArchitecturalPlanView";

/** The plan x/z frame is also the Three.js floor frame; extrusion is upwards. */
export function architecturalFloorGeometry(polygon:{x:number;z:number}[],height?:number){
 const shape=new THREE.Shape(polygon.map(p=>new THREE.Vector2(p.x,-p.z)));
 const geometry=height?new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false}):new THREE.ShapeGeometry(shape);
 geometry.rotateX(-Math.PI/2);return geometry;
}
type Props={architecture:Architecture;scenes:Scene[];current:string;yaw:number;onSelect:(id:string)=>void;layers:ArchitectureLayers};
export function ArchitecturalModel3D({architecture,scenes,current,yaw,onSelect,layers}:Props){
 const mount=useRef<HTMLDivElement>(null),callback=useRef(onSelect),active=useRef({current,yaw}),reset=useRef<()=>void>(()=>{}),[error,setError]=useState(false);
 useEffect(()=>{callback.current=onSelect;},[onSelect]);useEffect(()=>{active.current={current,yaw};},[current,yaw]);
 useEffect(()=>{
  const element=mount.current;if(!element)return;
  let renderer:THREE.WebGLRenderer;try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{queueMicrotask(()=>setError(true));return;}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.setClearColor(0xf8fafb,0);element.appendChild(renderer.domElement);
  const world=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.001,10000),controls=new OrbitControls(camera,renderer.domElement),resources:{dispose:()=>void}[]=[];
  const track=<T extends {dispose:()=>void}>(r:T)=>{resources.push(r);return r;};
  const neutral=track(new THREE.MeshStandardMaterial({color:0xe1e5e8,roughness:.88,side:THREE.DoubleSide})),floorMaterial=track(new THREE.MeshStandardMaterial({color:0xf5f3ee,roughness:1,side:THREE.DoubleSide})),columnMaterial=track(new THREE.MeshStandardMaterial({color:0xb9c1c7,roughness:.9}));
  world.add(new THREE.HemisphereLight(0xffffff,0x7f8793,2.4));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(5,12,7);world.add(light);
  const model=new THREE.Group();world.add(model);const floorTargets:THREE.Object3D[]=[];
  for(const wall of architecture.walls){if(!layers.walls)continue;for(const run of wallRuns(architecture,wall)){const length=Math.hypot(run.b.x-run.a.x,run.b.z-run.a.z),height=run.top-run.bottom;if(!wall.thickness||height<=0||length<=0)continue;const mesh=new THREE.Mesh(track(new THREE.BoxGeometry(length,height,wall.thickness)),neutral);mesh.position.set((run.a.x+run.b.x)/2,(run.bottom+run.top)/2,(run.a.z+run.b.z)/2);mesh.rotation.y=-Math.atan2(run.b.z-run.a.z,run.b.x-run.a.x);model.add(mesh);}}
  function floor(polygon:{x:number;z:number}[],material:THREE.Material,height?:number){if(polygon.length<3)return;const geometry=track(architecturalFloorGeometry(polygon,height));const mesh=new THREE.Mesh(geometry,material);model.add(mesh);return mesh;}
  for(const room of architecture.rooms){const mesh=floor(room.polygon,floorMaterial);if(mesh){mesh.visible=layers.rooms;floorTargets.push(mesh);}}
  if(layers.columns)for(const column of architecture.columns){if(column.height&&column.height>0)floor(column.polygon,columnMaterial,column.height);}
  const bounds=new THREE.Box3().setFromObject(model);if(bounds.isEmpty()){renderer.dispose();resources.forEach(r=>r.dispose());renderer.domElement.remove();controls.dispose();return;}
  const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),span=Math.max(size.x,size.y,size.z,.1);
  const setView=()=>{camera.position.copy(center).add(new THREE.Vector3(span*.9,span*1.15,span*1.15));controls.target.copy(center);controls.update();};reset.current=setView;setView();controls.enableDamping=true;controls.dampingFactor=.08;controls.maxPolarAngle=Math.PI*.48;controls.minDistance=span*.15;controls.maxDistance=span*6;
  const markers:THREE.Mesh[]=[];if(layers.cameras){const geometry=track(new THREE.SphereGeometry(span*.006,12,8));for(const scene of scenes){if(!scene.position)continue;const material=track(new THREE.MeshBasicMaterial({color:scene.id===active.current.current?0x227ca7:0x8495a1})),mesh=new THREE.Mesh(geometry,material);mesh.position.set(scene.position.x,span*.008,scene.position.z);mesh.userData.sceneId=scene.id;world.add(mesh);markers.push(mesh);}}
  const resize=()=>{const {width,height}=element.getBoundingClientRect();renderer.setSize(Math.max(width,1),Math.max(height,1));camera.aspect=width/Math.max(height,1);camera.updateProjectionMatrix();};const observer=new ResizeObserver(resize);observer.observe(element);resize();
  let pointer:{x:number;y:number;id:number;moved:boolean}|null=null;const down=(e:PointerEvent)=>{if(!e.isPrimary){if(pointer)pointer.moved=true;return;}pointer={x:e.clientX,y:e.clientY,id:e.pointerId,moved:false};},move=(e:PointerEvent)=>{if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>5)pointer.moved=true;},cancel=()=>{pointer=null;};
  const up=(e:PointerEvent)=>{const origin=pointer;pointer=null;if(!origin||origin.id!==e.pointerId||origin.moved)return;const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),camera);const hit=ray.intersectObjects(floorTargets,false)[0];if(!hit)return;const target=scenes.filter(s=>s.position).sort((a,b)=>Math.hypot(a.position!.x-hit.point.x,a.position!.z-hit.point.z)-Math.hypot(b.position!.x-hit.point.x,b.position!.z-hit.point.z))[0];if(target)callback.current(target.id);};
  const canvas=renderer.domElement;canvas.addEventListener("pointerdown",down);canvas.addEventListener("pointermove",move);canvas.addEventListener("pointerup",up);canvas.addEventListener("pointercancel",cancel);
  let frame=0;const draw=()=>{controls.update();for(const marker of markers){const material=marker.material as THREE.MeshBasicMaterial;material.color.setHex(marker.userData.sceneId===active.current.current?0x227ca7:0x8495a1);}renderer.render(world,camera);frame=requestAnimationFrame(draw);};draw();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();controls.dispose();resources.forEach(r=>r.dispose());renderer.dispose();canvas.removeEventListener("pointerdown",down);canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",up);canvas.removeEventListener("pointercancel",cancel);canvas.remove();};
 },[architecture,scenes,layers]);
 const knownWalls=architecture.walls.filter(w=>w.thickness&&w.height).length;
 return <div className="imo-architecture-model"><div ref={mount} className="imo-architecture-canvas" role="img" aria-label="مجسم معماري مشتق من جدران المخطط؛ اسحب للدوران واضغط أرضية الغرفة للانتقال"/>{error?<p role="alert">تعذر تشغيل العرض ثلاثي الأبعاد على هذا الجهاز.</p>:!knownWalls?<p>ارتفاعات الجدران غير محددة؛ لا يمكن إنشاء مجسم معماري مكتمل قبل استكمالها.</p>:knownWalls<architecture.walls.length?<p>مجسم جزئي: تظهر فقط الجدران ذات السماكة والارتفاع المحددين.</p>:null}<button type="button" className="imo-architecture-reset" onClick={()=>reset.current()}>إعادة ضبط العرض</button><small>اسحب للدوران · قرّب بإصبعين · اضغط الأرضية للانتقال المباشر</small></div>;
}

