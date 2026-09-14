"use client";
/* eslint-disable @next/next/no-img-element */
import {useEffect,useRef,useState} from "react";
import type {Scene,Tour} from "@/lib/imo3d/model";
import {angleDifference,radians} from "@/lib/imo3d/spatial";
import type {PanoramaEngine} from "./PanoramaEngine";
import {api,number} from "./client";
import {Icon} from "./Icon";
import "./manual-links.css";

type Props={tour:Tour;onChange:(tour:Tour)=>void;onError?:(message:string)=>void;onNotice?:(message:string)=>void;disabled?:boolean;onBusyChange?:(working:boolean)=>void};
const degrees=(yaw:number)=>((yaw*180/Math.PI+180)%360+360)%360-180;
const bearing=(from:Scene,to:Scene)=>from.manualLinks?.find(link=>link.targetId===to.id)?.yaw??(from.position&&to.position?Math.atan2(to.position.x-from.position.x,-(to.position.z-from.position.z))*180/Math.PI:from.yaw);

export function ManualLinkEditor({tour,...props}:Props){
  const [fromId,setFromId]=useState(()=>tour.scenes.find(scene=>tour.scenes.some(peer=>peer.id!==scene.id&&peer.floor===scene.floor))?.id??tour.scenes[0]?.id??""),[toId,setToId]=useState("");
  const [pairBusy,setPairBusy]=useState(false);
  const from=tour.scenes.find(scene=>scene.id===fromId)??tour.scenes[0];
  const candidates=from?tour.scenes.filter(scene=>scene.id!==from.id&&scene.floor===from.floor):[];
  const to=candidates.find(scene=>scene.id===toId)??candidates[0];
  if(!from)return <div className="imo-empty small"><Icon name="link" size={30}/><h3>أضف صورتين في الدور نفسه</h3><p>يمكنك ربطهما بصريًا حتى لو لم يكتشف الربط التلقائي الممر بينهما.</p></div>;
  return <section className="imo-manual-links" aria-label="ربط الصور يدويًا">
    <div className="imo-manual-intro"><span className="imo-eyebrow">الربط البصري اليدوي</span><h3>حدّد الممر بين صورتين</h3><p>اختر اللقطتين، ثم وجّه علامة الوسط نحو الممر في كل صورة. يُحفظ الربط في الاتجاهين ويعمل مع النقر ومفاتيح الحركة.</p></div>
    <div className="imo-manual-selectors">
      <label><span>الصورة الأولى</span><select disabled={props.disabled||pairBusy} value={from.id} onChange={event=>{setFromId(event.target.value);setToId("");}}>{tour.scenes.map(scene=><option key={scene.id} value={scene.id}>{scene.room} — {scene.sourceName}</option>)}</select></label>
      <span className="imo-manual-between" aria-hidden="true">↔</span>
      <label><span>الصورة الثانية — الدور نفسه</span><select disabled={props.disabled||pairBusy||!to} value={to?.id??""} onChange={event=>setToId(event.target.value)}>{!to&&<option value="">لا توجد صورة أخرى في هذا الدور</option>}{candidates.map(scene=><option key={scene.id} value={scene.id}>{scene.room} — {scene.sourceName}</option>)}</select></label>
    </div>
    {to?<LinkPairEditor key={`${from.id}/${to.id}/${tour.revision}`} tour={tour} from={from} to={to} {...props} onBusyChange={value=>{setPairBusy(value);props.onBusyChange?.(value);}}/>:<div className="imo-empty small"><h3>هذه الصورة وحدها في الدور</h3><p>اختر صورة من دور آخر يحتوي على صورتين، أو ارفع لقطة متداخلة إضافية لهذا الدور.</p></div>}
    <div className="imo-manual-existing"><h4>الروابط من {from.room} <span>{number(from.links.length)}</span></h4>
      {from.links.length?<div className="imo-manual-linked-list">{from.links.flatMap(id=>{const target=tour.scenes.find(scene=>scene.id===id&&scene.floor===from.floor);return target?[<button type="button" key={id} disabled={props.disabled||pairBusy} className={id===to?.id?"selected":""} onClick={()=>setToId(id)}><img src={target.thumbnail} alt=""/><span><strong>{target.room}</strong><small>{target.sourceName}</small></span><small>{from.manualLinks?.some(link=>link.targetId===id)?"يدوي":"تلقائي"}</small></button>]:[];})}</div>:<p className="imo-muted">لم تُربط هذه الصورة بعد. أنشئ أول رابط من المعاينتين أعلاه.</p>}
    </div>
    <p className="imo-manual-note"><Icon name="info" size={16}/>الربط اليدوي يحدّد وجهة التنقل واتجاه الوصول. المخطط والأبعاد يحتاجان بيانات مكانية منفصلة؛ لن تُنشأ مواقع أو جدران افتراضية من هذا الربط.</p>
  </section>;
}

