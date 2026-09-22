"use client";
/* Private authenticated full-resolution draft: avoid a public image optimizer cache. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from "react";
import type {AIPlanJob} from "@/lib/imo3d/ai-plan-jobs";
import {ChatGPTDrafts} from './ChatGPTDrafts';
type Status={configured:boolean;provider?:string;workerOnline?:boolean;job:AIPlanJob|null;stale:boolean};
export function AIPlanPanel({tourId,sceneCount,disabled,compact=false,onOpenPlan}:{tourId:string;sceneCount:number;disabled:boolean;compact?:boolean;onOpenPlan?:()=>void}){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[pollError,setPollError]=useState(''),[busy,setBusy]=useState(false);
 const [now,setNow]=useState(()=>Date.now());
 const url=`/api/imo3d/tours/${tourId}/ai-plan`;
 useEffect(()=>{let stopped=false,polling=false;const controller=new AbortController();const update=async()=>{if(polling)return;polling=true;try{const response=await fetch(url,{signal:controller.signal});const data=await response.json();if(!response.ok)throw Error(data.error);if(!stopped){setStatus(data);setPollError('');setNow(Date.now());}}catch(error){if(!stopped)setPollError(error instanceof Error?error.message:'تعذر قراءة حالة المخطط.');}finally{polling=false;}};void update();const timer=setInterval(()=>void update(),4000);return()=>{stopped=true;controller.abort();clearInterval(timer);};},[url]);
 const run=async(method:'POST'|'DELETE')=>{setBusy(true);setError('');try{const response=await fetch(url,{method});const data=await response.json();if(!response.ok)throw Error(data.error);setStatus(data);}catch(error){setError(error instanceof Error?error.message:'تعذر بدء التحليل.');}finally{setBusy(false);}};
 const job=status?.job,active=job?.status==='queued'||job?.status==='running';
 const elapsedMinutes=job?Math.max(0,Math.floor((now-Date.parse(job.createdAt))/60000)):0;
 if(compact)return <section className="imo-processing-card" aria-label="حالة المخطط التلقائي"><div className="imo-processing-heading"><div><strong>{active?job.stage:job?.status==='draft'?'مسودة المخطط جاهزة للمراجعة':'المخطط التلقائي'}</strong><small>{sceneCount>100?'توليد المخطط يدعم حتى 100 لقطة لكل جولة. يمكنك توزيع الصور على جولات داخل المشروع.':active?'تستمر المعالجة على جهازك حتى بعد مغادرة الصفحة.':'يبدأ بعد اكتمال رفع الصور وربطها؛ يمكنك تعديل النتيجة يدويًا.'}</small></div><button type="button" className="imo-button secondary" onClick={onOpenPlan}>المخطط والتعديل</button></div>{(error||pollError||job?.error)&&<p role="alert" className="imo-error">{error||pollError||job?.error}</p>}{active&&<button type="button" className="imo-button secondary" disabled={busy} onClick={()=>void run('DELETE')}>إيقاف المخطط</button>}</section>;
 return <section className="imo-form" style={{padding:20,border:'1px solid #dce6e0',borderRadius:16,marginBottom:20}}>
  <div><h3>مخطط 2D من تحليل الصور</h3><p>يبدأ تلقائيًا بعد رفع الصور وربطها: تحليل اللقطات، دمج الغرف حسب الدور، ثم رسم المسودة ومراجعتها. النتائج تقديرية وتحتاج مراجعة؛ لا تتحول إلى قياسات أو مخطط منشور تلقائيًا.</p></div>
  {sceneCount>100&&<p>توليد المخطط يدعم حتى 100 لقطة لكل جولة؛ الربط المكاني يدعم حتى 300. يمكنك إنشاء عدة جولات داخل المشروع.</p>}
  {status?.provider==='chatgpt-subscription-local'?<p role="status">{status.workerOnline?'عامل ChatGPT متصل. تُحلل صور هذه الجولة ويُنشأ مخطط مفروش خاص بها؛ يمكنك تعديل أسماء الغرف قبل النشر.':'عامل ChatGPT غير متصل. شغّل عامل المخططات على جهازك لتفعيل زر التحليل.'} أبقِ الجهاز متصلًا أثناء العمل. تُستخدم حدود اشتراكك.</p>:status&&!status.configured&&<p role="status">التوليد التلقائي غير مهيّأ على هذه النسخة.</p>}
  {status?.configured&&status.provider!=='chatgpt-subscription-local'&&<p>يستخدم هذا المسار حساب API المهيّأ على الخادم.</p>}
  <div className="imo-dialog-actions"><button type="button" className="imo-button primary" disabled={disabled||busy||active||!status?.configured||sceneCount<2||sceneCount>100} onClick={()=>void run('POST')}>{active?'جارٍ إنشاء المسودة…':'تحليل الصور وإنشاء مخطط'}</button>{active&&<button type="button" className="imo-button secondary" disabled={busy} onClick={()=>void run('DELETE')}>إيقاف المعالجة</button>}</div>
  {active&&<div role="status" style={{padding:16,borderRadius:12,background:'#eef6f2',display:'grid',gap:10}}>
   <strong>{job.stage}</strong>
   <span>{Number.isFinite(elapsedMinutes)&&elapsedMinutes>0?`مضى ${elapsedMinutes} دقيقة على طلب المخطط`:'بدأ طلب المخطط للتو'}</span>
   <p style={{margin:0}}>صور الجولة محفوظة. إنشاء المخطط عملية منفصلة عن رفع الصور؛ يمكنك معاينة الجولة أثناء تجهيز المسودة.</p>
   <a className="imo-button secondary" href={`/imo3d/t/${tourId}`} target="_blank" rel="noreferrer">معاينة الجولة الآن</a>
   <small>تحليل الصور وتوزيع الغرف ← رسم المخطط ومراجعته. لا تنشر المسودة إلا بعد مراجعتها.</small>
  </div>}
  {(error||pollError||job?.error)&&<p role="alert" className="imo-error">{error||pollError||job?.error}</p>}
  {status?.stale&&<p>تغيرت صور الجولة أو أدوارها. أعد التوليد للحصول على مسودة للصور الحالية.</p>}
  <ChatGPTDrafts tourId={tourId}/>
  {job?.result&&!status?.stale&&job.status==='draft'&&job.result.floors.map(item=><div key={item.floor}><h4>مسودة الدور {item.floor}</h4><a href={`${url}/image?job=${job.id}&floor=${item.floor}`} target="_blank" rel="noreferrer"><img style={{maxWidth:'100%',maxHeight:620,objectFit:'contain'}} src={`${url}/image?job=${job.id}&floor=${item.floor}`} alt={`مسودة مخطط الدور ${item.floor}`}/></a><p>{job.result?.source==='manual-imagegen-draft'?'هذه مسودة أُعدّت في المحادثة، مع ملاحظات مراجعة بصرية أدناه.':item.audit.verdict==='consistent'?'المراجعة الآلية لم تجد تعارضًا واضحًا؛ هذا ليس إثباتًا للدقة.':'المراجعة الآلية وجدت ملاحظات أو لم تستطع الحسم.'}</p><ul>{[...item.audit.issues,...item.audit.limitations].map((text,index)=><li key={index}>{text}</li>)}</ul></div>)}
 </section>;
}
