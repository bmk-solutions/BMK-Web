"use client";
import {useState} from "react";
import type {Developer,Project} from "@/lib/imo3d/model";
import {api,number} from "./client";
import {Dialog} from "./Dialog";
export function DeveloperDirectory({developers,projects,selected,onSelect,onRefresh}:{developers:Developer[];projects:Project[];selected:string|null;onSelect:(id:string|null)=>void;onRefresh:()=>Promise<void>}){
 const [editing,setEditing]=useState<Developer|"new"|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const current=developers.find(item=>item.id===selected);
 return <section aria-label="المطورون"><div className="imo-section-heading"><div><h2>المطورون</h2><p>لكل مطوّر مشاريعه وجولاته الخاصة.</p></div><button className="imo-button primary" onClick={()=>{setError("");setEditing("new");}}>إنشاء مطوّر</button></div>
 {selected!==null?<div className="imo-project-settings-row"><button className="imo-button secondary" onClick={()=>onSelect(null)}>كل المطورين</button><strong>{current?.name??"مشاريع بدون مطوّر"}</strong>{current&&<button className="imo-button secondary" onClick={()=>{setError("");setEditing(current);}}>تعديل اسم المطوّر</button>}</div>:<div className="imo-tour-grid">{[...developers.map(item=>({id:item.id,name:item.name})),{id:"",name:"مشاريع بدون مطوّر"}].map(item=><button className="imo-button secondary" style={{minHeight:100,justifyContent:"space-between",whiteSpace:"normal"}} key={item.id} onClick={()=>onSelect(item.id)}><strong>{item.name}</strong><span>{number(projects.filter(project=>(project.developerId??"")===item.id).length)} مشاريع</span></button>)}</div>}
 {editing&&<Dialog title={editing==="new"?"إنشاء مطوّر":"تعديل اسم المطوّر"} onClose={()=>{if(!busy)setEditing(null);}}><form className="imo-form" onSubmit={async event=>{event.preventDefault();const name=String(new FormData(event.currentTarget).get("name"));setBusy(true);setError("");try{const saved=await api<Developer>(editing==="new"?"developers":`developers/${editing.id}`,{method:editing==="new"?"POST":"PATCH",body:JSON.stringify({name})});await onRefresh();onSelect(saved.id);setEditing(null);}catch(reason){setError(reason instanceof Error?reason.message:"تعذر حفظ المطوّر.");}finally{setBusy(false);}}}><label>اسم المطوّر<input name="name" defaultValue={editing==="new"?"":editing.name} minLength={2} maxLength={120} required disabled={busy}/></label>{error&&<p role="alert" className="imo-error">{error}</p>}<button className="imo-button primary" disabled={busy}>{busy?"جارٍ الحفظ…":"حفظ"}</button></form></Dialog>}
 </section>;
}
