"use client";
import {useId,useMemo,useRef,useState} from "react";
import type {Plan,PlanRoom,Point,Scene} from "@/lib/imo3d/model";
import {captureLabel,roomIdentity,unnamedRoom} from "./room-labels";
import {pointInRoom} from "@/lib/imo3d/boundary-shapes";
import {floorPlanDoorways} from "./floorplan-doorways";
import {floorPlanPoints,floorPlanProjection,floorPlanRoomLabels,floorPlanRooms,floorPlanViewport} from "./floorplan-geometry";
import {selectFloorPlanCapture} from "./floorplan-selection";
import "./floorplan.css";

type FloorPlanProps={
  plan:Plan;scenes:Scene[];current:string;yaw:number;onSelect:(id:string)=>void;
  compact?:boolean;position?:Point|null;onExpand?:()=>void;
};

function architecturalLabel(room:PlanRoom){
  const xs=room.outline.map(p=>p.x),zs=room.outline.map(p=>p.z),minX=Math.min(...xs),minZ=Math.min(...zs),width=Math.max(...xs)-minX,depth=Math.max(...zs)-minZ;
  const candidates=Array.from({length:81},(_,index)=>({x:minX+width*((index%9)+.5)/9,z:minZ+depth*(Math.floor(index/9)+.5)/9}));
  const clearance=(point:{x:number;z:number})=>Math.min(...room.outline.map((a,index)=>{const b=room.outline[(index+1)%room.outline.length],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz||1)));return Math.hypot(point.x-a.x-dx*t,point.z-a.z-dz*t);}));
  const center={x:minX+width/2,z:minZ+depth/2};if(pointInRoom(center,room.outline))candidates.unshift(center);
  const inside=candidates.filter(point=>pointInRoom(point,room.outline));
  const anchor=inside.sort((a,b)=>clearance(b)-clearance(a))[0]??room.outline[0];return {...anchor,clearance:clearance(anchor)};
}
function labelLines(name:string,limit=15){
  if(name.length<=limit)return[name];const words=name.split(/\s+/),lines=[""];
  for(const word of words){const index=lines.length-1;if(lines[index]&&(lines[index]+" "+word).length>limit&&lines.length<2)lines.push(word);else lines[index]+=(lines[index]?" ":"")+word;}
  return lines.map(line=>line.length>23?line.slice(0,22)+"…":line);
}

