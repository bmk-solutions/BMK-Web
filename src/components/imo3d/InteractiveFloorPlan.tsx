"use client";
import {lazy,Suspense,useState} from "react";
import type {Plan,Point,Scene,Tour} from "@/lib/imo3d/model";
import {FloorPlan} from "./FloorPlan";
import {Icon} from "./Icon";
import {FloorPlanExportControls} from "./FloorPlanExportControls";
import {ArchitecturalPlanView} from "./ArchitecturalPlanView";
import {hasReviewedArchitecture} from "@/lib/imo3d/architecture-visibility";
import "./interactive-floorplan.css";

const FloorPlan3D=lazy(()=>import("./FloorPlan3D").then(module=>({default:module.FloorPlan3D})));
type Props={tourTitle:string;brandingName?:string;plan:Plan;scenes:Scene[];current:string;yaw:number;position?:Point|null;spatialScale?:Tour["spatialScale"];onSelect:(id:string)=>void;onMeasure?:()=>void;mode?:"2d"|"3d";onModeChange?:(mode:"2d"|"3d")=>void;allowDraft?:boolean};
export function InteractiveFloorPlan({tourTitle,brandingName,plan,scenes,current,yaw,position,spatialScale,onSelect,onMeasure,mode:controlled,onModeChange,allowDraft=false}:Props){
  const [localMode,setLocalMode]=useState<"3d"|"2d">("2d"),mode=controlled??localMode;
  const setMode=(next:"2d"|"3d")=>{setLocalMode(next);onModeChange?.(next);};
  const [raw,setRaw]=useState(false);
  if(plan.architecture&&(allowDraft||hasReviewedArchitecture(plan)))return <section className="imo-interactive-plan"><div className="imo-plan-display-modes" role="group" aria-label="طريقة عرض النموذج المعماري"><button aria-pressed={mode==="2d"} onClick={()=>setMode("2d")}>المخطط المعماري 2D</button><button aria-pressed={mode==="3d"} onClick={()=>setMode("3d")}>النموذج المعماري 3D</button></div>{plan.architectureReview!=="reviewed"&&<p className="imo-muted">مسودة معمارية · لم تعتمد للعرض بعد</p>}<ArchitecturalPlanView architecture={plan.architecture} scenes={scenes} current={current} yaw={yaw} onSelect={onSelect} mode={mode}/></section>;
  if(!allowDraft||!raw||plan.reviewStatus==="rejected")return <section className="imo-plan-review-state" role="status"><Icon name="map" size={32}/><h3>المخطط المعماري غير معتمد بعد</h3><p>يمكنك متابعة الجولة واختيار الغرف. مواقع الصور والحدود التقديرية لا تثبت الجدران والأبواب.</p>{allowDraft&&<><p>{plan.walls.length} خطوط سابقة · {plan.generatedRooms?.length??0} حدود تقديرية · هذه البيانات ليست نموذجًا معماريًا.</p>{plan.reviewStatus!=="rejected"&&<button className="imo-button secondary" onClick={()=>setRaw(true)}>فحص بيانات إعادة البناء السابقة</button>}</>}</section>;
  return <section className="imo-interactive-plan" aria-label="المخطط التفاعلي">
    <div className="imo-plan-display-tools"><div className="imo-plan-display-modes" role="group" aria-label="طريقة عرض المخطط"><button type="button" aria-pressed={mode==="3d"} onClick={()=>setMode("3d")}><Icon name="layers" size={17}/>ثلاثي الأبعاد <bdi>3D</bdi></button><button type="button" aria-pressed={mode==="2d"} onClick={()=>setMode("2d")}><Icon name="map" size={17}/>مسقط علوي <bdi>2D</bdi></button></div><div className="imo-plan-secondary-tools">{onMeasure&&<button type="button" className="imo-plan-ruler-button" aria-label="فتح المسطرة" title="المسطرة" onClick={onMeasure}><Icon name="measure" size={17}/><span>المسطرة</span></button>}<FloorPlanExportControls key={`${plan.floor}/${tourTitle}`} tourTitle={tourTitle} brandingName={brandingName} plan={plan} scenes={scenes}/></div></div>
    {mode==="3d"?<Suspense fallback={<div className="imo-plan-preparing" role="status"><span className="imo-spinner"/>جارٍ تحضير المخطط الثلاثي الأبعاد…</div>}><FloorPlan3D plan={plan} scenes={scenes} current={current} yaw={yaw} spatialScale={spatialScale} onSelect={onSelect}/></Suspense>:<FloorPlan plan={plan} scenes={scenes} current={current} yaw={yaw} position={position} onSelect={onSelect}/>}
  </section>;
}
