"use client";
import type{Plan,Point,Scene,Tour}from"@/lib/imo3d/model";
import{Icon}from"./Icon";
import {ArchitecturalPlanView} from "./ArchitecturalPlanView";
import {hasReviewedArchitecture} from "@/lib/imo3d/architecture-visibility";
import"./compact-apartment-map.css";
export function CompactApartmentMap({plan,scenes,current,yaw,mode,onModeChange,onExpand,onClose,onSelect}:{plan:Plan;scenes:Scene[];current:string;yaw:number;position?:Point|null;spatialScale?:Tour["spatialScale"];mode:"2d"|"3d";onModeChange:(mode:"2d"|"3d")=>void;onExpand:()=>void;onClose:()=>void;onSelect:(id:string)=>void}){
  if(!hasReviewedArchitecture(plan))return null;
  return <section className="imo-compact-apartment-map"><header><div role="group" aria-label="نوع المخطط المصغر"><button aria-pressed={mode==="2d"} onClick={()=>onModeChange("2d")} aria-label="مخطط ثنائي الأبعاد 2D">2D</button><button aria-pressed={mode==="3d"} onClick={()=>onModeChange("3d")} aria-label="مخطط ثلاثي الأبعاد 3D">3D</button></div><button aria-label="توسيع مخطط الشقة" onClick={onExpand}><Icon name="expand" size={16}/></button><button aria-label="إخفاء المخطط المصغّر" onClick={onClose}><Icon name="close" size={16}/></button></header>
    <div className="imo-compact-map-content"><ArchitecturalPlanView architecture={plan.architecture!} scenes={scenes} current={current} yaw={yaw} onSelect={onSelect} mode={mode} compact presentation="clean"/></div>
    {!plan.walls.length&&!plan.authoredRooms?.length&&<button className="imo-compact-map-review" onClick={onExpand}>مواقع الصور · حدود الشقة قيد المراجعة</button>}
  </section>;
}
