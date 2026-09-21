"use client";
/* eslint-disable @next/next/no-img-element */
import {useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import type {Scene} from '@/lib/imo3d/model';
import {hotspotPoint,type Hotspot} from '@/lib/imo3d/hotspots';
import type {PanoramaEngine} from './PanoramaEngine';
import {PanoramaPlacement} from './PanoramaPlacement';
import {Dialog} from './Dialog';
import {Icon} from './Icon';
import './hotspots.css';
export function HotspotOverlay({scene,rows,engine,onNavigate,onModal}:{scene:Scene;rows:Hotspot[];engine:RefObject<PanoramaEngine|null>;onNavigate:(id:string)=>void;onModal:(open:boolean)=>void}){
 const root=useRef<HTMLDivElement>(null),[selected,setSelected]=useState<Hotspot|null>(null);
 useEffect(()=>{let frame=0;const update=()=>{const viewer=engine.current;if(viewer&&root.current)for(const row of rows){const node=root.current.querySelector<HTMLElement>(`[data-hotspot-id="${row.id}"]`);if(!node)continue;const p=viewer.project(hotspotPoint(scene,row.yaw,row.pitch));node.hidden=viewer.busy||!p.visible;node.style.transform=`translate(${p.x}px,${p.y}px) translate(-50%,calc(-50% - ${row.stem??0}px)) scale(${row.scale??1})`;if(['area','screen'].includes(row.kind)){const a=viewer.project(hotspotPoint(scene,row.yaw-row.width/2,row.pitch+row.height/2)),b=viewer.project(hotspotPoint(scene,row.yaw+row.width/2,row.pitch-row.height/2));node.style.width=`${Math.min(500,Math.max(44,Math.abs(a.x-b.x)))}px`;node.style.height=`${Math.min(400,Math.max(44,Math.abs(a.y-b.y)))}px`;}}frame=requestAnimationFrame(update);};update();return()=>cancelAnimationFrame(frame);},[scene,rows,engine]);
 useEffect(()=>()=>onModal(false),[onModal]);
 const panoScene=useMemo(()=>selected?{...scene,id:selected.id,image:selected.url,preview:selected.url,thumbnail:selected.url,presentation:undefined,detail:undefined,depth:undefined,displayDepth:undefined,yaw:0,entryView:undefined}:scene,[scene,selected]);
 const close=()=>{setSelected(null);onModal(false);};
 return <><div ref={root} className="imo-hotspot-overlay">{rows.filter(h=>h.visible).map(h=>h.kind==='screen'?<div hidden key={h.id} data-hotspot-id={h.id} className="imo-hotspot-screen"><video aria-label={h.title} src={h.url} controls playsInline preload="none"/><span>{h.title}</span></div>:<button hidden key={h.id} data-hotspot-id={h.id} className={`imo-hotspot-marker ${h.kind==='area'?'is-area':''}`} style={{borderColor:h.color}} aria-label={h.title} title={h.title} onClick={()=>{if(h.kind==='point'){onNavigate(h.targetSceneId);return;}setSelected(h);onModal(true);}}>{!!h.stem&&<i className="imo-hotspot-stem" style={{height:h.stem,borderColor:h.color}}/>}<Icon name={h.kind==='point'?'compass':h.kind==='video'?'play':h.kind==='audio'?'audio':h.kind==='image'||h.kind==='staging'?'image':'info'}/>{h.kind==='area'&&<span>{h.title}</span>}</button>)}</div>
 {selected&&<Dialog title={selected.title} className="imo-hotspot-dialog" onClose={close}><div className="imo-hotspot-content">
 {selected.body&&<p>{selected.body}</p>}
 {['image','staging','product'].includes(selected.kind)&&selected.url&&<img src={selected.url} alt={selected.title} referrerPolicy="no-referrer"/>}
 {['video','screen'].includes(selected.kind)&&<video key={selected.id} src={selected.url} controls playsInline preload="metadata"/>}
 {selected.kind==='audio'&&<audio src={selected.url} controls preload="metadata"/>}
 {selected.kind==='pano'&&<PanoramaPlacement scene={panoScene}/>}
 {selected.price&&<strong>{selected.price}</strong>}
 {(selected.link||['link','space'].includes(selected.kind))&&<a className="imo-button primary" href={selected.link||selected.url} target="_blank" rel="noopener noreferrer">{selected.kind==='product'?'عرض المنتج':'فتح الرابط'}<Icon name="open-plan" size={18}/></a>}
 </div></Dialog>}</>;
}
