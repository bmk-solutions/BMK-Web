"use client";
import {useId,useMemo,useRef} from "react";
import type {RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
import {nearestRasterScene} from "./raster-navigation";

export function RasterPlanMap({src,map,sceneIds,current,onSelect,compact=false,zoom=1,heading,onIntent}:{src:string;map:RasterNavigation;sceneIds:string[];current?:string;onSelect:(id:string)=>void;compact?:boolean;zoom?:number;heading?:number;onIntent?:(id:string)=>void}){
 const eligible=useMemo(()=>new Set(sceneIds),[sceneIds]);
 const selected=map.points.find(point=>point.sceneId===current);
 const down=useRef<{x:number;y:number}|null>(null);
 const clipId=useId();
 const coneId=useId();
 const intent=useRef<string|null>(null);
 const targetAt=(x:number,y:number)=>{const matrix=content.current?.getScreenCTM();if(!matrix)return null;const point=new DOMPoint(x,y).matrixTransform(matrix.inverse());return nearestRasterScene(map,point.x/map.width,point.y/map.height,eligible);};
 const prepare=(x:number,y:number)=>{const id=targetAt(x,y);if(id&&intent.current!==id){intent.current=id;onIntent?.(id);}};
 const content=useRef<SVGGElement>(null);
 const outline=map.outline?.map(p=>({x:p.x*map.width,y:p.y*map.height}));
 const bounds=outline?{x:Math.min(...outline.map(p=>p.x)),y:Math.min(...outline.map(p=>p.y)),right:Math.max(...outline.map(p=>p.x)),bottom:Math.max(...outline.map(p=>p.y))}:null;
 const viewBox=bounds?`${bounds.x} ${bounds.y} ${bounds.right-bounds.x} ${bounds.bottom-bounds.y}`:`0 0 ${map.width} ${map.height}`;
 return <><svg id={clipId+"-map"} className={`imo-raster-map${compact?" is-compact":""}`} style={{...(compact?{}:{height:`${60*zoom}dvh`,maxHeight:"none"})}} viewBox={viewBox} role="img" aria-label="مخطط الشقة؛ اضغط أي مكان للانتقال مباشرة إلى أقرب لقطة" onPointerMove={e=>prepare(e.clientX,e.clientY)} onPointerDown={e=>{prepare(e.clientX,e.clientY);down.current={x:e.clientX,y:e.clientY};}} onPointerCancel={()=>{down.current=null;}} onPointerUp={e=>{
  const start=down.current;down.current=null;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)return;
  const matrix=content.current?.getScreenCTM();if(!matrix)return;
  const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());
  const id=nearestRasterScene(map,p.x/map.width,p.y/map.height,eligible);if(id)onSelect(id);
 }}>
  <defs><radialGradient id={coneId} cx="50%" cy="100%" r="100%"><stop offset="0" stopColor="#00dfbd" stopOpacity=".75"/><stop offset="1" stopColor="#00dfbd" stopOpacity=".12"/></radialGradient></defs>
  {outline&&<defs><clipPath id={clipId}><polygon points={outline.map(p=>`${p.x},${p.y}`).join(" ")}/></clipPath></defs>}
  <g ref={content}>
  <image href={src} width={map.width} height={map.height} clipPath={outline?`url(#${clipId})`:undefined}/>
  {selected&&<g pointerEvents="none">{heading!==undefined&&<g transform={`translate(${selected.x*map.width} ${selected.y*map.height}) rotate(${heading})`}><title>اتجاه النظر بحسب تسجيل الصور على المخطط</title><path d="M0 0 L-85 -125 Q0 -165 85 -125 Z" fill={`url(#${coneId})`} stroke="#007c69" strokeWidth="3"/><path d="M-15 -45 L0 -70 L15 -45" fill="#00c9a7" stroke="white" strokeWidth="5" strokeLinejoin="round"/></g>}<circle cx={selected.x*map.width} cy={selected.y*map.height} r={compact?24:13} fill="#16a68a" stroke="white" strokeWidth={compact?7:4}/><circle cx={selected.x*map.width} cy={selected.y*map.height} r={compact?40:22} fill="none" stroke="#16a68a" strokeWidth="3" opacity=".5"/></g>}
 </g></svg></>;
}
