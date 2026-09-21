"use client";
/* Authenticated drafts must not pass through a public image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState,type ReactNode} from "react";
import type {RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
import type {Scene} from '@/lib/imo3d/model';
import {rasterViewHeading} from './raster-navigation';
import {Icon} from "./Icon";
import type {ViewerPlanCache} from "./viewer-plan-cache";
import {RasterPlanMap} from "./RasterPlanMap";
import "./viewer-floorplan.css";



// The private endpoint remains authoritative: public visitors get the existing
// published architecture, while administrators can see their latest draft here.
export function ViewerFloorPlan({cache,tourId,floor,children,hasInteractivePlan=false,compact=false,current,scenes=[],yaw=0,sceneIds=[],onSelect,onExpand,onIntent}:{cache:ViewerPlanCache;tourId:string;floor:number;children?:ReactNode;hasInteractivePlan?:boolean;compact?:boolean;current?:string;scenes?:Scene[];yaw?:number;sceneIds?:string[];onSelect?:(id:string)=>void;onExpand?:()=>void;onIntent?:(id:string)=>void}){
 const url=`/api/imo3d/tours/${tourId}/ai-plan`;
 const key=url+'?viewer=1&floor='+floor;
 const [entry,setEntry]=useState(()=>cache.peek(key)),[error,setError]=useState("");
 const [showInteractive,setShowInteractive]=useState(false),[retry,setRetry]=useState(0),[collapsed,setCollapsed]=useState(false);
 useEffect(()=>{
  let active=true;let timer:ReturnType<typeof setTimeout>;
  const update=async()=>{try{const next=await cache.get(key);if(active){setEntry(next);setError("");}}catch(reason){if(active)setError(reason instanceof Error?reason.message:"تعذر تحميل المخطط.");}finally{if(active)timer=setTimeout(()=>void update(),15000);}};
  void update();return()=>{active=false;clearTimeout(timer);};
 },[cache,key,retry]);
 const status=entry?.status,loading=!entry&&!error;
 const job=status?.job;
 const draft=job?.status==="draft"&&!status?.stale?job.result?.floors.find(item=>item.floor===floor):undefined;
 if(loading)return compact?null:<div role="status" aria-label="جارٍ تحميل المخطط" className="imo-plan-preparing"><span className="imo-spinner"/></div>;
 if(!draft||!job)return compact?null:<>{error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>إعادة المحاولة</button></p>}{status?.stale&&<p role="status">تغيرت صور المشروع؛ المسودة السابقة تحتاج تحديثًا.</p>}{children}</>;
 const heading=draft.navigation&&current?rasterViewHeading(draft.navigation,scenes,current,yaw):undefined;
 const src=entry?.src??`${url}/image?job=${job.id}&floor=${floor}`;
 if(compact)return <section className="imo-draft-minimap" aria-label="المخطط المصغّر"><header className="imo-plan-header"><button className="imo-plan-title" type="button" onClick={onExpand}>المخطط</button><button type="button" onClick={()=>setCollapsed(value=>!value)} aria-label={collapsed?"إظهار المخطط":"إخفاء المخطط"} aria-expanded={!collapsed}><Icon name={collapsed?"eye-off":"eye"} size={18}/></button><button type="button" onClick={onExpand} aria-label="توسيع المخطط"><Icon name="open-plan" size={18}/></button></header><div hidden={collapsed}>{draft.navigation&&onSelect?<RasterPlanMap onIntent={onIntent} heading={heading} src={src} map={draft.navigation} current={current} sceneIds={sceneIds} onSelect={onSelect} compact/>:<button type="button" onClick={onExpand} aria-label="فتح المخطط"><img src={src} alt="مخطط الشقة"/></button>}</div></section>;

 return <section className="imo-viewer-draft" aria-label="معاينة مخطط الشقة">
  <div className="imo-viewer-draft-heading"><strong>مخطط الشقة 2D</strong><span>مسودة · معاينة الإدارة</span></div>
  {hasInteractivePlan&&<div className="imo-plan-display-modes"><button type="button" aria-pressed={!showInteractive} onClick={()=>setShowInteractive(false)}>الرسم المعدّل 2D</button><button type="button" aria-pressed={showInteractive} onClick={()=>setShowInteractive(true)}>المخطط التفاعلي</button></div>}
  {showInteractive&&hasInteractivePlan?children:<DraftImage onIntent={onIntent} heading={heading} key={`${job.id}/${floor}`} src={src} floor={floor} navigation={draft.navigation} current={current} sceneIds={sceneIds} onSelect={onSelect}/>}
 </section>;
}

function DraftImage({src,floor,navigation,current,sceneIds,onSelect,heading,onIntent}:{src:string;floor:number;heading?:number;navigation?:RasterNavigation;current?:string;sceneIds:string[];onSelect?:(id:string)=>void;onIntent?:(id:string)=>void}){
 const [zoom,setZoom]=useState(1),[loaded,setLoaded]=useState(src.startsWith("blob:")),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 return <>
  <div className="imo-viewer-draft-tools" aria-label="أدوات عرض المخطط"><button type="button" aria-label="تصغير المخطط" disabled={zoom===1} onClick={()=>setZoom(z=>Math.max(1,z-.25))}>−</button><button type="button" aria-label="تكبير المخطط" disabled={zoom===3} onClick={()=>setZoom(z=>Math.min(3,z+.25))}>+</button><button type="button" onClick={()=>setZoom(1)}>ملاءمة</button><a href={src} target="_blank" rel="noreferrer">فتح بالحجم الكامل</a></div>
  {navigation&&onSelect?<div className="imo-viewer-draft-sheet"><div style={{width:`${zoom*100}%`}}><RasterPlanMap onIntent={onIntent} heading={heading} src={src} map={navigation} current={current} sceneIds={sceneIds} onSelect={onSelect} zoom={zoom}/></div></div>:failed?<p role="alert">تعذر تحميل صورة المخطط. <button type="button" onClick={()=>{setFailed(false);setLoaded(false);setRetry(n=>n+1);}}>إعادة المحاولة</button></p>:<>
   {!loaded&&<p role="status">جارٍ تحميل صورة المخطط…</p>}
   <div className="imo-viewer-draft-sheet" tabIndex={0} aria-label="صورة المخطط؛ استخدم التكبير والتمرير لرؤية التفاصيل"><img key={retry} src={src.startsWith("blob:")?src:`${src}&retry=${retry}`} style={zoom===1?{width:"auto",maxWidth:"100%",maxHeight:"60dvh"}:{width:`${zoom*100}%`}} onLoad={()=>setLoaded(true)} onError={()=>setFailed(true)} alt={`مخطط الشقة المعدّل 2D — الدور ${floor}`}/></div>
  </>}
  <p className="imo-muted">{navigation?"اضغط أي مكان للانتقال مباشرة إلى أقرب لقطة. مواقع اللقطات والأبعاد على الرسم تقديرية.":"مسودة ثنائية الأبعاد؛ الأبعاد تقديرية. التنقل بالنقر والقياس غير متاحين على هذه الصورة."}</p>
 </>;
}
