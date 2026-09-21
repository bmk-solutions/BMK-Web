"use client";
import {useEffect,useRef,useState} from 'react';
import type {Scene} from '@/lib/imo3d/model';
import {hotspotPoint} from '@/lib/imo3d/hotspots';
import {sceneEntryView} from '@/lib/imo3d/view-presentation';
import type {PanoramaEngine} from './PanoramaEngine';
import './hotspots.css';
export function PanoramaPlacement({scene,yaw=0,pitch=0,onPick,disabled=false,regionSize,focusRegion=false}:{scene:Scene;yaw?:number;pitch?:number;onPick?:(yaw:number,pitch:number)=>void;disabled?:boolean;regionSize?:number;focusRegion?:boolean}){
 const canvas=useRef<HTMLCanvasElement>(null),marker=useRef<HTMLSpanElement>(null),callback=useRef(onPick),pose=useRef({yaw,pitch,regionSize}),locked=useRef(disabled);
 const instance=useRef<PanoramaEngine|null>(null),focus=useRef(focusRegion);
 const [error,setError]=useState('');
 useEffect(()=>{focus.current=focusRegion;callback.current=onPick;pose.current={yaw,pitch,regionSize};locked.current=disabled;});
 useEffect(()=>{if(instance.current){if(focusRegion){instance.current.stopLook();instance.current.yaw=(yaw+scene.yaw)*Math.PI/180;instance.current.pitch=pitch*Math.PI/180;}instance.current.invalidate();}},[yaw,pitch,regionSize,focusRegion,scene.yaw]);
 useEffect(()=>{
  let stopped=false,viewer:PanoramaEngine|undefined,resize:ResizeObserver|undefined,down:{x:number;y:number;lastX:number;lastY:number;drag:boolean}|null=null;
  const el=canvas.current!;
  void import('./PanoramaEngine').then(async({PanoramaEngine})=>{
   if(stopped)return;viewer=new PanoramaEngine(el);instance.current=viewer;viewer.allowNadir=true;viewer.onError=setError;
   viewer.onView=()=>{if(!marker.current||!viewer)return;const p=viewer.project(hotspotPoint(scene,pose.current.yaw,pose.current.pitch));marker.current.hidden=!p.visible;if(pose.current.regionSize){const edge=viewer.project(hotspotPoint(scene,pose.current.yaw+pose.current.regionSize*.4,pose.current.pitch));const vertical=viewer.project(hotspotPoint(scene,pose.current.yaw,Math.max(-89,Math.min(89,pose.current.pitch+pose.current.regionSize*.4))));const size=Math.max(40,Math.min(el.clientWidth*.85,Math.max(Math.hypot(edge.x-p.x,edge.y-p.y),Math.hypot(vertical.x-p.x,vertical.y-p.y))*2));marker.current.style.width=`${size}px`;marker.current.style.height=`${size}px`;marker.current.style.background='#24b18b25';}marker.current.style.transform=`translate(${p.x}px,${p.y}px) translate(-50%,-50%)`;};
   resize=new ResizeObserver(()=>viewer?.resize(el.clientWidth,el.clientHeight));resize.observe(el);viewer.resize(el.clientWidth,el.clientHeight);
   await viewer.move(scene,false);if(stopped)return;Object.assign(viewer,sceneEntryView(scene)??{yaw:scene.yaw*Math.PI/180,pitch:0,fov:75});if(focus.current){viewer.yaw=(pose.current.yaw+scene.yaw)*Math.PI/180;viewer.pitch=pose.current.pitch*Math.PI/180;}viewer.invalidate();
  }).catch(()=>setError('تعذر فتح المعاينة.'));
  const start=(e:PointerEvent)=>{if(e.button!==0)return;el.setPointerCapture(e.pointerId);down={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,drag:false};};
  const move=(e:PointerEvent)=>{if(!down||!viewer)return;if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>6)down.drag=true;if(down.drag)viewer.addLook(-(e.clientX-down.lastX)*.004,(e.clientY-down.lastY)*.003);down.lastX=e.clientX;down.lastY=e.clientY;};
  const end=(e:PointerEvent)=>{if(down&&!down.drag&&viewer&&!locked.current){const r=el.getBoundingClientRect(),ray=viewer.rayAt((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);callback.current?.(((ray.yaw*180/Math.PI-scene.yaw+180)%360+360)%360-180,Math.max(-85,Math.min(85,ray.pitch*180/Math.PI)));viewer.invalidate();}down=null;};
  const cancel=()=>{down=null;};const wheel=(e:WheelEvent)=>{e.preventDefault();if(viewer)viewer.fov+=e.deltaY*.025;};
  el.addEventListener('pointerdown',start);el.addEventListener('pointermove',move);el.addEventListener('pointerup',end);el.addEventListener('pointercancel',cancel);el.addEventListener('wheel',wheel,{passive:false});
  return()=>{stopped=true;resize?.disconnect();viewer?.dispose();instance.current=null;el.removeEventListener('pointerdown',start);el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',end);el.removeEventListener('pointercancel',cancel);el.removeEventListener('wheel',wheel);};
 },[scene]);
 return <div className="imo-placement"><canvas tabIndex={0} onKeyDown={e=>{const v=instance.current;if(!v)return;if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();v.addLook(e.key==="ArrowLeft"?.1:e.key==="ArrowRight"?-.1:0,e.key==="ArrowUp"?.1:e.key==="ArrowDown"?-.1:0);}}} ref={canvas} aria-label="معاينة الصورة؛ اسحب للنظر واضغط لتحديد المكان"/>{onPick&&<span ref={marker} className="imo-placement-pin" aria-hidden="true">+</span>}{error&&<p role="alert">{error}</p>}</div>;
}
