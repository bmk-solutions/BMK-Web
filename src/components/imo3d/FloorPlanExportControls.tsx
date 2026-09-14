"use client";
import {useEffect,useRef,useState} from "react";
import type {Plan,Scene} from "@/lib/imo3d/model";
import {canExportFloorPlanSvg,floorPlanExportFilename,renderFloorPlanSvg} from "@/lib/imo3d/floorplan-export";
import {floorPlanSvgToPng,saveFloorPlanBlob} from "./floorplan-download";
import "./floorplan-export-controls.css";

export function FloorPlanExportControls({tourTitle,plan,scenes,brandingName}:{tourTitle:string;plan:Plan;scenes:Scene[];brandingName?:string}){
  const details=useRef<HTMLDetailsElement>(null),mounted=useRef(false),operation=useRef<AbortController|null>(null);
  const [busy,setBusy]=useState<"svg"|"png"|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const available=canExportFloorPlanSvg(plan);
  useEffect(()=>{
    mounted.current=true;
    const outside=(event:PointerEvent)=>{if(details.current?.open&&event.target instanceof Node&&!details.current.contains(event.target))details.current.open=false;};
    document.addEventListener("pointerdown",outside);
    return()=>{mounted.current=false;operation.current?.abort();document.removeEventListener("pointerdown",outside);};
  },[]);
  const download=async(format:"svg"|"png")=>{
    if(busy||!available)return;
    if(details.current){details.current.open=false;details.current.querySelector("summary")?.focus();}
    setBusy(format);setError("");setNotice("");const controller=new AbortController();operation.current=controller;
    try{
      const svg=renderFloorPlanSvg({tourTitle,plan,scenes,brandingName});
      const blob=format==="svg"?new Blob([svg],{type:"image/svg+xml;charset=utf-8"}):await floorPlanSvgToPng(svg,controller.signal);
      if(!mounted.current||controller.signal.aborted)return;
      saveFloorPlanBlob(blob,floorPlanExportFilename(tourTitle,plan.label,format));
      setNotice(`بدأ تنزيل مخطط ${plan.label} بصيغة ${format.toUpperCase()}.`);
    }catch(reason){if(mounted.current&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:"تعذر تجهيز المخطط للتنزيل.");}
    finally{if(mounted.current){setBusy(null);operation.current=null;}}
  };
  return <div className="imo-plan-export-control">
    <details ref={details} className="imo-plan-export-menu" onToggle={event=>{if(event.currentTarget.open)setError("");}} onKeyDown={event=>{if(event.key==="Escape"&&details.current?.open){event.preventDefault();event.stopPropagation();details.current.open=false;details.current.querySelector("summary")?.focus();}}}>
      <summary aria-label={busy?"جارٍ تجهيز المخطط للتنزيل":"تنزيل مخطط الدور الحالي"} title="تنزيل المخطط" aria-busy={!!busy}>
        {busy?<span className="imo-export-spinner"/>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>}<span>{busy?"جارٍ التجهيز…":"تنزيل"}</span>
      </summary>
      <div className="imo-plan-export-popover">
        <strong>مخطط مستقل بخلفية بيضاء</strong>
        <button type="button" disabled={!!busy||!available} onClick={()=>void download("svg")}><bdi>SVG</bdi><span>رسم متجهي قابل للتكبير</span></button>
        <button type="button" disabled={!!busy||!available} onClick={()=>void download("png")}><bdi>PNG</bdi><span>صورة عالية الوضوح</span></button>
        <small>{available?"الدور الحالي فقط · تُحفظ ملاحظات التقدير داخل الرسم":"يلزم توفر حدود أو جدران لهذا الدور قبل تنزيل الرسم."}</small>
      </div>
    </details>
    {error&&<p className="imo-plan-export-feedback is-error" role="alert">{error}</p>}
    <span className="imo-plan-export-announcement" role="status">{notice}</span>
  </div>;
}
