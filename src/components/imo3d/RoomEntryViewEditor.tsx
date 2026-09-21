"use client";
import {useEffect,useRef,useState} from 'react';
import type {Scene,Tour} from '@/lib/imo3d/model';
import {sceneEntryView,constrainedView} from '@/lib/imo3d/view-presentation';
import type {PanoramaEngine} from './PanoramaEngine';
import {roomChoices,roomIdentity} from './room-labels';
import {Icon} from './Icon';
import './room-entry-view.css';

type Entry=NonNullable<Scene['entryView']>;
const degrees=(value:number)=>((value*180/Math.PI+180)%360+360)%360-180;
export function RoomEntryViewEditor({tour,disabled,onSave}:{tour:Tour;disabled:boolean;onSave:(sceneId:string,view:Entry|null)=>void}){
 const choices=[...new Set(tour.scenes.map(scene=>scene.floor))].flatMap(floor=>roomChoices(tour.scenes,floor));
 const [roomId,setRoomId]=useState(choices[0]?.id??''),[sceneId,setSceneId]=useState('');
 const choice=choices.find(item=>item.id===roomId)??choices[0];
 const members=tour.scenes.filter(scene=>choice&&roomIdentity(scene)===choice.id);
 const scene=members.find(item=>item.id===sceneId)??choice?.scene;
 if(!scene)return <p>أضف صور المشروع أولًا لتحديد جهة دخول الغرف.</p>;
 return <section className="imo-entry-editor">
  <div><h3>جهة دخول الغرف</h3><p className="imo-muted">اختر الغرفة ولقطة الدخول، ثم اسحب الصورة إلى الجهة التي تريد أن يراها الزائر واضغط حفظ.</p></div>
  <div className="imo-two-cols imo-form"><label>الغرفة<select aria-label="الغرفة" disabled={disabled} value={choice.id} onChange={event=>{setRoomId(event.target.value);setSceneId('');}}>{choices.map(item=><option key={item.id} value={item.id}>{item.name} · الدور {item.scene.floor}</option>)}</select></label><label>لقطة الدخول<select aria-label="لقطة الدخول" disabled={disabled} value={scene.id} onChange={event=>setSceneId(event.target.value)}>{members.map((item,index)=><option key={item.id} value={item.id}>{`لقطة ${index+1} — ${item.name}`}{item.entryView?' · جهة محفوظة':''}</option>)}</select></label></div>
  <EntryPreview key={scene.id} scene={scene} disabled={disabled} onSave={view=>onSave(scene.id,view)}/>
  {choice.scene.entryView&&<button type="button" className="imo-button secondary" disabled={disabled} onClick={()=>onSave(choice.scene.id,null)}>استعادة جهة الدخول الافتراضية</button>}
 </section>;
}
function EntryPreview({scene,disabled,onSave}:{scene:Scene;disabled:boolean;onSave:(view:Entry)=>void}){
 const canvas=useRef<HTMLCanvasElement>(null),engine=useRef<PanoramaEngine|null>(null);
 const [ready,setReady]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let cancelled=false,instance:PanoramaEngine|undefined,observer:ResizeObserver|undefined;
  const el=canvas.current!;
  void import('./PanoramaEngine').then(async({PanoramaEngine})=>{
   if(cancelled)return;
   instance=new PanoramaEngine(el);engine.current=instance;
   instance.onError=setError;
   observer=new ResizeObserver(()=>instance?.resize(el.clientWidth,el.clientHeight));observer.observe(el);
   instance.resize(el.clientWidth,el.clientHeight);
   await instance.move(scene,false);if(cancelled)return;
   const view=sceneEntryView(scene);instance.yaw=view?.yaw??scene.yaw*Math.PI/180;instance.pitch=view?.pitch??0;instance.fov=view?.fov??74;instance.invalidate();setReady(true);
  }).catch(reason=>{if(!cancelled)setError(reason instanceof Error?reason.message:'تعذر فتح المعاينة');});
  let pointer:{id:number;x:number;y:number}|null=null;
  const down=(e:PointerEvent)=>{if(!instance)return;instance.stopLook();pointer={id:e.pointerId,x:e.clientX,y:e.clientY};el.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(pointer?.id!==e.pointerId||!instance)return;instance.addLook((pointer.x-e.clientX)*.005,(e.clientY-pointer.y)*.003);pointer={id:e.pointerId,x:e.clientX,y:e.clientY};};
  const up=()=>{pointer=null;};
  const wheel=(e:WheelEvent)=>{e.preventDefault();if(instance){instance.fov+=e.deltaY*.035;instance.invalidate();}};
  const key=(e:KeyboardEvent)=>{if(!instance||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();instance.addLook(e.key==='ArrowLeft'?-.12:e.key==='ArrowRight'?.12:0,e.key==='ArrowUp'?.08:e.key==='ArrowDown'?-.08:0);};
  el.addEventListener('pointerdown',down);el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('wheel',wheel,{passive:false});el.addEventListener('keydown',key);
  return()=>{cancelled=true;observer?.disconnect();instance?.dispose();engine.current=null;el.removeEventListener('pointerdown',down);el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.removeEventListener('wheel',wheel);el.removeEventListener('keydown',key);};
 },[scene]);
 return <><div className="imo-entry-preview"><canvas ref={canvas} tabIndex={0} aria-label="معاينة جهة الدخول؛ اسحب أو استخدم أسهم لوحة المفاتيح"/><span className="imo-entry-crosshair" aria-hidden="true">+</span>{!ready&&!error&&<span className="imo-entry-loading" role="status">جارٍ فتح المعاينة…</span>}</div>{error&&<p role="alert">{error}</p>}<button type="button" className="imo-button primary" disabled={disabled||!ready} onClick={()=>{const viewer=engine.current;if(!viewer)return;viewer.stopLook();const view=constrainedView(viewer.pitch,viewer.fov);onSave({yaw:degrees(viewer.yaw-scene.yaw*Math.PI/180),pitch:view.pitch*180/Math.PI,fov:view.fov});}}><Icon name="check"/> حفظ لقطة الدخول وهذه الجهة</button></>;
}
