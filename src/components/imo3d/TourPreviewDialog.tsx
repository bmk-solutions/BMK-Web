"use client";
import {useState} from "react";
import type {Tour} from "@/lib/imo3d/model";
import {Dialog} from "./Dialog";
import {Icon} from "./Icon";

export function TourPreviewDialog({tours,initialId,initialSceneId,onClose}:{tours:Tour[];initialId?:string;initialSceneId?:string;onClose:()=>void}){
  const [selectedId,setSelectedId]=useState(initialId||tours.find(tour=>tour.scenes.length)?.id||tours[0]?.id);
  const tour=tours.find(item=>item.id===selectedId)||tours[0];
  return <Dialog title="معاينة المشروع" wide className="imo-preview-dialog" onClose={onClose}>
    <div className="imo-preview-heading"><div><Icon name="eye" size={20}/><span>راجع الجولة داخل لوحة الإدارة قبل النشر.</span></div><span className={`imo-preview-status${tour?.published?" is-published":""}`}>{tour?.published?"الرابط متاح":"مسودة · للإدارة فقط"}</span></div>
    {tours.length>1&&<div className="imo-form imo-preview-select"><label>الجولة أو الوحدة<select value={tour?.id||""} onChange={event=>setSelectedId(event.target.value)}>{tours.map(item=><option key={item.id} value={item.id}>{item.title}{item.scenes.length?"":" — بدون صور"}</option>)}</select></label></div>}
    {tour?.scenes.length?<iframe className="imo-admin-preview" key={`${tour.id}:${tour.revision}`} src={`/imo3d/t/${tour.id}?embed=1&revision=${tour.revision}${tour.id===initialId&&initialSceneId?"&scene="+encodeURIComponent(initialSceneId):""}`} title={`معاينة ${tour.title}`} allow="fullscreen"/>:<div className="imo-empty"><Icon name="upload" size={30}/><p>أضف صورًا لهذه الجولة لتظهر المعاينة.</p></div>}
    <p className="imo-muted imo-preview-note">المعاينة لا تغيّر حالة النشر. يمكنك إغلاقها والعودة إلى التحرير، ثم إتاحة الرابط عندما تكون الجولة جاهزة.</p>
  </Dialog>;
}
