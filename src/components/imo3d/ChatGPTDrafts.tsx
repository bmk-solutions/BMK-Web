'use client';
/* Private authenticated draft images must not use the public image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState,type FormEvent} from 'react';
import {PlanRoomNames} from './PlanRoomNames';
import type {PlanLabel} from '@/lib/imo3d/plan-labels';
type Draft={id:string;floor:number;stale:boolean;created_at:string;result:{qualityHold?:string;furnished?:{reviewNotes:string;labels?:PlanLabel[];baseImageHasNoText?:boolean};audit:{verdict:string;issues:string[];limitations:string[]}}};
function DraftCard({draft,tourId,onSaved}:{draft:Draft;tourId:string;onSaved:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState(false);
 const url=`/api/imo3d-chatgpt/drafts?tourId=${encodeURIComponent(tourId)}&id=${draft.id}`;
 async function selectPlan(){setBusy(true);setError('');try{const response=await fetch(url+'&approve=1',{method:'POST'});const data=await response.json();if(!response.ok)throw Error(data.error);setSelected(true);}catch(error){setError(error instanceof Error?error.message:'تعذر اختيار المخطط.');}finally{setBusy(false);}}
 async function upload(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=event.currentTarget,body=new FormData(form),file=body.get('image');
  if(!(file instanceof File)||!file.size)return;
  if(file.size>3.8*1024*1024){setError('حجم الصورة يجب ألا يتجاوز 3.8 MiB.');return;}
  setBusy(true);setError('');try{const response=await fetch(url,{method:'POST',body});const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر حفظ النسخة المفروشة.');form.reset();onSaved();}catch(error){setError(error instanceof Error?error.message:'تعذر الحفظ.');}finally{setBusy(false);}
 }
 if(draft.result.qualityHold)return <article style={{paddingBlock:20,borderTop:'1px solid var(--imo-border,#d9e2dd)'}}><h4>تجربة مستبعدة من الاعتماد</h4><p role="status">{draft.result.qualityHold}</p><a href={url} target="_blank" rel="noreferrer">عرض التجربة المستبعدة للمقارنة فقط</a></article>;
 return <article style={{paddingBlock:20,borderTop:'1px solid var(--imo-border,#d9e2dd)'}}>
  <h4>{draft.result.furnished?'مخطط 2D مفروش':'مخطط الغرف والفتحات'} · الدور {draft.floor} · {new Date(draft.created_at).toLocaleString('ar')}</h4>
  {draft.stale?<p>تغيرت الصور بعد هذه المسودة. يلزم تحليل الصور الحالية قبل الاعتماد.</p>:<>
   <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={draft.result.furnished?'مسودة مخطط 2D مفروش من صور الشقة':'مسودة الغرف والفتحات من تحليل ChatGPT'} style={{display:'block',width:'100%',maxHeight:720,objectFit:'contain'}}/></a>
   <p>{draft.result.furnished?'الأثاث مستنتج من الصور ومواضعه تقديرية. هذه نسخة للمراجعة لم تستبدل مخطط الجولة.':'هذا مخطط الغرف والفتحات. النتيجة المفروشة تضيف الأثاث الظاهر في صور هذه الشقة بعد المراجعة.'}</p>
   {draft.result.furnished&&<p style={{whiteSpace:'pre-wrap'}}>{draft.result.furnished.reviewNotes}</p>}
   {draft.result.furnished?.baseImageHasNoText&&draft.result.furnished.labels&&<PlanRoomNames url={url} labels={draft.result.furnished.labels} onSaved={onSaved}/>}
   {draft.result.furnished&&<details style={{marginTop:16}}><summary>استخدام المخطط بعد المراجعة</summary><p>اختر النسخة المحفوظة التي راجعتها. سيظهر هذا الرسم بدل المخطط الحالي؛ وإذا كانت الجولة منشورة سيراه الزوار. هذه نسخة مرئية، ولا تضيف تسجيل مواقع التنقل على الرسم تلقائيًا.</p><button className="imo-button secondary" disabled={busy||selected} onClick={()=>void selectPlan()}>{selected?'تم اختيار المخطط للجولة':'راجعت هذه النسخة — استخدمها في الجولة'}</button>{error&&<p role="alert">{error}</p>}</details>}
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}><a href={url} target="_blank" rel="noreferrer">فتح المخطط كاملًا</a><a href={url+'&brief=1'} download="furnished-plan-brief.json">تنزيل تعليمات الرسم وأدلة الصور</a>{draft.result.furnished&&<a href={url+'&guide=1'} target="_blank" rel="noreferrer">مقارنة مخطط الغرف</a>}</div>
   <details style={{marginTop:16}}><summary>إضافة نسخة مفروشة للمراجعة</summary><p>اطلب من ChatGPT رسم المخطط مفروشًا اعتمادًا على صور الجولة ودليل الغرف. راجع الأثاث والأبواب، ثم أرفق الصورة هنا. يُحفظ إصدار جديد دون استبدال النسخ السابقة. هذا الخيار لإرفاق نسخة يدوية إضافية إلى جانب التوليد التلقائي.</p>
    <form onSubmit={upload} style={{display:'grid',gap:12}}><label>صورة المخطط — PNG أو JPEG، حتى 3.8 MiB<input name="image" type="file" accept="image/png,image/jpeg" required disabled={busy}/></label><label>ملخص الأثاث وملاحظات المراجعة<textarea name="reviewNotes" required minLength={10} maxLength={6000} rows={4} disabled={busy} placeholder="الأثاث الظاهر في كل غرفة، العناصر التي راجعتها، والمواضع غير المؤكدة" style={{display:'block',width:'100%'}}/></label><button className="imo-button secondary" disabled={busy}>{busy?'جارٍ حفظ النسخة…':'حفظ نسخة مفروشة منفصلة'}</button>{error&&<p role="alert">{error}</p>}</form>
   </details>
   <details style={{marginTop:12}}><summary>مراجعة الصور وحدود الدقة</summary><ul>{[...draft.result.audit.issues,...draft.result.audit.limitations].map((item,index)=><li key={index}>{item}</li>)}</ul></details>
  </>}
 </article>;
}
export function ChatGPTDrafts({tourId}:{tourId:string}){
 const [drafts,setDrafts]=useState<Draft[]>([]),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{let active=true;async function update(){if(document.hidden)return;try{const response=await fetch('/api/imo3d-chatgpt/drafts?tourId='+encodeURIComponent(tourId));if(response.status===503)return;const data=await response.json();if(!response.ok)throw Error(data.error);if(active){setDrafts(data);setError('');}}catch(error){if(active)setError(error instanceof Error?error.message:'تعذر قراءة المسودات');}}void update();const timer=setInterval(()=>void update(),15000);return()=>{active=false;clearInterval(timer);};},[tourId,revision]);
 return <section><h4>مسودات ChatGPT</h4><p>صور الشقة ← مراجعة الغرف والأثاث ← مخطط 2D مفروش للمراجعة. لكل شقة توزيعها وأثاثها الخاص.</p>{!drafts.length&&<p>يبدأ تجهيز المخطط تلقائيًا بعد رفع الصور وربطها. تظهر هنا مسودات هذه الجولة عند اكتمالها، ويمكنك إعادة التحليل أو إيقافه من الأعلى.</p>}{error&&<p role="status">{error}</p>}{drafts.map(draft=><DraftCard key={draft.id} draft={draft} tourId={tourId} onSaved={()=>setRevision(value=>value+1)}/>)}</section>;
}