function LinkPairEditor({tour,from,to,onChange,onError,onNotice,disabled,onBusyChange}:Props&{from:Scene;to:Scene}){
  const [fromYaw,setFromYaw]=useState(()=>bearing(from,to)),[toYaw,setToYaw]=useState(()=>bearing(to,from));
  const [fromReady,setFromReady]=useState(!!from.manualLinks?.some(link=>link.targetId===to.id)),[toReady,setToReady]=useState(!!to.manualLinks?.some(link=>link.targetId===from.id));
  const [working,setWorking]=useState(false),[error,setError]=useState("");
  const mounted=useRef(true),busy=useRef(false),workingCallback=useRef(onBusyChange);
  useEffect(()=>{workingCallback.current=onBusyChange;},[onBusyChange]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;workingCallback.current?.(false);};},[]);
  const linked=from.links.includes(to.id),blocked=from.blockedLinks?.includes(to.id)||to.blockedLinks?.includes(from.id);
  async function mutate(method:"POST"|"DELETE"){
    if(busy.current||disabled)return;busy.current=true;setWorking(true);setError("");workingCallback.current?.(true);
    try{
      const saved=await api<Tour>(`tours/${tour.id}/connections`,{method,body:JSON.stringify({revision:tour.revision,fromId:from.id,toId:to.id,...(method==="POST"?{fromYaw,toYaw}:{})})});
      if(mounted.current){onChange(saved);onNotice?.(method==="POST"?"تم حفظ الرابط واتجاهي الممر. يمكنك معاينة التنقل الآن.":"أُلغي الرابط في الاتجاهين؛ لن تعيده المعالجة التلقائية.");}
    }catch(reason){const message=reason instanceof Error?reason.message:"تعذر تحديث الرابط.";if(mounted.current){setError(message);onError?.(message);}}
    finally{busy.current=false;if(mounted.current)setWorking(false);workingCallback.current?.(false);}
  }
  return <>
    <div className="imo-manual-preview-grid">
      <AimingPreview scene={from} initialYaw={fromYaw} destination={to.room} label="١ · اتجاه الذهاب" disabled={disabled||working} confirmed={fromReady} onAim={value=>{if(Math.abs(angleDifference(radians(fromYaw),radians(value)))>radians(.02))setFromReady(false);setFromYaw(value);}} onConfirm={()=>setFromReady(true)}/>
      <AimingPreview scene={to} initialYaw={toYaw} destination={from.room} label="٢ · اتجاه العودة" disabled={disabled||working} confirmed={toReady} onAim={value=>{if(Math.abs(angleDifference(radians(toYaw),radians(value)))>radians(.02))setToReady(false);setToYaw(value);}} onConfirm={()=>setToReady(true)}/>
    </div>
    {blocked&&<p className="imo-manual-blocked">هذا الرابط مُلغى. تحديد الاتجاهين وحفظهما يعيد تفعيله.</p>}
    {error&&<p className="imo-error" role="alert">{error}</p>}
    <div className="imo-manual-actions"><button type="button" className="imo-button primary" disabled={disabled||working||!fromReady||!toReady} onClick={()=>void mutate("POST")}><Icon name="link" size={18}/>{working?"جارٍ تحديث الرابط…":linked?"حفظ اتجاهي الرابط":"ربط الصورتين"}</button>{linked&&<button type="button" className="imo-button danger-outline" disabled={disabled||working} onClick={()=>void mutate("DELETE")}><Icon name="trash" size={17}/>إلغاء الرابط</button>}<span>{fromReady&&toReady?"الاتجاهان جاهزان للحفظ":"اعتمد اتجاه الممر في المعاينتين أولًا"}</span></div>
  </>;
}

