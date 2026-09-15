'use client';
/* eslint-disable @next/next/no-img-element */
import {useState,type FormEvent} from 'react';
import type {PlanLabel} from '@/lib/imo3d/plan-labels';
export function PlanRoomNames({url,labels,onSaved}:{url:string;labels:PlanLabel[];onSaved:()=>void}){
 const [names,setNames]=useState(labels),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const response=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({names:names.map(({roomId,name})=>({roomId,name}))})});const data=await response.json();if(!response.ok)throw Error(data.error);onSaved();}catch(error){setError(error instanceof Error?error.message:'تعذر حفظ الأسماء.');}finally{setBusy(false);}}
 return <details style={{marginTop:16}}><summary>تعديل أسماء الغرف على المخطط</summary><p>تظهر الأسماء أثناء الكتابة. احفظها كنسخة جديدة للمراجعة قبل النشر.</p>
  <div style={{position:'relative',maxWidth:760,marginInline:'auto'}}><img src={url+'&base=1'} alt="المخطط المفروش مع أسماء الغرف القابلة للتعديل" style={{display:'block',width:'100%'}}/>{names.map(label=><span key={label.roomId} style={{position:'absolute',left:`${label.x*100}%`,top:`${label.y*100}%`,transform:'translate(-50%,-50%)',fontSize:'clamp(8px,1.2vw,15px)',fontWeight:600,color:'#193d32',background:'#f7f6edd9',padding:'1px 3px',borderRadius:3,whiteSpace:'nowrap'}}>{label.name}</span>)}</div>
  <form onSubmit={save} style={{display:'grid',gap:12,marginTop:16}}>{names.map((label,index)=><label key={label.roomId}>اسم الغرفة {index+1}<input aria-label={`اسم الغرفة ${index+1}`} value={label.name} required maxLength={80} disabled={busy} onChange={event=>setNames(current=>current.map(item=>item.roomId===label.roomId?{...item,name:event.target.value}:item))}/></label>)}<button className="imo-button primary" disabled={busy||names.some(item=>!item.name.trim())}>{busy?'جارٍ حفظ الأسماء…':'حفظ الأسماء كمسودة'}</button>{error&&<p role="alert">{error}</p>}</form>
 </details>;
}
