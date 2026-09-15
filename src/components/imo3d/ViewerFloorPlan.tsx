"use client";
/* Authenticated drafts must not pass through a public image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState,type ReactNode} from "react";
import type {AIPlanJob,RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
import {RasterPlanMap} from "./RasterPlanMap";
import "./viewer-floorplan.css";

type Status={job:AIPlanJob|null;stale:boolean};

// The private endpoint remains authoritative: public visitors get the existing
// published architecture, while administrators can see their latest draft here.
export function ViewerFloorPlan({tourId,floor,children,hasInteractivePlan=false,compact=false,current,sceneIds=[],onSelect,onExpand}:{tourId:string;floor:number;children?:ReactNode;hasInteractivePlan?:boolean;compact?:boolean;current?:string;sceneIds?:string[];onSelect?:(id:string)=>void;onExpand?:()=>void}){
 const [status,setStatus]=useState<Status|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const [showInteractive,setShowInteractive]=useState(false),[retry,setRetry]=useState(0);
 const url=`/api/imo3d/tours/${tourId}/ai-plan`;
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  async function update(){
   let poll=false;
   try{
    const response=await fetch(url+'?viewer=1&floor='+floor,{signal:controller.signal,cache:"no-store"});
    if(response.status===401||response.status===404){setStatus(null);setError("");return;}
    if(!response.ok)throw Error("تعذر تحميل المخطط. حاول مرة أخرى.");
    const value:Status=await response.json();
    if(!controller.signal.aborted){setStatus(value);setError("");poll=true;}
   }catch(reason){if(!controller.signal.aborted){setStatus(null);setError(reason instanceof Error?reason.message:"تعذر تحميل المخطط.");}}
   finally{if(!controller.signal.aborted){setLoading(false);if(poll)timer=setTimeout(()=>void update(),4000);}}
  }
  void update();return()=>{controller.abort();clearTimeout(timer);};
 },[url,retry,floor]);
 const job=status?.job;
 const draft=job?.status==="draft"&&!status?.stale?job.result?.floors.find(item=>item.floor===floor):undefined;
 if(loading)return compact?null:<p role="status" className="imo-plan-preparing">جارٍ تحميل المخطط…</p>;
 if(!draft||!job)return compact?null:<>{error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>إعادة المحاولة</button></p>}{status?.stale&&<p role="status">تغيرت صور المشروع؛ المسودة السابقة تحتاج تحديثًا.</p>}{children}</>;
 const src=`${url}/image?job=${job.id}&floor=${floor}`;
 if(compact)return <section className="imo-draft-minimap" aria-label="المخطط المصغّر"><header><span>المخطط</span><button type="button" onClick={onExpand} aria-label="توسيع المخطط">↗</button></header>{draft.navigation&&onSelect?<RasterPlanMap src={src} map={draft.navigation} current={current} sceneIds={sceneIds} onSelect={onSelect} compact/>:<button type="button" onClick={onExpand} aria-label="فتح المخطط"><img src={src} alt="مخطط الشقة"/></button>}</section>;
 return <section className="imo-viewer-draft" aria-label="معاينة مخطط الشقة">
  <div className="imo-viewer-draft-heading"><strong>مخطط الشقة 2D</strong><span>مسودة · معاينة الإدارة</span></div>
  {hasInteractivePlan&&<div className="imo-plan-display-modes"><button type="button" aria-pressed={!showInteractive} onClick={()=>setShowInteractive(false)}>الرسم المعدّل 2D</button><button type="button" aria-pressed={showInteractive} onClick={()=>setShowInteractive(true)}>المخطط التفاعلي</button></div>}
  {showInteractive&&hasInteractivePlan?children:<DraftImage key={`${job.id}/${floor}`} src={src} floor={floor} navigation={draft.navigation} current={current} sceneIds={sceneIds} onSelect={onSelect}/>}
 </section>;
}

function DraftImage({src,floor,navigation,current,sceneIds,onSelect}:{src:string;floor:number;navigation?:RasterNavigation;current?:string;sceneIds:string[];onSelect?:(id:string)=>void}){
 const [zoom,setZoom]=useState(1),[loaded,setLoaded]=useState(false),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 return <>
  <div className="imo-viewer-draft-tools" aria-label="أدوات عرض المخطط"><button type="button" aria-label="تصغير المخطط" disabled={zoom===1} onClick={()=>setZoom(z=>Math.max(1,z-.25))}>−</button><button type="button" aria-label="تكبير المخطط" disabled={zoom===3} onClick={()=>setZoom(z=>Math.min(3,z+.25))}>+</button><button type="button" onClick={()=>setZoom(1)}>ملاءمة</button><a href={src} target="_blank" rel="noreferrer">فتح بالحجم الكامل</a></div>
  {navigation&&onSelect?<div className="imo-viewer-draft-sheet"><div style={{width:`${zoom*100}%`}}><RasterPlanMap src={src} map={navigation} current={current} sceneIds={sceneIds} onSelect={onSelect} zoom={zoom}/></div></div>:failed?<p role="alert">تعذر تحميل صورة المخطط. <button type="button" onClick={()=>{setFailed(false);setLoaded(false);setRetry(n=>n+1);}}>إعادة المحاولة</button></p>:<>
   {!loaded&&<p role="status">جارٍ تحميل صورة المخطط…</p>}
   <div className="imo-viewer-draft-sheet" tabIndex={0} aria-label="صورة المخطط؛ استخدم التكبير والتمرير لرؤية التفاصيل"><img key={retry} src={`${src}&retry=${retry}`} style={zoom===1?{width:"auto",maxWidth:"100%",maxHeight:"60dvh"}:{width:`${zoom*100}%`}} onLoad={()=>setLoaded(true)} onError={()=>setFailed(true)} alt={`مخطط الشقة المعدّل 2D — الدور ${floor}`}/></div>
  </>}
  <p className="imo-muted">{navigation?"اضغط أي مكان للانتقال مباشرة إلى أقرب لقطة. مواقع اللقطات والأبعاد على الرسم تقديرية.":"مسودة ثنائية الأبعاد؛ الأبعاد تقديرية. التنقل بالنقر والقياس غير متاحين على هذه الصورة."}</p>
 </>;
}