function AimingPreview({scene,initialYaw,destination,label,disabled,confirmed,onAim,onConfirm}:{scene:Scene;initialYaw:number;destination:string;label:string;disabled?:boolean;confirmed:boolean;onAim:(yaw:number)=>void;onConfirm:()=>void}){
  const canvas=useRef<HTMLCanvasElement>(null),engine=useRef<PanoramaEngine|null>(null);
  const latest=useRef({scene,initialYaw,onAim,disabled}),[ready,setReady]=useState(false),[error,setError]=useState("");
  useEffect(()=>{latest.current={scene,initialYaw,onAim,disabled};},[scene,initialYaw,onAim,disabled]);
  useEffect(()=>{
    let stopped=false,instance:PanoramaEngine|undefined,observer:ResizeObserver|undefined;
    const element=canvas.current!,initial=latest.current;
    void import("./PanoramaEngine").then(async({PanoramaEngine})=>{
      if(stopped)return;instance=new PanoramaEngine(element);engine.current=instance;
      instance.onError=message=>{if(!stopped)setError(message);};
      observer=new ResizeObserver(([entry])=>instance?.resize(entry.contentRect.width,entry.contentRect.height));observer.observe(element);
      instance.resize(element.clientWidth,element.clientHeight);await instance.move(initial.scene,false);
      if(stopped)return;instance.yaw=radians(initial.initialYaw);instance.pitch=0;instance.fov=82;
      instance.onView=yaw=>latest.current.onAim(degrees(yaw));instance.invalidate();setReady(true);
    }).catch(reason=>{if(!stopped)setError(reason instanceof Error?reason.message:"تعذّر فتح معاينة الصورة.");});
    let pointer:{id:number;x:number;y:number}|null=null;
    const down=(event:PointerEvent)=>{if(event.button!==0||latest.current.disabled||!instance)return;element.setPointerCapture(event.pointerId);pointer={id:event.pointerId,x:event.clientX,y:event.clientY};};
    const move=(event:PointerEvent)=>{if(!pointer||pointer.id!==event.pointerId||!instance||latest.current.disabled)return;instance.addLook(-(event.clientX-pointer.x)*.005,(event.clientY-pointer.y)*.003);pointer={id:event.pointerId,x:event.clientX,y:event.clientY};};
    const up=()=>{pointer=null;};
    const key=(event:KeyboardEvent)=>{if(!instance||latest.current.disabled)return;const delta=event.key==="ArrowLeft"?-.06:event.key==="ArrowRight"?.06:0;if(!delta)return;event.preventDefault();instance.addLook(delta,0);};
    element.addEventListener("pointerdown",down);element.addEventListener("pointermove",move);element.addEventListener("pointerup",up);element.addEventListener("pointercancel",up);element.addEventListener("keydown",key);
    return()=>{stopped=true;observer?.disconnect();instance?.dispose();engine.current=null;element.removeEventListener("pointerdown",down);element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",up);element.removeEventListener("pointercancel",up);element.removeEventListener("keydown",key);};
  },[]);
  return <article className={`imo-manual-preview ${confirmed?"confirmed":""}`}><header><span>{label}</span><strong>{scene.room}</strong><small>{scene.sourceName}</small></header><div className="imo-manual-canvas-wrap"><img src={scene.thumbnail} alt=""/><canvas ref={canvas} tabIndex={disabled?-1:0} aria-label={`وجّه صورة ${scene.room} نحو الممر إلى ${destination} بالسحب أو السهمين`}/>{ready&&!error&&<div className="imo-manual-crosshair" aria-hidden="true"><i/><b/></div>}{!ready&&!error&&<div className="imo-manual-preview-loading"><span className="imo-spinner"/></div>}{error&&<p className="imo-manual-preview-error" role="alert">{error}</p>}<div className="imo-manual-aim-label">الممر إلى {destination}</div></div><div className="imo-manual-aim-controls"><button type="button" aria-label={`تدوير ${scene.room} إلى اليمين`} disabled={disabled||!ready||!!error} onClick={()=>engine.current?.addLook(.12,0)}>↻</button><span>اسحب الصورة حتى يتوسط الممر العلامة</span><button type="button" aria-label={`تدوير ${scene.room} إلى اليسار`} disabled={disabled||!ready||!!error} onClick={()=>engine.current?.addLook(-.12,0)}>↺</button></div><button type="button" className={`imo-button ${confirmed?"secondary":"primary"} full`} disabled={disabled||!ready||!!error} onClick={()=>{const viewer=engine.current;if(viewer){viewer.stopLook();onAim(degrees(viewer.yaw));}onConfirm();}}>{confirmed?<><Icon name="check" size={17}/>اتجاه الممر معتمد</>:"اعتماد هذا الاتجاه"}</button></article>;
}
