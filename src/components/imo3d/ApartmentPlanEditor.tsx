"use client";
import {useEffect,useRef,useState} from "react";
import type {PlanRoom,Tour} from "@/lib/imo3d/model";
import {validateRoom} from "@/lib/imo3d/boundary-shapes";
import {Dialog} from "./Dialog";
import {api} from "./client";
import "./apartment-plan-editor.css";
type Point={x:number;z:number};
export function ApartmentPlanEditor({tour,floor,onSaved,onClose}:{tour:Tour;floor:number;onSaved:(tour:Tour)=>void;onClose:()=>void}){
  const original=tour.plans.find(plan=>plan.floor===floor),scenes=tour.scenes.filter(scene=>scene.floor===floor);
  const [rooms,setRooms]=useState<PlanRoom[]>(structuredClone(original?.authoredRooms??original?.generatedRooms??[]));
  const [baseline]=useState(()=>JSON.stringify(original?.authoredRooms??original?.generatedRooms??[]));
  const [confirmDiscard,setConfirmDiscard]=useState(false),workingRef=useRef(false);
  const [selected,setSelected]=useState<string|null>(null),[drawing,setDrawing]=useState<Point[]|null>(null);
  const [error,setError]=useState(""),[working,setWorking]=useState(false),[snap,setSnap]=useState(true),[history,setHistory]=useState<PlanRoom[][]>([]);
  const drag=useRef<{room:string;index:number;before:PlanRoom[]}|null>(null),svg=useRef<SVGSVGElement>(null);
  const [frame]=useState(()=>{
    const points=[...tour.scenes.filter(scene=>scene.floor===floor&&scene.position).map(scene=>scene.position!),...(original?.walls.flatMap(wall=>[wall.a,wall.b])??[])];
    if(!points.length)return{x:-1,z:-1,width:12,height:12};
    const xs=points.map(p=>p.x),zs=points.map(p=>p.z),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs),span=Math.max(maxX-minX,maxZ-minZ,1),padding=span*.4;
    return{x:minX-padding,z:minZ-padding,width:maxX-minX+2*padding,height:maxZ-minZ+2*padding};
  });
  const span=Math.max(frame.width,frame.height),unit=span/800,step=span/80,active=rooms.find(room=>room.id===selected);
  const dirty=JSON.stringify(rooms)!==baseline||!!drawing?.length;
  useEffect(()=>{if(!dirty)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",protect);return()=>window.removeEventListener("beforeunload",protect);},[dirty]);
  function requestClose(){if(workingRef.current)return;if(dirty)setConfirmDiscard(true);else onClose();}
  function edit(next:PlanRoom[]){if(workingRef.current)return;setHistory(previous=>[...previous.slice(-29),rooms]);setRooms(next);setError("");setConfirmDiscard(false);}
  function point(event:React.PointerEvent<SVGElement>):Point{
    const matrix=svg.current?.getScreenCTM();if(!matrix)return{x:0,z:0};
    const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    return{x:snap?Math.round(p.x/step)*step:p.x,z:snap?Math.round(p.y/step)*step:p.y};
  }
  function closeRoom(){
    if(workingRef.current||!drawing||drawing.length<3)return;
    const room:PlanRoom={id:crypto.randomUUID(),name:"غرفة "+(rooms.length+1),outline:drawing,finish:"wood",openings:[]};
    try{validateRoom(room);edit([...rooms,room]);setSelected(room.id);setDrawing(null);}catch(reason){setError(reason instanceof Error?reason.message:"حدود غير صالحة.");}
  }
  return <Dialog title={"حدود الشقة — "+tour.title} wide className="imo-boundary-dialog" onClose={requestClose}>
    <p className="imo-muted">مخطط خاص بهذه الجولة وهذا الدور. ارسم زوايا كل غرفة بالترتيب، ثم أغلقها. حرّك الزوايا لتصحيح الحدود وحدد الجدران التي تحتوي أبوابًا.</p>
    <fieldset disabled={working} className="imo-boundary-fields">
    <div className="imo-boundary-toolbar">
      <button className="imo-button secondary" disabled={working||!!drawing} onClick={()=>{setDrawing([]);setSelected(null);}}>رسم غرفة</button>
      {drawing&&<><button className="imo-button primary" disabled={drawing.length<3} onClick={closeRoom}>إغلاق حدود الغرفة</button><button className="imo-button secondary" onClick={()=>setDrawing(null)}>إلغاء الرسم</button><button className="imo-button secondary" disabled={!drawing.length} onClick={()=>setDrawing(previous=>previous?.slice(0,-1)??null)}>تراجع نقطة</button></>}
      <button className="imo-button secondary" disabled={!history.length||working||!!drawing} onClick={()=>{setRooms(history.at(-1)!);setHistory(previous=>previous.slice(0,-1));setSelected(null);}}>تراجع</button>
      <label><input type="checkbox" checked={snap} onChange={event=>setSnap(event.target.checked)}/>محاذاة الشبكة</label>
    </div>
    <div className="imo-boundary-layout"><div className="imo-boundary-board">
      <svg ref={svg} viewBox={[frame.x,frame.z,frame.width,frame.height].join(" ")} role="application" aria-label="محرر حدود غرف الشقة" aria-busy={working}
        onPointerDown={event=>{if(!workingRef.current&&drawing&&event.button===0)setDrawing(previous=>[...(previous??[]),point(event)]);}}
        onPointerMove={event=>{const target=drag.current;if(workingRef.current||!target)return;const p=point(event);setRooms(previous=>previous.map(room=>room.id===target.room?{...room,outline:room.outline.map((old,index)=>index===target.index?p:old)}:room));}}
        onPointerUp={()=>{const target=drag.current;if(target){setHistory(previous=>[...previous.slice(-29),target.before]);drag.current=null;}}}
        onPointerCancel={()=>{if(drag.current)setRooms(drag.current.before);drag.current=null;}}>
        <defs><pattern id="boundary-grid" width={step} height={step} patternUnits="userSpaceOnUse"><path d={"M"+step+" 0H0V"+step} fill="none" stroke="#d9e3df" strokeWidth={unit*.45}/></pattern></defs>
        <rect x={frame.x} y={frame.z} width={frame.width} height={frame.height} fill="url(#boundary-grid)"/>
        {!rooms.length&&original?.walls.map((wall,index)=><line key={index} x1={wall.a.x} y1={wall.a.z} x2={wall.b.x} y2={wall.b.z} stroke="#a7b5b0" strokeWidth={unit*1.5}/>)}
        {rooms.map(room=><g key={room.id}>
          <polygon points={room.outline.map(p=>p.x+","+p.z).join(" ")} fill={room.finish==="wood"?"#dec7a8":room.finish==="tile"?"#d9e5e3":"#dedbd5"} fillOpacity={.75} stroke={selected===room.id?"#1d9c77":"#465e54"} strokeWidth={unit*(selected===room.id?4:2)} onPointerDown={event=>{if(!workingRef.current&&!drawing){event.stopPropagation();setSelected(room.id);}}}/>
          <text x={room.outline.reduce((sum,p)=>sum+p.x,0)/room.outline.length} y={room.outline.reduce((sum,p)=>sum+p.z,0)/room.outline.length} textAnchor="middle" dominantBaseline="middle" fontSize={unit*15} fill="#304a40" pointerEvents="none">{room.name}</text>
          {selected===room.id&&room.outline.map((p,index)=><g key={index}>
            <circle cx={p.x} cy={p.z} r={unit*7} fill="#fff" stroke="#1d9c77" strokeWidth={unit*2} onPointerDown={event=>{event.stopPropagation();if(workingRef.current||event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={room:room.id,index,before:structuredClone(rooms)};}}/>
            <text x={(p.x+room.outline[(index+1)%room.outline.length].x)/2} y={(p.z+room.outline[(index+1)%room.outline.length].z)/2} fontSize={unit*11} fill="#256653" pointerEvents="none">{index+1}{room.openings.includes(index)?" باب":""}</text>
          </g>)}
        </g>)}
        {scenes.filter(scene=>scene.position).map(scene=><g key={scene.id}><title>{scene.name}</title><circle cx={scene.position!.x} cy={scene.position!.z} r={unit*3} fill="#1d9c77" stroke="#fff" strokeWidth={unit}/></g>)}
        {drawing&&<><polyline points={drawing.map(p=>p.x+","+p.z).join(" ")} fill="none" stroke="#1d9c77" strokeWidth={unit*3}/>{drawing.map((p,index)=><circle key={index} cx={p.x} cy={p.z} r={unit*5} fill="#1d9c77"/>)}</>}
      </svg>
      <span>{drawing?"اضغط على زوايا الغرفة ثم أغلق الحدود":"النقاط الخضراء مواقع الصور المتاحة · اسحب الزوايا البيضاء للتعديل"}</span>
    </div><aside className="imo-form">
      <strong>غرف هذا المخطط</strong><div className="imo-boundary-room-list">{rooms.map(room=><button type="button" disabled={!!drawing} className={selected===room.id?"selected":""} key={room.id} onClick={()=>setSelected(room.id)}>{room.name}</button>)}</div>
      {active?<><label>اسم الغرفة<input maxLength={100} value={active.name} onChange={event=>setRooms(previous=>previous.map(room=>room.id===active.id?{...room,name:event.target.value}:room))}/></label>
        <label>لون الأرضية<select value={active.finish} onChange={event=>edit(rooms.map(room=>room.id===active.id?{...room,finish:event.target.value as PlanRoom["finish"]}:room))}><option value="wood">خشب</option><option value="tile">بلاط</option><option value="stone">حجر</option></select></label>
        <span>أبواب الجدران</span><div className="imo-boundary-doors">{active.outline.map((_,index)=><label key={index}><input type="checkbox" checked={active.openings.includes(index)||!!active.doorwayCandidates?.some(door=>door.edge===index)} onChange={()=>edit(rooms.map(room=>room.id===active.id?{...room,openings:room.openings.includes(index)||room.doorwayCandidates?.some(door=>door.edge===index)?room.openings.filter(i=>i!==index):[...room.openings,index],doorwayCandidates:room.doorwayCandidates?.filter(door=>door.edge!==index)}:room))}/>{index+1}</label>)}</div>
        <button className="imo-button danger" onClick={()=>{edit(rooms.filter(room=>room.id!==active.id));setSelected(null);}}>حذف حدود هذه الغرفة</button>
      </>:<p className="imo-muted">اختر غرفة أو ابدأ برسم حدود جديدة.</p>}
    </aside></div>
    </fieldset>
    <p className="imo-muted">هذه الحدود تعتمد على مراجعتك. المقياس يبقى نسبيًا ما لم تكن بيانات الجولة معايرة. يحفظ التعديل مخطط 2D و3D لهذه الشقة، ويوقف التحليل الجاري لحمايته.</p>
    {error&&<p className="imo-error" role="alert">{error}</p>}
    {confirmDiscard&&<div className="imo-boundary-discard" role="alert"><p>لديك حدود لم تُحفظ. هل تريد تجاهلها وإغلاق المحرر؟</p><button type="button" className="imo-button secondary" onClick={()=>setConfirmDiscard(false)}>متابعة التحرير</button><button type="button" className="imo-button danger" onClick={onClose}>تجاهل التعديلات</button></div>}
    {!rooms.length&&!!original?.authoredRooms?.length&&<p className="imo-muted">سيحذف الحفظ الحدود اليدوية لهذا الدور ويعيد عرض بيانات الصور المتاحة. تبقى الصور والغرف في الأدوار الأخرى محفوظة.</p>}
    <div className="imo-dialog-actions"><button className="imo-button primary" disabled={working||(!rooms.length&&!original?.authoredRooms?.length)||!!drawing} onClick={async()=>{
      if(workingRef.current||drag.current)return;setError("");try{for(const room of rooms)validateRoom(room);workingRef.current=true;setWorking(true);setConfirmDiscard(false);const saved=await api<Tour>("tours/"+tour.id+"/boundaries",{method:"PUT",body:JSON.stringify({revision:tour.revision,floor,rooms})});onSaved(saved);onClose();}
      catch(reason){setError(reason instanceof Error?reason.message:"تعذر الحفظ.");}finally{workingRef.current=false;setWorking(false);}
    }}>{working?"جارٍ الحفظ…":rooms.length?"اعتماد حدود هذه الشقة":"مسح الحدود اليدوية لهذا الدور"}</button><button className="imo-button secondary" disabled={working} onClick={requestClose}>إلغاء</button></div>
  </Dialog>;
}
