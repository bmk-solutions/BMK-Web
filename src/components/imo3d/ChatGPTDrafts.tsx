'use client';
/* Authenticated draft image; do not send through a shared image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from 'react';
type Draft={id:string;floor:number;stale:boolean;created_at:string;result:{audit:{verdict:string;issues:string[];limitations:string[]}}};
export function ChatGPTDrafts({tourId}:{tourId:string}){
 const [drafts,setDrafts]=useState<Draft[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;async function update(){if(document.hidden)return;try{const response=await fetch('/api/imo3d-chatgpt/drafts?tourId='+encodeURIComponent(tourId));if(response.status===503)return;const data=await response.json();if(!response.ok)throw Error(data.error);if(active){setDrafts(data);setError('');}}catch(error){if(active)setError(error instanceof Error?error.message:'تعذر قراءة المسودات');}}void update();const timer=setInterval(()=>void update(),15000);return()=>{active=false;clearInterval(timer);};},[tourId]);
 return <section><h4>مسودات ChatGPT</h4>{!drafts.length&&<p>بعد ربط حسابك من الإعدادات، تظهر هنا المسودات التي يحفظها ChatGPT لهذه الجولة.</p>}{error&&<p role="status">{error}</p>}{drafts.map(draft=><article key={draft.id}><h4>الدور {draft.floor} · {new Date(draft.created_at).toLocaleString('ar')}</h4>{draft.stale?<p>تغيرت الصور بعد هذه المسودة. يلزم تحليل الصور الحالية قبل الاعتماد.</p>:<><a href={`/api/imo3d-chatgpt/drafts?tourId=${encodeURIComponent(tourId)}&id=${draft.id}`} target="_blank" rel="noreferrer"><img src={`/api/imo3d-chatgpt/drafts?tourId=${encodeURIComponent(tourId)}&id=${draft.id}`} alt="مسودة مخطط من تحليل ChatGPT" style={{maxWidth:'100%',maxHeight:580}}/></a><p>مسودة تقديرية للمراجعة، وليست مخططًا معماريًا مقاسًا. لم تستبدل المخطط المعتمد.</p><ul>{[...draft.result.audit.issues,...draft.result.audit.limitations].map((item,index)=><li key={index}>{item}</li>)}</ul></>}</article>)}</section>;
}
