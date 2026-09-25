"use client";

import {useMemo,useRef,useState} from "react";
import type {Architecture} from "@/lib/imo3d/architecture";
import {wallPolygon,formatArchitectureLength,roomMetrics,architectureIssues} from "@/lib/imo3d/architecture";
import type {Scene} from "@/lib/imo3d/model";
import {architectureLayers,type ArchitectureLayers,type ArchitecturePresentation} from "@/lib/imo3d/architecture-visibility";
import {ArchitecturalModel3D} from "./ArchitecturalModel3D";
import "./architectural-plan.css";

type P={x:number;z:number};
export type ArchitecturalPlanViewProps={architecture:Architecture;scenes:Scene[];current:string;yaw:number;onSelect:(id:string)=>void;mode?:"2d"|"3d";compact?:boolean;presentation?:ArchitecturePresentation};
export type {ArchitectureLayers};
function inside(p:P,polygon:P[]){let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)yes=!yes;}return yes;}
/** Draw each wall independently with its own hosted openings; never erase a neighbour at a junction. */
export function architecturalWallPlanPolygons(model:Architecture,wall:Architecture["walls"][number]):P[][]{
 const length=Math.hypot(wall.b.x-wall.a.x,wall.b.z-wall.a.z);if(!wall.thickness||length<1e-8)return [];
 const openings=model.openings.filter(o=>o.wallId===wall.id&&o.offset>=0&&o.width>0&&o.offset+o.width<=length+1e-6).sort((a,b)=>a.offset-b.offset);
 const at=(offset:number)=>({x:wall.a.x+(wall.b.x-wall.a.x)*offset/length,z:wall.a.z+(wall.b.z-wall.a.z)*offset/length});
 const result:P[][]=[];let cursor=0;
 for(const opening of openings){if(opening.offset>cursor)result.push(wallPolygon({...wall,a:at(cursor),b:at(opening.offset)}));cursor=Math.max(cursor,opening.offset+opening.width);}
 if(cursor<length)result.push(wallPolygon({...wall,a:at(cursor)}));return result;
}
export function architectureCaptures(model:Architecture,scenes:Scene[]){
 return scenes.filter(scene=>{
  const p=scene.position;if(scene.floor!==model.floor||!p||model.columns.some(c=>inside(p,c.polygon)))return false;
  let doorwayConnected=false;
  for(const wall of model.walls){
   if(!inside(p,wallPolygon(wall)))continue;
   const dx=wall.b.x-wall.a.x,dz=wall.b.z-wall.a.z,length=Math.hypot(dx,dz),offset=((p.x-wall.a.x)*dx+(p.z-wall.a.z)*dz)/length;
   const passage=model.openings.some(o=>o.wallId===wall.id&&o.kind!=="window"&&offset>=o.offset&&offset<=o.offset+o.width);
   if(!passage)return false;
   const step=(wall.thickness??0)/2+1e-5,center={x:wall.a.x+dx*offset/length,z:wall.a.z+dz*offset/length};
   doorwayConnected ||= model.rooms.some(room=>room.wallIds.includes(wall.id)&&[-1,1].some(sign=>inside({x:center.x-dz/length*step*sign,z:center.z+dx/length*step*sign},room.polygon)));
  }
  return doorwayConnected||model.rooms.some(room=>inside(p,room.polygon));
 });
}export function nearestArchitectureCapture(scenes:Scene[],p:P){return scenes.filter(s=>s.position).sort((a,b)=>Math.hypot(a.position!.x-p.x,a.position!.z-p.z)-Math.hypot(b.position!.x-p.x,b.position!.z-p.z))[0]?.id;}
function anchor(polygon:P[]){const xs=polygon.map(p=>p.x),zs=polygon.map(p=>p.z),minX=Math.min(...xs),minZ=Math.min(...zs),w=Math.max(...xs)-minX,h=Math.max(...zs)-minZ;let best=polygon[0],score=-1;for(let x=0;x<19;x++)for(let z=0;z<19;z++){const p={x:minX+w*(x+.5)/19,z:minZ+h*(z+.5)/19};if(!inside(p,polygon))continue;const clearance=Math.min(...polygon.map((a,i)=>{const b=polygon[(i+1)%polygon.length],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz||1)));return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);}));if(clearance>score){score=clearance;best=p;}}return {...best,clearance:Math.max(0,score)};}
const points=(p:P[])=>p.map(v=>`${v.x},${v.z}`).join(" ");

