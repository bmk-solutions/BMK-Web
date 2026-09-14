"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import type {Plan,Scene} from "@/lib/imo3d/model";
import {currentTexturedMesh} from "@/lib/imo3d/mesh-model";
import {Icon} from "./Icon";
import {captureLabel,roomIdentity,unnamedRoom} from "./room-labels";
import {buildFloorPlan3D} from "./floorplan3d-geometry";
import type {FloorPlan3DRenderer} from "./FloorPlan3DRenderer";
import type {ApartmentModelState} from "./TexturedApartmentModel";
import "./floorplan3d.css";

type Props={plan:Plan;scenes:Scene[];current:string;yaw:number;onSelect:(id:string)=>void;spatialScale?:"metric"|"relative";flat?:boolean};
export function FloorPlan3D({plan,scenes,current,yaw,onSelect,spatialScale,flat=false}:Props){
  const layout=useMemo(()=>buildFloorPlan3D(plan,scenes,spatialScale),[plan,scenes,spatialScale]);
  // Switching floors creates fresh controls without moving a camera into another floor's coordinates.
  const surface=currentTexturedMesh(plan,scenes);
  if(plan.reviewStatus==="rejected")return <section className="imo-plan-review-state" role="status"><h3>المخطط قيد المراجعة</h3><p>لم تُعتمد هندسة هذا الدور بعد.</p></section>;
  return <FloorPlan3DSurface key={`${plan.floor}/${plan.kind}/${surface?.url??"diagram"}/${flat}`} plan={plan} scenes={scenes} layout={layout} flat={flat} current={current} yaw={yaw} onSelect={onSelect}/>;
}
function FloorPlan3DSurface({plan,scenes,layout,current,yaw,onSelect,flat=false}:Omit<Props,"spatialScale">&{layout:ReturnType<typeof buildFloorPlan3D>}){
  const canvas=useRef<HTMLCanvasElement>(null),runtime=useRef<FloorPlan3DRenderer|null>(null);
  const [error,setError]=useState(""),[ready,setReady]=useState(false),[pan,setPan]=useState(false),[lowWalls,setLowWalls]=useState(false),[labels,setLabels]=useState(false);
  const [photographic,setPhotographic]=useState<ApartmentModelState>({status:"unavailable",active:false});
  const latest=useRef({current,yaw,onSelect,pan,lowWalls,labels});
  const hasSpatial=!!(layout.cameras.length||layout.walls.length||layout.estimatedSurfaces.length);
  const active=scenes.find(scene=>scene.id===current&&scene.floor===plan.floor);
  const manualDoors=plan.authoredRooms?.some(room=>room.openings.length),estimatedDoors=(plan.authoredRooms??plan.generatedRooms??[]).some(room=>room.doorwayCandidates?.length||!plan.authoredRooms&&room.openings.length);
  useEffect(()=>{latest.current={current,yaw,onSelect,pan,lowWalls,labels};runtime.current?.setCurrent(current,yaw);},[current,yaw,onSelect,pan,lowWalls,labels]);
  useEffect(()=>{
    if(!hasSpatial)return;let stopped=false,renderer:FloorPlan3DRenderer|undefined,observer:ResizeObserver|undefined;
    const element=canvas.current!;
    void import("./FloorPlan3DRenderer").then(({FloorPlan3DRenderer})=>{
      if(stopped)return;renderer=new FloorPlan3DRenderer(element,layout,plan,scenes,id=>latest.current.onSelect(id),message=>{if(!stopped)setError(message);},state=>{if(!stopped)setPhotographic(state);},flat);runtime.current=renderer;
      renderer.setCurrent(latest.current.current,latest.current.yaw);renderer.setPan(latest.current.pan);renderer.setLowWalls(latest.current.lowWalls);renderer.setLabels(latest.current.labels);
      observer=new ResizeObserver(([entry])=>renderer?.resize(entry.contentRect.width,entry.contentRect.height));observer.observe(element);renderer.resize(element.clientWidth,element.clientHeight);setReady(true);
    }).catch(reason=>{if(!stopped)setError(reason instanceof Error?reason.message:"هذا الجهاز لا يدعم عرض المخطط ثلاثي الأبعاد.");});
    return()=>{stopped=true;observer?.disconnect();renderer?.dispose();runtime.current=null;};
  },[layout,plan,scenes,hasSpatial,flat]);
  const enabled=ready&&!error,roomOptions=layout.rooms.filter(room=>!unnamedRoom(room.name));
  return <section className={`imo-plan3d${flat?" imo-plan3d--flat":""}${photographic.active?" imo-plan3d--photographic":""}`} aria-label={flat?"المسقط الثنائي الأبعاد من المجسّم":"المخطط التفاعلي ثلاثي الأبعاد"}>
    <header className="imo-plan3d-header"><div><span className="imo-plan3d-badge">{flat?"2D":"3D"}</span><span><strong>{plan.label}</strong><small>{photographic.active?(flat?"مسقط علوي من المجسّم":"مجسّم مكسوّ بصور المكان"):layout.walls.length?"عرض مجسّم للمخطط المتاح":layout.estimatedSurfaces.length?"الأسطح المرصودة ومواقع التصوير":"مواقع التصوير"}</small></span></div><div className="imo-plan3d-view-buttons" hidden={flat}><button type="button" disabled={!enabled} onClick={()=>runtime.current?.reset()} title="إعادة ضبط زاوية العرض"><Icon name="layers" size={17}/><span>منظور</span></button><button type="button" disabled={!enabled} onClick={()=>runtime.current?.reset(true)} title="عرض المخطط من الأعلى"><Icon name="map" size={17}/><span>علوي</span></button></div></header>
    {photographic.status!=="unavailable"&&<div className="imo-plan3d-source"><div role="group" aria-label="مصدر العرض ثلاثي الأبعاد"><button type="button" disabled={!enabled||photographic.status!=="ready"} aria-pressed={photographic.active} onClick={()=>runtime.current?.setPhotographic(true)}>من الصور</button><button type="button" disabled={!enabled} aria-pressed={!photographic.active} onClick={()=>runtime.current?.setPhotographic(false)}>المخطط</button></div><span role="status">{photographic.status==="loading"?"جارٍ تحميل المجسّم المكسوّ بالصور…":photographic.status==="error"?"تعذر تحميل عرض الصور. يمكنك استخدام المخطط.":photographic.active?"أسطح متصلة · صور المكان الأصلية":"حدود الغرف والفتحات"}</span></div>}
    <div className="imo-plan3d-stage">
      {hasSpatial?<canvas ref={canvas} tabIndex={0} aria-label="اسحب لاستكشاف المخطط، واستخدم العجلة للتكبير أو التصغير. اضغط داخل الغرفة لفتح أقرب صورة."/>:<div className="imo-plan3d-empty"><Icon name="layers" size={36}/><h3>المخطط المجسّم بانتظار مواقع التصوير</h3><p>الروابط اليدوية وحدها لا تحدّد شكل الشقة. يمكنك فتح الغرف من القائمة أدناه، ثم معالجة الصور أو استيراد المعايرة لإظهارها مكانيًا.</p></div>}
      {hasSpatial&&!ready&&!error&&<div className="imo-plan3d-loading" role="status"><span className="imo-spinner"/><span>جارٍ تحضير المخطط…</span></div>}
      {error&&<div className="imo-plan3d-empty error" role="alert"><Icon name="info" size={30}/><p>{error}</p><span>المخطط ثنائي الأبعاد وقائمة الغرف يظلان متاحين.</span></div>}
      {enabled&&<><div className="imo-plan3d-location"><i/><span>{active?captureLabel(active,scenes):"استكشف المخطط"}</span><small>{layout.metric&&!photographic.active?"مواقع بمقياس معاير":"مقياس نسبي"}</small></div><div className="imo-plan3d-tools"><button type="button" onClick={()=>runtime.current?.zoom(.8)} aria-label="تكبير المخطط">+</button><button type="button" onClick={()=>runtime.current?.zoom(1.25)} aria-label="تصغير المخطط">−</button><span/><button type="button" aria-pressed={pan} title={pan?"العودة إلى تدوير المخطط":"تحريك المخطط بالسحب"} aria-label="تحريك المخطط بالسحب" onClick={()=>{setPan(value=>!value);runtime.current?.setPan(!pan);}} className={pan?"active":""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3"/></svg></button></div><div className="imo-plan3d-hint">{flat||pan?"اسحب لتحريك المخطط":"اسحب لتدوير المجسّم"}<span>·</span>قرّب بإصبعين<span>·</span>اضغط داخل الغرفة للانتقال</div></>}
    </div>
    {hasSpatial&&<div className="imo-plan3d-options">{(layout.walls.length>0||layout.estimatedSurfaces.length>0||photographic.status==="ready")&&<button type="button" disabled={!enabled} aria-pressed={lowWalls} className={lowWalls?"selected":""} onClick={()=>{setLowWalls(value=>!value);runtime.current?.setLowWalls(!lowWalls);}}>{photographic.active?"إظهار الداخل":"جدران منخفضة"}</button>}<button type="button" disabled={!enabled} aria-pressed={labels} className={labels?"selected":""} onClick={()=>{setLabels(value=>!value);runtime.current?.setLabels(!labels);}}>أسماء الغرف</button><span><i/>موقع التصوير{layout.estimatedSurfaces.length>0&&<><b/>أسطح غير مؤكدة</>}</span></div>}
    {roomOptions.length>0&&<nav className="imo-plan3d-rooms" aria-label="انتقل إلى غرفة من المخطط">{roomOptions.map(room=>{const selected=!!active&&(roomIdentity(active)===room.id||active.roomSemantic?.groupId===room.id||active.id===room.sceneId);return <button type="button" key={room.id} disabled={!room.sceneId} onClick={()=>onSelect(room.sceneId)} aria-pressed={selected} className={selected?"selected":""}><span>{room.name}</span>{!room.positioned&&<small>بلا موقع</small>}</button>;})}</nav>}
    {!photographic.active&&(manualDoors||estimatedDoors)&&<p className="imo-plan3d-door-key">{manualDoors&&<span><i/>فتحات محددة يدويًا</span>}{estimatedDoors&&<span><i className="is-estimated"/>أجزاء مرئية من فتحات مقدّرة</span>}<small>{estimatedDoors&&"الجزء المرصود لا يمثل العرض الكامل للباب. "}ارتفاع الإطار توضيحي</small></p>}
    <p className="imo-plan3d-caption"><Icon name="info" size={15}/><span>{photographic.active?"مجسّم تقديري من الصور. بعض الأسطح غير مرصودة؛ المقياس نسبي ويحتاج معايرة للأبعاد.":plan.generatedFrom?"مخطط تقديري من الصور بمقياس نسبي. الخامات وارتفاع الجدران للعرض؛ الأبواب تحتاج مراجعة.":layout.walls.length?"الخامات وارتفاع الجدران وسماكتها للعرض التوضيحي؛ ليست قياسات رأسية مستخرجة من الصور.":layout.estimatedSurfaces.length?"الأسطح الشفافة تقديرات قد تشمل الأثاث. لا تمثّل جدرانًا معمارية مؤكدة أو قياسات بالمتر.":"لا توجد حدود معمارية متاحة لهذا الدور."}{layout.truncated&&" عُرضت نسخة مبسطة من الخطوط للحفاظ على سلاسة الحركة."}</span></p>
  </section>;
}
