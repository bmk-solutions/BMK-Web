"use client";
/* Private authenticated full-resolution draft: avoid a public image optimizer cache. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from "react";
import type {AIPlanJob} from "@/lib/imo3d/ai-plan-jobs";
type Status={configured:boolean;job:AIPlanJob|null;stale:boolean};
export function AIPlanPanel({tourId,sceneCount,disabled}:{tourId:string;sceneCount:number;disabled:boolean}){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const url=`/api/imo3d/tours/${tourId}/ai-plan`;
 useEffect(()=>{let stopped=false;const controller=new AbortController();const update=async()=>{try{const response=await fetch(url,{signal:controller.signal});const data=await response.json();if(!response.ok)throw Error(data.error);if(!stopped)setStatus(data);}catch(error){if(!stopped)setError(error instanceof Error?error.message:'تعذر قراءة حالة المخطط.');}};void update();const timer=setInterval(()=>void update(),4000);return()=>{stopped=true;controller.abort();clearInterval(timer);};},[url]);
 const run=async(method:'POST'|'DELETE')=>{setBusy(true);setError('');try{const response=await fetch(url,{method});const data=await response.json();if(!response.ok)throw Error(data.error);setStatus(data);}catch(error){setError(error instanceof Error?error.message:'تعذر بدء التحليل.');}finally{setBusy(false);}};
 const job=status?.job,active=job?.status==='queued'||job?.status==='running';
 return <section className="imo-form" style={{padding:20,border:'1px solid #dce6e0',borderRadius:16,marginBottom:20}}>
  <div><h3>مخطط 2D من الصور · GPT Image 2.5</h3><p>تحليل كل لقطة، دمج الغرف حسب الدور، ثم مراجعة بصرية للمسودة. النتائج تقديرية وتحتاج مراجعة؛ لا تتحول إلى قياسات أو مخطط منشور تلقائيًا.</p></div>
  {status&&!status.configured&&<p role="status">الربط جاهز للإعداد، لكنه غير مفعّل: يلزم مفتاح OpenAI API على الخادم.</p>}
  {status?.configured&&<p>سيُرسل التحليل نسخًا مشتقة من جميع الصور إلى OpenAI، وتُحتسب تكلفته على حساب API. الصور الأصلية محفوظة.</p>}
  <div className="imo-dialog-actions"><button type="button" className="imo-button primary" disabled={disabled||busy||active||!status?.configured||!sceneCount} onClick={()=>void run('POST')}>{active?'جارٍ إنشاء المسودة…':`توليد مسودة من ${sceneCount} لقطة`}</button>{active&&<button type="button" className="imo-button secondary" disabled={busy} onClick={()=>void run('DELETE')}>إيقاف المعالجة</button>}</div>
  {active&&<div role="status"><p>{job.stage}</p><progress value={job.progress} max={100}/></div>}
  {(error||job?.error)&&<p role="alert" className="imo-error">{error||job?.error}</p>}
  {status?.stale&&<p>تغيرت صور الجولة أو أدوارها. أعد التوليد للحصول على مسودة للصور الحالية.</p>}
  {job?.result&&!status?.stale&&job.status==='draft'&&job.result.floors.map(item=><div key={item.floor}><h4>مسودة الدور {item.floor}</h4><a href={`${url}/image?job=${job.id}&floor=${item.floor}`} target="_blank" rel="noreferrer"><img style={{maxWidth:'100%',maxHeight:620,objectFit:'contain'}} src={`${url}/image?job=${job.id}&floor=${item.floor}`} alt={`مسودة مخطط الدور ${item.floor}`}/></a><p>{job.result?.source==='manual-imagegen-draft'?'هذه مسودة أُعدّت في المحادثة، مع ملاحظات مراجعة بصرية أدناه.':item.audit.verdict==='consistent'?'المراجعة الآلية لم تجد تعارضًا واضحًا؛ هذا ليس إثباتًا للدقة.':'المراجعة الآلية وجدت ملاحظات أو لم تستطع الحسم.'}</p><ul>{[...item.audit.issues,...item.audit.limitations].map((text,index)=><li key={index}>{text}</li>)}</ul></div>)}
 </section>;
}