export function ArchitecturalPlanView({architecture,scenes,current,yaw,onSelect,mode="2d",compact=false,presentation="tour"}:ArchitecturalPlanViewProps){
 const [layers,setLayers]=useState<ArchitectureLayers>(()=>architectureLayers(presentation));
 const [zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,z:0});
 const drag=useRef<{x:number;y:number;pan:P;moved:boolean}|null>(null);
 const captures=useMemo(()=>architectureCaptures(architecture,scenes),[architecture,scenes]);
 const extent=useMemo(()=>{const ps=[...architecture.walls.flatMap(w=>wallPolygon(w).length?wallPolygon(w):[w.a,w.b]),...architecture.rooms.flatMap(r=>r.polygon),...architecture.columns.flatMap(c=>c.polygon)];if(!ps.length)return null;const x=Math.min(...ps.map(p=>p.x)),z=Math.min(...ps.map(p=>p.z)),w=Math.max(...ps.map(p=>p.x))-x,h=Math.max(...ps.map(p=>p.z))-z,s=Math.max(w,h,.1);return{x:x-s*.14,z:z-s*.14,w:w+s*.28,h:h+s*.28,s};},[architecture]);
 const labels=useMemo(()=>architecture.rooms.filter(r=>r.polygon.length>=3).map(r=>({room:r,point:anchor(r.polygon)})),[architecture.rooms]);
 const scale=architecture.scale,calibrated=scale.status==="calibrated"&&scale.metersPerUnit!==null;
 const missing=architecture.walls.filter(w=>!w.thickness).length; const issues=useMemo(()=>architectureIssues(architecture),[architecture]);
 const toggle=(key:keyof ArchitectureLayers)=>setLayers(previous=>({...previous,[key]:!previous[key]}));
 const layerNames:Record<keyof ArchitectureLayers,string>={walls:"الجدران",doors:"الأبواب",windows:"النوافذ",columns:"الأعمدة",rooms:"حدود الغرف",names:"أسماء الغرف",areas:"المساحات",dimensions:"الأبعاد",cameras:"مواقع 360",direction:"اتجاه النظر",confidence:"الثقة"};
 const unit=(extent?.s??1)/100,v=extent?{x:extent.x+extent.w*(1-1/zoom)/2+pan.x,z:extent.z+extent.h*(1-1/zoom)/2+pan.z,w:extent.w/zoom,h:extent.h/zoom}:null;
 const active=captures.find(s=>s.id===current);
 return <section className={`imo-architecture${compact?" is-compact":""}`} dir="rtl" aria-label="المخطط المعماري">
  <header className="imo-architecture-toolbar"><div><strong>{mode==="3d"?"النموذج المعماري 3D":"المخطط المعماري 2D"}</strong><small>{calibrated?"مقياس مُعاير":"المقياس تقديري — لا يصلح للقياس التنفيذي"}</small></div><div className="imo-architecture-actions"><button type="button" aria-pressed={!layers.cameras} onClick={()=>setLayers(p=>({...p,cameras:false,direction:false,confidence:false}))}>مخطط نظيف</button><button type="button" aria-pressed={layers.cameras} onClick={()=>setLayers(p=>({...p,cameras:true,direction:true,confidence:false}))}>مخطط الجولة</button><details><summary>الطبقات</summary><div>{Object.entries(layerNames).map(([key,name])=><label key={key}><input type="checkbox" checked={layers[key as keyof ArchitectureLayers]} disabled={(key==="areas"||key==="dimensions")&&!calibrated} onChange={()=>toggle(key as keyof ArchitectureLayers)}/>{name}</label>)}</div></details></div></header>
  {!extent||!architecture.walls.some(w=>w.thickness)?<div className="imo-architecture-empty"><strong>المخطط المعماري لم يكتمل بعد</strong><p>يلزم تحديد الجدران ووجوهها وسماكتها وحدود الغرف من بيانات موثوقة. مواقع الصور وحدها لا تمثل مخططًا معماريًا.</p></div>:mode==="3d"?<ArchitecturalModel3D architecture={architecture} scenes={captures} current={current} yaw={yaw} onSelect={onSelect} layers={layers}/>:<div className="imo-architecture-sheet"><svg viewBox={`${v!.x} ${v!.z} ${v!.w} ${v!.h}`} role="group" aria-label="مخطط معماري؛ اضغط للانتقال مباشرة إلى أقرب صورة" onWheel={e=>setZoom(z=>Math.max(.7,Math.min(5,z*(e.deltaY>0?.9:1.1))))} onPointerDown={e=>{drag.current={x:e.clientX,y:e.clientY,pan:{...pan},moved:false};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{const d=drag.current;if(!d)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(Math.hypot(dx,dy)>5)d.moved=true;if(d.moved){const rect=e.currentTarget.getBoundingClientRect(),ratio=Math.max(v!.w/rect.width,v!.h/rect.height);setPan({x:d.pan.x-dx*ratio,z:d.pan.z-dy*ratio});}}} onPointerCancel={()=>{drag.current=null;}} onPointerUp={e=>{const d=drag.current;drag.current=null;if(!d||d.moved)return;const matrix=e.currentTarget.getScreenCTM();if(!matrix)return;const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),id=nearestArchitectureCapture(captures,{x:p.x,z:p.y});if(id)onSelect(id);}}>
   {layers.rooms&&architecture.rooms.map(r=><polygon key={r.id} points={points(r.polygon)} fill="#fff" stroke="#d8dbdf" strokeWidth={unit*.09}/>)}
   {layers.walls&&architecture.walls.flatMap(w=>architecturalWallPlanPolygons(architecture,w).map((polygon,index)=><polygon key={`${w.id}-${index}`} points={points(polygon)} fill={w.kind==="partition"?"#373c43":"#171c23"}><title>{`${w.kind} · ${Math.round(w.confidence*100)}%`}</title></polygon>))}
   {layers.columns&&architecture.columns.map(c=><polygon key={c.id} points={points(c.polygon)} fill="#171c23"/>)}
   {architecture.openings.map(o=>{const wall=architecture.walls.find(w=>w.id===o.wallId);if(!wall?.thickness)return null;const dx=wall.b.x-wall.a.x,dz=wall.b.z-wall.a.z,length=Math.hypot(dx,dz),ux=dx/length,uz=dz/length,nx=-uz,nz=ux,a={x:wall.a.x+ux*o.offset,z:wall.a.z+uz*o.offset},b={x:a.x+ux*o.width,z:a.z+uz*o.width},t=wall.thickness/2;
    const show=o.kind==="window"?layers.windows:layers.doors,hinge=o.hinge==="end"?b:a,shut=o.hinge==="end"?a:b,side=o.swing==="left"?1:-1,leaf={x:hinge.x+nx*o.width*side,z:hinge.z+nz*o.width*side},sweep=(o.hinge==="end"?-1:1)*side>0?1:0;
    return <g key={o.id}>{show&&<g fill="none" stroke="#626b76" strokeWidth={unit*.12}><path d={`M${a.x-nx*t} ${a.z-nz*t}L${a.x+nx*t} ${a.z+nz*t}M${b.x-nx*t} ${b.z-nz*t}L${b.x+nx*t} ${b.z+nz*t}`}/>{o.kind==="window"?[-.48,0,.48].map(k=><line key={k} x1={a.x+nx*t*k} y1={a.z+nz*t*k} x2={b.x+nx*t*k} y2={b.z+nz*t*k}/>):o.kind==="door"&&o.hinge&&o.swing?<><path d={`M${hinge.x} ${hinge.z}L${leaf.x} ${leaf.z}`}/><path d={`M${shut.x} ${shut.z}A${o.width} ${o.width} 0 0 ${sweep} ${leaf.x} ${leaf.z}`} strokeWidth={unit*.08}/></>:null}</g>}</g>;})}
   {labels.map(({room:r,point:p})=><g key={r.id} textAnchor="middle" fill="#38404a" fontFamily="Arial,sans-serif">{layers.names&&<text x={p.x} y={p.z} fontSize={Math.min(unit*1.65,p.clearance*1.65/Math.max(r.name.length*.6,1))}>{r.name}</text>}{layers.areas&&calibrated&&<text x={p.x} y={p.z+unit*2} fontSize={unit*1.25}>{(roomMetrics(r).area*scale.metersPerUnit!**2).toFixed(1)} م²</text>}{layers.confidence&&<text x={p.x} y={p.z-unit*2} fontSize={unit*1.1} fill="#98652a">ثقة {Math.round(r.confidence*100)}٪</text>}</g>)}
   {layers.dimensions&&calibrated&&<g stroke="#737b85" strokeWidth={unit*.1} fill="#59616b"><path d={`M${extent.x+extent.s*.14} ${extent.z+extent.s*.06}H${extent.x+extent.w-extent.s*.14}M${extent.x+extent.s*.14} ${extent.z+extent.s*.035}V${extent.z+extent.s*.12}M${extent.x+extent.w-extent.s*.14} ${extent.z+extent.s*.035}V${extent.z+extent.s*.12}`}/><text x={extent.x+extent.w/2} y={extent.z+extent.s*.045} textAnchor="middle" stroke="none" fontSize={unit*1.4}>{formatArchitectureLength(extent.w-extent.s*.28,scale)}</text></g>}
   {layers.cameras&&captures.map(s=><g key={s.id} role="button" tabIndex={0} aria-label={`انتقل إلى ${s.room}`} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onSelect(s.id);}}}><circle cx={s.position!.x} cy={s.position!.z} r={unit*1.8} fill="transparent"/><circle cx={s.position!.x} cy={s.position!.z} r={unit*(s.id===current?.75:.4)} fill={s.id===current?"#227ca7":"#8495a1"} stroke="#fff" strokeWidth={unit*.15}/><title>{s.room}</title></g>)}
   {layers.direction&&active?.position&&<path d={`M0 0L${unit*-1.7} ${unit*-3}Q0 ${unit*-4} ${unit*1.7} ${unit*-3}Z`} transform={`translate(${active.position.x} ${active.position.z}) rotate(${yaw*180/Math.PI})`} fill="#227ca7" opacity=".22"/>}
  </svg><div className="imo-architecture-zoom"><button type="button" aria-label="تكبير المخطط" onClick={()=>setZoom(z=>Math.min(5,z*1.2))}>+</button><button type="button" aria-label="تصغير المخطط" onClick={()=>setZoom(z=>Math.max(.7,z/1.2))}>−</button><button type="button" onClick={()=>{setZoom(1);setPan({x:0,z:0});}}>ملاءمة</button></div></div>}
  <footer className="imo-architecture-note">{issues.some(i=>i.severity==="error")&&<span>المخطط يحتاج مراجعة معمارية؛ لم تُعتمد هندسته بعد. </span>}{missing>0&&<span>{missing} جدارًا بسماكة غير محددة لم تُعرض كجدران مكتملة. </span>}{captures.length<scenes.filter(s=>s.floor===architecture.floor&&s.position).length&&<span>بعض مواقع الصور خارج الفراغات أو داخل عناصر معمارية؛ يلزم مراجعتها. </span>}<span>اضغط موقعًا للانتقال مباشرة إلى أقرب لقطة صالحة.</span></footer>
 </section>;
}



