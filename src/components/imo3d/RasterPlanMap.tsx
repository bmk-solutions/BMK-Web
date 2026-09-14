"use client";
import {useId,useMemo,useRef} from "react";
import type {RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
import {nearestRasterScene} from "./raster-navigation";

export function RasterPlanMap({src,map,sceneIds,current,onSelect,compact=false,zoom=1}:{src:string;map:RasterNavigation;sceneIds:string[];current?:string;onSelect:(id:string)=>void;compact?:boolean;zoom?:number}){
 const eligible=useMemo(()=>new Set(sceneIds),[sceneIds]);
 const selected=map.points.find(point=>point.sceneId===current);
 const down=useRef<{x:number;y:number}|null>(null);
 const clipId=useId();
 const outline=map.outline?.map(p=>({x:p.x*map.width,y:p.y*map.height}));
 const bounds=outline?{x:Math.min(...outline.map(p=>p.x)),y:Math.min(...outline.map(p=>p.y)),right:Math.max(...outline.map(p=>p.x)),bottom:Math.max(...outline.map(p=>p.y))}:null;
 const viewBox=bounds?`${bounds.x} ${bounds.y} ${bounds.right-bounds.x} ${bounds.bottom-bounds.y}`:`0 0 ${map.width} ${map.height}`;
 return <svg className={`imo-raster-map${compact?" is-compact":""}`} style={compact?undefined:{height:`${60*zoom}dvh`,maxHeight:"none"}} viewBox={viewBox} role="img" aria-label="مخطط الشقة؛ اضغط أي مكان للانتقال مباشرة إلى أقرب لقطة" onPointerDown={e=>{down.current={x:e.clientX,y:e.clientY};}} onPointerCancel={()=>{down.current=null;}} onPointerUp={e=>{
  const start=down.current;down.current=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)return;
  const matrix=e.currentTarget.getScreenCTM();if(!matrix)return;
  const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());
  const id=nearestRasterScene(map,p.x/map.width,p.y/map.height,eligible);if(id)onSelect(id);
 }}>
  {outline&&<defs><clipPath id={clipId}><polygon points={outline.map(p=>`${p.x},${p.y}`).join(" ")}/></clipPath></defs>}
  <image href={src} width={map.width} height={map.height} clipPath={outline?`url(#${clipId})`:undefined}/>
  {selected&&<g pointerEvents="none"><circle cx={selected.x*map.width} cy={selected.y*map.height} r={compact?24:13} fill="#16a68a" stroke="white" strokeWidth={compact?7:4}/><circle cx={selected.x*map.width} cy={selected.y*map.height} r={compact?40:22} fill="none" stroke="#16a68a" strokeWidth="3" opacity=".5"/></g>}
 </svg>;
}
