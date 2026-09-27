"use client";
import {useEffect,useState} from "react";
import {UNLINKED_CHIP} from "@/lib/imo3d/tour-interest";
import {api} from "./client";

type Named={id:string|null;name:string|null};
type LinkState={configured:boolean;routed:"project"|"developer"|"hint"|"fallback"|null;linked:boolean;developer:Named|null;project:Named|null};
type Catalogue={developers:{id:string;name:string;local:boolean}[];projects:{id:string;name:string}[]};

/**
 * Where this tour project's (or tour developer's) «سجّل اهتمامك» requests go in Developer OS.
 * The registry is VERA's: every read and write goes through the tour's server, signed, to VERA.
 */
export function VeraLinkPicker({kind,refId}:{kind:"project"|"developer";refId:string}){
  const [state,setState]=useState<LinkState|null>(null),[catalogue,setCatalogue]=useState<Catalogue["developers"]>([]),[projects,setProjects]=useState<Catalogue["projects"]>([]);
  const [developerId,setDeveloperId]=useState(""),[projectId,setProjectId]=useState(""),[working,setWorking]=useState(false),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
  const path=`vera/link/${kind}/${encodeURIComponent(refId)}`;
  useEffect(()=>{
    let active=true;
    api<LinkState>(path).then(async next=>{
      if(!active)return;setState(next);
      if(!next.configured)return;
      const own=next.linked?next:null;setDeveloperId(own?.developer?.id??"");setProjectId(kind==="project"?own?.project?.id??"":"");
      const list=await api<Catalogue>("vera/catalogue");if(active)setCatalogue(list.developers);
    }).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"تعذّر الوصول إلى VERA.");});
    return()=>{active=false;};
  },[path,kind,attempt]);
  useEffect(()=>{
    if(kind!=="project"||!developerId)return;
    let active=true;
    api<Catalogue>(`vera/catalogue?developer=${encodeURIComponent(developerId)}`).then(list=>{if(active)setProjects(list.projects);}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"تعذّر تحميل مشاريع المطوّر.");});
    return()=>{active=false;};
  },[kind,developerId]);
  const save=async(method:"PUT"|"DELETE")=>{
    setWorking(true);setError("");
    try{setState(await api<LinkState>(path,{method,...(method==="PUT"?{body:JSON.stringify({developerId,projectId:kind==="project"?projectId:null})}:{})}));if(method==="DELETE"){setDeveloperId("");setProjectId("");}}
    catch(reason){setError(reason instanceof Error?reason.message:"تعذّر حفظ الربط.");}
    finally{setWorking(false);}
  };
  // VERA unreachable while loading: the operator retries here instead of closing and reopening the dialog.
  const retry=<button type="button" className="imo-button secondary" onClick={()=>{setError("");setState(null);setAttempt(value=>value+1);}}>إعادة المحاولة</button>;
  const title=kind==="project"?"ربط بمشروع في Developer OS":"ربط بمطوّر في Developer OS";
  if(!state)return <section className="imo-form imo-vera-link" aria-label={title}><h3>{title}</h3>{error?<><p className="imo-error" role="alert">{error}</p><div className="imo-dialog-actions">{retry}</div></>:<p className="imo-muted" role="status">جارٍ قراءة الربط من VERA…</p>}</section>;
  if(!state.configured)return <section className="imo-form imo-vera-link" aria-label={title}><h3>{title}</h3><p className="imo-muted">التكامل مع VERA غير مفعّل على هذا الخادم.</p></section>;
  const inherited=kind==="project"&&state.routed==="developer"&&state.developer?.name;
  const ready=!!developerId&&(kind==="developer"||!!projectId);
  return <section className="imo-form imo-vera-link" aria-label={title}>
    <h3>{title}</h3>
    {state.routed==="fallback"?<span className="imo-vera-chip">{UNLINKED_CHIP}</span>:state.linked?<p className="imo-muted">الطلبات تذهب إلى {state.project?.name??state.developer?.name}.</p>:inherited?<p className="imo-muted">الطلبات تذهب إلى {state.developer?.name} عبر ربط المطوّر.</p>:null}
    <label>المطوّر في Developer OS<select value={developerId} onChange={event=>{setDeveloperId(event.target.value);setProjectId("");setProjects([]);}} disabled={working}><option value="">اختر المطوّر</option>{catalogue.map(item=><option key={item.id} value={item.id}>{item.name}{item.local?" — VERA المحلي":""}</option>)}</select></label>
    {kind==="project"&&<label>المشروع في Developer OS<select value={projectId} onChange={event=>setProjectId(event.target.value)} disabled={working||!developerId}><option value="">اختر المشروع</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {error&&<p className="imo-error" role="alert">{error}</p>}
    <div className="imo-dialog-actions">{error&&!catalogue.length&&retry}<button type="button" className="imo-button primary" disabled={working||!ready} onClick={()=>void save("PUT")}>{working?"جارٍ الحفظ…":"حفظ الربط"}</button>{state.linked&&<button type="button" className="imo-button secondary" disabled={working} onClick={()=>void save("DELETE")}>إلغاء الربط</button>}</div>
  </section>;
}
