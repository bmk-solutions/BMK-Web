"use client";
import {useEffect,useRef,useState} from "react";
import type {Tour} from "@/lib/imo3d/model";
import {masterRoomNameProposals,semanticRooms} from "@/lib/imo3d/room-semantics";
import {api,number} from "./client";
import {Dialog} from "./Dialog";
import "./semantic-rooms-editor.css";

type Props={tour:Tour;disabled?:boolean;onChange:(tour:Tour)=>void;onError?:(message:string)=>void;onNotice?:(message:string)=>void;onBusyChange?:(busy:boolean)=>void};
export function SemanticRoomsEditor(props:Props){
  const {tour,disabled}=props,rooms=semanticRooms(tour.scenes),masterProposals=masterRoomNameProposals(rooms);
  const [editing,setEditing]=useState<{id:string;name:string;count:number;masterProposal?:boolean}|null>(null),[working,setWorking]=useState(false),[error,setError]=useState("");
  const callbacks=useRef(props),busy=useRef(false);
  useEffect(()=>{callbacks.current=props;},[props]);
  useEffect(()=>()=>{callbacks.current.onBusyChange?.(false);},[]);
  function close(){if(busy.current)return;setEditing(null);setError("");callbacks.current.onBusyChange?.(false);}
  if(!rooms.length)return null;
  return <section className="imo-semantic-rooms" aria-label="أسماء الغرف ومجموعات الصور">
    <div><h3>الغرف ومجموعات صورها</h3><p className="imo-muted">الأسماء اقتراحات من محتوى الصور. تعديل اسم الغرفة يشمل كل صورها ويحفظ اختيارك عند إعادة التحليل.</p></div>
    <div className="imo-semantic-room-grid">{rooms.map((room,index)=><article key={room.id}>
      <strong>{room.name==="لقطات تحتاج تسمية"?"مساحة "+number(index+1):room.name}</strong>
      <span>{number(room.sceneIds.length)} صور · الدور {number(room.floor)}</span>
      <small>{room.nameSource==="user"?"اسم اخترته أنت":room.nameSource==="legacy"?"اسم محفوظ يحتاج مراجعة":"اقتراح بصري · "+number(Math.round(room.confidence*100))+"%"}{room.needsReview&&" · يحتاج مراجعة"}</small>
      {room.nameSource!=="automatic"&&room.suggestedName!==room.name&&<small>الاقتراح الحالي: {room.suggestedName}</small>}
      {room.suggestedEnsuite&&<small>{room.suggestedEnsuite.status==="confirmed"?"حمّام خاص بمدخل مباشر · دليل معتمد":"حمّام محتمل ظاهر بالصور · المدخل الخاص يحتاج مراجعة"}<br/>العناصر المرصودة: {room.suggestedEnsuite.visibleFixtures.map(fixture=>({toilet:"مرحاض",shower:"دش",bathtub:"حوض استحمام",washbasin:"مغسلة"})[fixture]).join("، ")}</small>}
      {masterProposals.has(room.id)&&<><small>إذا كان الحمّام تابعًا لهذه الغرفة، فالاسم المقترح: <b>{masterProposals.get(room.id)}</b></small><button type="button" className="imo-button secondary" disabled={disabled} onClick={()=>{setError("");setEditing({id:room.id,name:masterProposals.get(room.id)!,count:room.sceneIds.length,masterProposal:true});callbacks.current.onBusyChange?.(true);}}>مراجعة اسم ماستر المقترح</button></>}
      <button type="button" className="imo-button secondary" disabled={disabled} onClick={()=>{setError("");setEditing({id:room.id,name:room.name,count:room.sceneIds.length});callbacks.current.onBusyChange?.(true);}}>تعديل اسم الغرفة</button>
    </article>)}</div>
    {editing&&<Dialog title="تعديل اسم الغرفة" onClose={close}><form className="imo-form" onSubmit={async event=>{
      event.preventDefault();if(busy.current)return;busy.current=true;setWorking(true);setError("");
      try{const saved=await api<Tour>("tours/"+tour.id,{method:"PATCH",body:JSON.stringify({revision:tour.revision,roomRenames:[{groupId:editing.id,name:editing.name}]})});callbacks.current.onChange(saved);callbacks.current.onNotice?.("حُفظ اسم الغرفة على جميع صورها، وسيبقى محفوظًا بعد إعادة التحليل.");busy.current=false;close();}
      catch(reason){const message=reason instanceof Error?reason.message:"تعذر حفظ اسم الغرفة.";setError(message);callbacks.current.onError?.(message);}
      finally{busy.current=false;setWorking(false);}
    }}><p>سيُطبّق الاسم على {number(editing.count)} صور تنتمي إلى هذه الغرفة.</p>{editing.masterProposal&&<p>تُظهر الصور حمّامًا متصلًا محتملًا. اعتمد اسم ماستر إذا كان الحمّام تابعًا لهذه الغرفة. سيُحفظ الاسم كاختيارك، مع إبقاء الأدلة التي تحتاج مراجعة.</p>}<label>اسم الغرفة<input autoFocus required maxLength={100} value={editing.name} disabled={working} onChange={event=>setEditing({...editing,name:event.target.value})}/></label>{error&&<p role="alert" className="imo-error">{error}</p>}<div className="imo-dialog-actions"><button className="imo-button primary" disabled={working||!editing.name.trim()}>{working?"جارٍ الحفظ…":"حفظ اسم الغرفة"}</button><button type="button" className="imo-button secondary" disabled={working} onClick={close}>إلغاء</button></div></form></Dialog>}
  </section>;
}
