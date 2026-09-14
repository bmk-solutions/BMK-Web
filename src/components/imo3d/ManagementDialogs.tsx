"use client";
import {useState} from "react";
import type {Developer,Project,Tour} from "@/lib/imo3d/model";
import {api,number} from "./client";
import {Dialog} from "./Dialog";
import {Icon} from "./Icon";

type RemovalResult={ok:true;cleanupWarning?:string};
export function ProjectManagementDialog({project,developers=[],tours,onClose,onSaved,onDeleted}:{project:Project;developers?:Developer[];tours:Tour[];onClose:()=>void;onSaved:(project:Project)=>void;onDeleted:(warning?:string)=>void}){
  const [developerId,setDeveloperId]=useState(project.developerId??"");
  const [name,setName]=useState(project.name),[location,setLocation]=useState(project.location);
  const [deleting,setDeleting]=useState(false),[confirmation,setConfirmation]=useState(""),[working,setWorking]=useState(false),[error,setError]=useState("");
  const dirty=name!==project.name||location!==project.location||developerId!==(project.developerId??"");
  return <Dialog title={deleting?"حذف المشروع":"إدارة المشروع"} onClose={()=>{if(!working)onClose();}}>
    {deleting?<form className="imo-form" onSubmit={async event=>{event.preventDefault();setWorking(true);setError("");try{const result=await api<RemovalResult>(`projects/${project.id}`,{method:"DELETE",body:JSON.stringify({confirmationName:confirmation})});onDeleted(result.cleanupWarning);}catch(reason){setError(reason instanceof Error?reason.message:"تعذر حذف المشروع.");}finally{setWorking(false);}}}>
      <div className="imo-delete-summary"><Icon name="trash" size={28}/><h3>{project.name}</h3><p>سيُحذف المشروع مع {number(tours.length)} جولات و{number(tours.reduce((count,tour)=>count+tour.scenes.length,0))} صور، وطلبات الاهتمام والمفاتيح والشعار المرتبطة به. ستتوقف روابط المشاهدة والتكامل الخاصة به.</p><strong>الحذف نهائي ولا يمكن التراجع عنه.</strong></div>
      <label>اكتب اسم المشروع للتأكيد<input value={confirmation} onChange={event=>setConfirmation(event.target.value)} placeholder={project.name} autoComplete="off" disabled={working} required/></label>
      {error&&<p className="imo-error" role="alert">{error}</p>}<div className="imo-dialog-actions"><button className="imo-button danger" disabled={working||confirmation!==project.name}>{working?"جارٍ حذف المشروع…":"حذف المشروع نهائيًا"}</button><button className="imo-button secondary" type="button" disabled={working} onClick={()=>{setDeleting(false);setError("");}}>إلغاء</button></div>
    </form>:<>
      <p className="imo-muted">عدّل بيانات المشروع، وأدر جولاته من لوحة المشاريع. الاسم والشعار المعروضان للزوار لهما إعداد مستقل.</p>
      <form className="imo-form" onSubmit={async event=>{event.preventDefault();setWorking(true);setError("");try{onSaved(await api<Project>(`projects/${project.id}`,{method:"PATCH",body:JSON.stringify({name,location,developerId:developerId||null})}));}catch(reason){setError(reason instanceof Error?reason.message:"تعذر حفظ المشروع.");}finally{setWorking(false);}}}>
        <label>المطوّر<select value={developerId} onChange={event=>setDeveloperId(event.target.value)} disabled={working}><option value="">بدون مطوّر</option>{developers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>اسم المشروع<input value={name} onChange={event=>setName(event.target.value)} required minLength={2} maxLength={120} disabled={working}/></label>
        <label>المدينة أو الموقع<input value={location} onChange={event=>setLocation(event.target.value)} maxLength={160} disabled={working}/></label>
        <p className="imo-muted">{number(tours.length)} جولات · {number(tours.reduce((count,tour)=>count+tour.scenes.length,0))} صور</p>
        {error&&<p className="imo-error" role="alert">{error}</p>}<button className="imo-button primary" disabled={working||!dirty}>{working?"جارٍ الحفظ…":"حفظ بيانات المشروع"}</button>
      </form>
      <section className="imo-danger-zone"><div><h3>حذف المشروع</h3><p>يحذف جميع الجولات والصور وطلبات الاهتمام التابعة لهذا المشروع.</p></div><button className="imo-button danger-outline" disabled={working} onClick={()=>{setDeleting(true);setError("");}}><Icon name="trash" size={17}/>حذف المشروع</button></section>
    </>}
  </Dialog>;
}

export function TourDeletionDialog({tour,onClose,onDeleted}:{tour:Tour;onClose:()=>void;onDeleted:(warning?:string)=>void}){
  const [working,setWorking]=useState(false),[error,setError]=useState("");
  return <Dialog title="حذف الجولة" onClose={()=>{if(!working)onClose();}}><div className="imo-delete-summary"><Icon name="trash" size={28}/><h3>{tour.title}</h3><p>ستُحذف هذه الجولة وصورها الـ{number(tour.scenes.length)} وطلبات الاهتمام المرتبطة بها، وسيتوقف رابط مشاهدتها. لن تُحذف الجولات الأخرى في المشروع.</p><strong>الحذف نهائي، وأي تعديلات غير محفوظة على الجولة ستُفقد.</strong></div>{error&&<p className="imo-error" role="alert">{error}</p>}<div className="imo-dialog-actions"><button className="imo-button danger" disabled={working} onClick={async()=>{setWorking(true);setError("");try{const result=await api<RemovalResult>(`tours/${tour.id}`,{method:"DELETE",body:JSON.stringify({revision:tour.revision})});onDeleted(result.cleanupWarning);}catch(reason){setError(reason instanceof Error?reason.message:"تعذر حذف الجولة.");}finally{setWorking(false);}}}>{working?"جارٍ الحذف…":"حذف الجولة نهائيًا"}</button><button className="imo-button secondary" disabled={working} onClick={onClose}>إلغاء</button></div></Dialog>;
}
