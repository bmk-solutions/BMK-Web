"use client";
import {useState} from "react";
import type {Tour} from "@/lib/imo3d/model";
import {architectureIssues} from "@/lib/imo3d/architecture";
import {api} from "./client";
import {Dialog} from "./Dialog";

export function ArchitectureReviewControls({tour,floor,disabled,onSaved,onError}:{tour:Tour;floor:number;disabled:boolean;onSaved:(tour:Tour)=>void;onError:(message:string)=>void}){
  const [open,setOpen]=useState(false),[working,setWorking]=useState(false),[checked,setChecked]=useState(false);
  const plan=tour.plans.find(value=>value.floor===floor),architecture=plan?.architecture;
  if(!architecture)return null;
  const issues=open?architectureIssues(architecture,tour.scenes.filter(scene=>scene.floor===floor).map(scene=>({id:scene.id,position:scene.position}))):[];
  return <><div className="imo-section-heading"><p className="imo-muted">{plan?.architectureReview==="reviewed"?"معتمد للعرض بمراجعة المستخدم":"مسودة · لا تظهر للعملاء"} · {architecture.walls.length} جدران · {architecture.openings.length} فتحات · {architecture.rooms.length} غرف</p><button className="imo-button secondary" disabled={disabled||working||plan?.architectureReview==="reviewed"} onClick={()=>{setChecked(false);setOpen(true);}}>مراجعة واعتماد العرض</button></div>
  {open&&<Dialog title="مراجعة النموذج المعماري" onClose={()=>{if(!working)setOpen(false);}}><p>راجع مواضع الجدران والغرف والفتحات قبل إظهار هذا النموذج للعملاء. الاعتماد يوثق مراجعتك ولا يثبت دقة مساحية.</p><p>{architecture.scale.status==="calibrated"?"المقياس معاير بمرجع المستخدم.":"المقياس غير معاير؛ الأبعاد بالمتر والمساحات غير متاحة."}</p>{issues.length>0&&<ul>{issues.map((issue,index)=><li key={index}>{issue.message}{issue.objectId?` (${issue.objectId})`:""}</li>)}</ul>}<label><input type="checkbox" checked={checked} disabled={working} onChange={event=>setChecked(event.target.checked)}/> راجعت النموذج والمواضع الظاهرة وأوافق على عرضه.</label><div className="imo-dialog-actions"><button className="imo-button primary" disabled={!checked||working||issues.some(issue=>issue.severity==="error")||!architecture.rooms.length||architecture.walls.some(wall=>wall.thickness===null)} onClick={async()=>{setWorking(true);try{const saved=await api<Tour>(`tours/${tour.id}/architecture`,{method:"PUT",body:JSON.stringify({revision:tour.revision,floor,action:"review",architecture})});onSaved(saved);setOpen(false);}catch(error){onError(error instanceof Error?error.message:"تعذر الاعتماد.");}finally{setWorking(false);}}}>{working?"جارٍ الاعتماد…":"اعتماد للعرض"}</button><button className="imo-button secondary" disabled={working} onClick={()=>setOpen(false)}>العودة للمراجعة</button></div></Dialog>}</>;
}