export function FloorPlan({plan,scenes,current,yaw,onSelect,compact=false,position,onExpand}:FloorPlanProps) {
  const [zoom,setZoom]=useState(1),[focused,setFocused]=useState<string|null>(null),[showCaptures,setShowCaptures]=useState(false);
  const gradientId=useId().replace(/:/g,"");
  const pointer=useRef<{x:number;y:number;moved:boolean}|null>(null);
  const points=useMemo(()=>floorPlanPoints(plan,scenes),[plan,scenes]);
  const projection=useMemo(()=>floorPlanProjection(plan,scenes),[plan,scenes]);
  const rooms=useMemo(()=>floorPlanRooms(points),[points]);
  const viewport=floorPlanViewport(plan);
  const active=points.find(point=>point.scene.id===current);
  const activePoint=active&&position&&projection?projection.project(position):active?.point;
  const heading=projection?.heading(yaw)??yaw*180/Math.PI+(plan.rotation??0);
  const mapZoom=compact?1:zoom;
  const viewWidth=viewport.width/mapZoom,viewHeight=viewport.height/mapZoom;
  const center=activePoint??{x:viewport.x+viewport.width/2,y:viewport.y+viewport.height/2};
  const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
  const viewX=clamp(center.x-viewWidth/2,viewport.x,viewport.x+viewport.width-viewWidth);
  const viewY=clamp(center.y-viewHeight/2,viewport.y,viewport.y+viewport.height-viewHeight);
  const unit=Math.max(viewWidth,viewHeight)/(compact?280:500),radius=5.5*unit;
  const width=plan.width??plan.bounds.maxX-plan.bounds.minX,height=plan.height??plan.bounds.maxZ-plan.bounds.minZ;
  const boundaryRooms=plan.authoredRooms??plan.generatedRooms;
  const roomLabels=useMemo(()=>new Map((boundaryRooms??[]).map(room=>[room.id,architecturalLabel(room)])),[boundaryRooms]);
  const doorways=useMemo(()=>floorPlanDoorways(plan),[plan]);
  const selectionRooms=useMemo(()=>(boundaryRooms??[]).map(room=>({id:room.id,outline:room.outline.map(point=>({x:point.x-plan.bounds.minX,z:point.z-plan.bounds.minZ}))})),[boundaryRooms,plan.bounds.minX,plan.bounds.minZ]);
  const selectionCaptures=useMemo(()=>{const locations=new Map(points.map(item=>[item.scene.id,item.point]));return scenes.filter(scene=>scene.floor===plan.floor).map(scene=>{const point=locations.get(scene.id);return{id:scene.id,roomId:scene.roomSemantic?.groupId,point:point?{x:point.x,z:point.y}:null};});},[scenes,points,plan.floor]);
  const selectAt=(svg:SVGSVGElement|null,x:number,y:number,roomId?:string)=>{const matrix=svg?.getScreenCTM();if(!matrix)return;const point=new DOMPoint(x,y).matrixTransform(matrix.inverse());const id=selectFloorPlanCapture(selectionCaptures,selectionRooms,{x:point.x,z:point.y},{roomId});if(id)onSelect(id);};
  const labels=floorPlanRoomLabels(boundaryRooms?.length?[]:rooms.filter(room=>!unnamedRoom(room.name)&&(!compact||!/حمام|ممر|المدخل/.test(room.name))),unit,viewport);
  if(plan.reviewStatus==="rejected")return <div className="imo-floorplan-empty" role="status"><p>المخطط قيد المراجعة؛ لم تُعتمد هندسة هذا الدور بعد.</p></div>;
  if(plan.kind==="missing")return <div className="imo-floorplan-empty"><p>سيظهر مخطط الشقة بعد اكتمال المعالجة المكانية.</p></div>;
  return <section className={`imo-floorplan${compact?" imo-floorplan--compact":""}`} data-captures={showCaptures?"visible":"hidden"} aria-label="مخطط الشقة">
    <header className="imo-floorplan-header">
      <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/></svg><span>{compact?"مخطط الشقة":plan.label}</span></span>
      {compact&&onExpand?<button type="button" onClick={onExpand} aria-label="تكبير مخطط الشقة" title="تكبير المخطط"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button>:!compact&&<div className="imo-floorplan-zoom" aria-label="حجم المخطط">
        <button type="button" onClick={()=>setZoom(value=>Math.min(2.5,value+0.5))} disabled={zoom>=2.5} aria-label="تكبير المخطط">+</button>
        <button type="button" onClick={()=>setZoom(1)} disabled={zoom===1} aria-label="إظهار المخطط كاملًا">{Math.round(zoom*100)}%</button>
        <button type="button" onClick={()=>setZoom(value=>Math.max(1,value-0.5))} disabled={zoom<=1} aria-label="تصغير المخطط">−</button>
      </div>}
    </header>
    {!compact&&<div className="imo-floorplan-reading-tools"><span>اضغط في أي مكان للانتقال إلى أقرب لقطة</span><label><input type="checkbox" checked={showCaptures} onChange={event=>setShowCaptures(event.target.checked)}/>مواقع اللقطات</label></div>}
    <div className="imo-floorplan-drawing">
      <svg viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} role="group" aria-label="اختر غرفة أو موقعًا للانتقال إليه" preserveAspectRatio="xMidYMid meet"
        onPointerDownCapture={event=>{if(event.isPrimary)pointer.current={x:event.clientX,y:event.clientY,moved:false};else if(pointer.current)pointer.current.moved=true;}}
        onPointerMoveCapture={event=>{if(pointer.current&&Math.hypot(event.clientX-pointer.current.x,event.clientY-pointer.current.y)>5)pointer.current.moved=true;}}
        onPointerCancel={()=>{pointer.current=null;}}
        onClickCapture={event=>{if(event.detail>0&&pointer.current?.moved){event.preventDefault();event.stopPropagation();}pointer.current=null;}}
        onClick={event=>selectAt(event.currentTarget,event.clientX,event.clientY)}>
        <defs><radialGradient id={gradientId} cx="50%" cy="100%" r="100%"><stop offset="0%" stopColor="#2baa82" stopOpacity=".45"/><stop offset="100%" stopColor="#2baa82" stopOpacity="0"/></radialGradient>
          <pattern id={gradientId+"-wood"} width={unit*30} height={unit*9} patternUnits="userSpaceOnUse"><rect width={unit*30} height={unit*9} fill="#eadfcd"/><path d={`M0 0H${unit*30}M0 ${unit*9}V0M${unit*15} 0V${unit*9}`} fill="none" stroke="#caba9f" strokeOpacity=".35" strokeWidth={unit*.4}/></pattern>
          <pattern id={gradientId+"-tile"} width={unit*15} height={unit*15} patternUnits="userSpaceOnUse"><rect width={unit*15} height={unit*15} fill="#e9eeea"/><path d={`M0 ${unit*15}V0H${unit*15}`} fill="none" stroke="#c6d0c7" strokeOpacity=".5" strokeWidth={unit*.45}/></pattern>
          <pattern id={gradientId+"-stone"} width={unit*11} height={unit*11} patternUnits="userSpaceOnUse"><rect width={unit*11} height={unit*11} fill="#e7e6df"/><circle cx={unit*3} cy={unit*4} r={unit*.45} fill="#c7c8be" opacity=".5"/></pattern>
        </defs>
        {plan.image&&<image href={plan.image} width={width} height={height} className="imo-floorplan-source"/>}
        {boundaryRooms?.map(room=>{const member=scenes.find(scene=>scene.floor===plan.floor&&scene.roomSemantic?.groupId===room.id),target=member??scenes.find(scene=>scene.floor===plan.floor&&scene.position&&pointInRoom(scene.position,room.outline));const name=plan.authoredRooms?room.name:member?.room??room.name,anchor=roomLabels.get(room.id)!,lines=labelLines(name,Math.max(6,Math.min(15,Math.floor(anchor.clearance*1.7/(unit*10.5*.6))))),fontSize=Math.min(unit*10.5,anchor.clearance*1.25/(lines.length*1.3),anchor.clearance*1.7/(Math.max(...lines.map(line=>line.length))*.6));return <g key={room.id} className="imo-floorplan-footprint" role={target?"button":undefined} tabIndex={target?0:undefined} aria-label={target?"انتقل إلى "+name:name} onClick={event=>{event.stopPropagation();selectAt(event.currentTarget.ownerSVGElement,event.clientX,event.clientY,room.id);}} onKeyDown={event=>{if(target&&(event.key==="Enter"||event.key===" ")){event.preventDefault();const id=selectFloorPlanCapture(selectionCaptures,selectionRooms,{x:anchor.x-plan.bounds.minX,z:anchor.z-plan.bounds.minZ},{roomId:room.id});if(id)onSelect(id);}}}>
          <polygon points={room.outline.map(point=>(point.x-plan.bounds.minX)+","+(point.z-plan.bounds.minZ)).join(" ")} fill={`url(#${gradientId}-${room.finish})`}/>
          <title>{name}</title>{!compact&&fontSize>=unit*7&&<text className="imo-floorplan-architectural-label" x={anchor.x-plan.bounds.minX} y={anchor.z-plan.bounds.minZ} fontSize={fontSize} textAnchor="middle" dominantBaseline="middle" strokeWidth={fontSize/3}>{lines.map((line,index)=><tspan key={index} x={anchor.x-plan.bounds.minX} dy={index===0?-(lines.length-1)*fontSize*.65:fontSize*1.3}>{line}</tspan>)}</text>}
        </g>;})}
        {!plan.image&&<g className="imo-floorplan-wall-ink" fill="none" strokeLinecap="butt">{plan.walls.map((wall,i)=><line key={i} x1={wall.a.x-plan.bounds.minX} y1={wall.a.z-plan.bounds.minZ} x2={wall.b.x-plan.bounds.minX} y2={wall.b.z-plan.bounds.minZ} stroke="#3f4b44" strokeWidth={(boundaryRooms?.length?4.2:1.2)*unit}/>)}</g>}
        {doorways.map((door,index)=>{const ax=door.a.x-plan.bounds.minX,az=door.a.z-plan.bounds.minZ,bx=door.b.x-plan.bounds.minX,bz=door.b.z-plan.bounds.minZ,nx=-(bz-az)/door.length,nz=(bx-ax)/door.length,jamb=unit*3.2,estimated=door.source==="estimated";return <g key={index} className={`imo-floorplan-doorway${estimated?" is-estimated":""}`} fill="none" strokeWidth={unit*1.2} role="img" aria-label={estimated?"جزء مرئي من فتحة مقدّرة، لا يمثل العرض الكامل للباب":"فتحة محددة يدويًا"}>
          <title>{estimated?`جزء مرئي من فتحة مقدّرة · ثقة ${Math.round(door.confidence*100)}٪ · لا يمثل العرض الكامل للباب · اتجاه الفتح غير محدد`:"فتحة محددة يدويًا · اتجاه الفتح غير محدد"}</title>
          <path d={`M${ax-nx*jamb} ${az-nz*jamb}L${ax+nx*jamb} ${az+nz*jamb}M${bx-nx*jamb} ${bz-nz*jamb}L${bx+nx*jamb} ${bz+nz*jamb}`} strokeWidth={unit*1.7}/>
          <path d={`M${ax} ${az}L${bx} ${bz}`} strokeDasharray={estimated?`${unit*2.5} ${unit*2}`:undefined} opacity={estimated?.85:.5}/>
        </g>;})}
        {!boundaryRooms?.length&&plan.kind==="estimated"&&plan.estimatedSurfaces?.map((surface,i)=><line key={`surface-${i}`} x1={surface.a.x-plan.bounds.minX} y1={surface.a.z-plan.bounds.minZ} x2={surface.b.x-plan.bounds.minX} y2={surface.b.z-plan.bounds.minZ} stroke="#6c8b81" strokeOpacity={.65} strokeWidth={1.7*unit} strokeDasharray={`${4*unit} ${2*unit}`}/>)}
        {points.map(({scene,point})=><g key={scene.id} role="button" tabIndex={compact?-1:0} aria-label={`انتقل إلى ${captureLabel(scene,scenes)}`} aria-pressed={scene.id===current} onClick={event=>{event.stopPropagation();onSelect(scene.id);}} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(scene.id);}}} onFocus={()=>setFocused(scene.id)} onBlur={()=>setFocused(null)} className={`imo-floorplan-point${scene.id===current?" is-current":""}`}>
          <title>{captureLabel(scene,scenes)}</title><circle cx={point.x} cy={point.y} r={radius*2.4} fill="transparent"/>
          <circle className="imo-floorplan-stop" cx={point.x} cy={point.y} r={radius*.45} fill="#909ba8" stroke="#fff" strokeWidth={unit}/>
          {focused===scene.id&&<circle cx={point.x} cy={point.y} r={radius*1.6} fill="none" stroke="#2baa82" strokeWidth={unit*1.5}/>}
        </g>)}
        {labels.map(({id,name,scene,label,width:labelWidth,height:labelHeight})=><g key={id} className={`imo-floorplan-room${active&&roomIdentity(active.scene)===id?" is-current":""}`} role="button" tabIndex={0} aria-label={`انتقل إلى ${name}`} aria-pressed={!!active&&roomIdentity(active.scene)===id} onClick={event=>{event.stopPropagation();onSelect(scene.id);}} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(scene.id);}}} transform={`translate(${label.x} ${label.y})`}>
          <title>{name}</title>
          <rect x={-labelWidth/2} y={-labelHeight/2} width={labelWidth} height={labelHeight} rx={5*unit}/>
          <text textAnchor="middle" dominantBaseline="central" fontSize={(compact?10:11)*unit} direction="rtl">{name}</text>
        </g>)}
        {activePoint&&<g className="imo-floorplan-camera" transform={`translate(${activePoint.x} ${activePoint.y})`} aria-label="موقعك الحالي" role="img">
          <g transform={`rotate(${heading})`}><path d={`M0 0 L${-radius*4.2} ${-radius*7.2} Q0 ${-radius*10} ${radius*4.2} ${-radius*7.2} Z`} fill={`url(#${gradientId})`}/><path d={`M0 ${-radius*2.7} L${-radius*.8} ${-radius*1.4} L${radius*.8} ${-radius*1.4} Z`} fill="#2baa82"/></g>
          <circle r={radius*1.7} fill="#2baa82" opacity=".12"/><circle r={radius} fill="#2baa82" stroke="#fff" strokeWidth={radius*.4}/>
        </g>}
      </svg>
    </div>
    <div className="imo-floorplan-location"><span className="imo-floorplan-location-dot"/><span>{active?captureLabel(active.scene,scenes):plan.label}</span><small>{compact?"اختر غرفة للانتقال":"النقطة الخضراء هي موقعك واتجاه نظرك"}</small></div>
    {!compact&&doorways.length>0&&<p className="imo-floorplan-door-legend">{doorways.some(door=>door.source==="manual")&&<span><i/>فتحة محددة يدويًا</span>}{doorways.some(door=>door.source==="estimated")&&<span><i className="is-estimated"/>جزء مرئي من فتحة مقدّرة</span>}<small>{doorways.some(door=>door.source==="estimated")&&"الجزء المرصود لا يحدد العرض الكامل للباب. "}علامة الفتحة لا تحدد مفصلات الباب أو اتجاه فتحه</small></p>}
    {plan.kind==="path"&&<p className="imo-floorplan-caption">حدود الشقة غير متوفرة بعد</p>}
    {plan.kind==="estimated"&&<p className="imo-floorplan-caption">{plan.generatedRooms?.length?"حدود مستخرجة من الصور · تقديرية دون مقياس":"تقدير تلقائي من الصور · دون مقياس"}{!compact&&!plan.generatedRooms?.length&&". الخطوط المتقطعة أسطح مرصودة قد تشمل الأثاث؛ ليست حدودًا معمارية مؤكدة."}</p>}
    {plan.kind==="depth"&&!compact&&<p className="imo-floorplan-caption">مخطط مستخرج من العمق؛ قد تظهر فيه قطع الأثاث.</p>}
  </section>;
}
