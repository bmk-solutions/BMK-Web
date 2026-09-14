"use client";
import {useEffect,useState} from "react";
import type {Project} from "@/lib/imo3d/model";
import type {LeadPage} from "@/lib/imo3d/lead-query";
import {api,number} from "./client";
import {Icon} from "./Icon";

export function LeadInbox({projects}:{projects:Project[]}){
  const [projectId,setProjectId]=useState("");
  return <div className="imo-page"><div className="imo-page-heading"><div><span className="imo-eyebrow">العملاء المحتملون</span><h1>طلبات الاهتمام</h1><p>كل طلب مرتبط بالمشروع والجولة التي شاهدها العميل.</p></div><label className="imo-filter"><select aria-label="مشروع طلبات الاهتمام" value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">كل المشاريع</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div><LeadResults key={projectId} projectId={projectId}/></div>;
}

function LeadResults({projectId}:{projectId:string}){
  const [page,setPage]=useState<LeadPage|null>(null),[cursor,setCursor]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]);
  const [error,setError]=useState(""),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController(),query=new URLSearchParams({paged:"1",limit:"100"});
    if(projectId)query.set("projectId",projectId);
    if(cursor)query.set("cursor",cursor);
    api<LeadPage>(`leads?${query}`,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setPage(result);}).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"تعذر تحميل الطلبات.");});
    return()=>controller.abort();
  },[projectId,cursor,retry]);
  const change=(next:string|null,back=false)=>{setHistory(previous=>back?previous.slice(0,-1):[...previous,cursor]);setPage(null);setError("");setCursor(next);};
  if(error)return <div className="imo-empty"><p className="imo-error" role="alert">{error}</p><button className="imo-button secondary" onClick={()=>{setError("");setRetry(value=>value+1);}}>إعادة المحاولة</button></div>;
  if(!page)return <div className="imo-empty" role="status"><span className="imo-spinner"/><p>جارٍ تحميل الطلبات…</p></div>;
  return <><p className="imo-muted">{number(page.total)} طلب · الصفحة {number(history.length+1)}</p>{page.leads.length?<div className="imo-table-wrap"><table className="imo-table"><thead><tr><th>الاسم</th><th>الجوال</th><th>المشروع والجولة</th><th>الملاحظات</th><th>التاريخ</th></tr></thead><tbody>{page.leads.map(lead=><tr key={lead.id}><td>{lead.name}</td><td dir="ltr">{lead.phone}</td><td>{lead.projectName}<br/><small>{lead.tourTitle}</small></td><td>{lead.note||"—"}</td><td>{new Date(lead.createdAt).toLocaleDateString("ar-SA")}</td></tr>)}</tbody></table></div>:<div className="imo-empty"><Icon name="people" size={38}/><h3>لا توجد طلبات هنا</h3><p>ستظهر الطلبات المسجلة من داخل جولاتك.</p></div>}{(history.length>0||page.nextCursor)&&<div className="imo-dialog-actions"><button className="imo-button secondary" disabled={!history.length} onClick={()=>change(history.at(-1)??null,true)}>الصفحة السابقة</button><button className="imo-button secondary" disabled={!page.nextCursor} onClick={()=>change(page.nextCursor)}>الصفحة التالية</button></div>}</>;
}
