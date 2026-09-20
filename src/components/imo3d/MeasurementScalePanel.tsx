"use client";
import {useState} from "react";
import type {Tour} from "@/lib/imo3d/model";
import {parseMeasurementMeters} from "@/lib/imo3d/panorama-measurement";
import {DEFAULT_CAPTURE_HEIGHT_METERS} from "@/lib/imo3d/estimated-measurement";
import "./measurement-scale-panel.css";

/** Administration only. Visitors use the stored height automatically. */
export function MeasurementScalePanel({tour,disabled,onSave}:{tour:Tour;disabled:boolean;onSave:(height:number|null)=>void}){
 const [centimeters,setCentimeters]=useState(String(Math.round((tour.measurementScale?.heightMeters??DEFAULT_CAPTURE_HEIGHT_METERS)*10000)/100));
 const [confirmed,setConfirmed]=useState(false);
 const meters=parseMeasurementMeters(centimeters)/100;
 const valid=Number.isFinite(meters)&&meters>=.15&&meters<=10;
 const covered=tour.scenes.filter(scene=>tour.measurementScale?.sceneIds.includes(scene.id)).length;
 return <section className="imo-measure-scale" aria-label="ضبط مقياس القياس">
  <h3>مقياس القياس</h3>
  <p>إعداد التصوير المشترك لجميع المشاريع الحالية والجديدة: {DEFAULT_CAPTURE_HEIGHT_METERS.toFixed(2)} م. غيّره هنا إذا صُوّرت هذه الجولة بارتفاع مختلف.</p>
  <p>سجّل المسافة الحقيقية من الأرض إلى مركز العدسة وقت التصوير. سيستخدمها زائر الجولة تلقائيًا لقياس الأرضيات والجدران والأبواب والأسقف.</p>
  <p className="imo-muted">هذا يضبط المقياس فقط؛ عمق الصور يبقى تقديريًا. لا تستخدم طول العصا وحده، فهو لا يشمل القاعدة وموضع العدسة.</p>
  {tour.measurementScale&&<p role="status">ارتفاع مسجّل: {tour.measurementScale.heightMeters.toFixed(2)} م · يشمل {covered} من {tour.scenes.length} لقطة.</p>}
  <label className="imo-field">ارتفاع مركز العدسة عن الأرض (سم)<input aria-label="ارتفاع مركز العدسة بالسنتيمتر" inputMode="decimal" dir="ltr" value={centimeters} placeholder="الارتفاع المقاس فعليًا" disabled={disabled} onChange={event=>{setCentimeters(event.target.value);setConfirmed(false);}}/></label>
  <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event=>setConfirmed(event.target.checked)}/> هذا الارتفاع مقاس فعليًا وينطبق على جميع اللقطات الحالية.</label>
  <p className="imo-muted">الصور المضافة لاحقًا تحتاج تأكيد ارتفاعها. عند تغيير المقياس ابدأ قياسات جديدة؛ لن تُعرض قياسات النسخة السابقة مع المقياس الجديد.</p>
  <button className="imo-button secondary full" type="button" disabled={disabled||!valid||!confirmed||!tour.scenes.length} onClick={()=>onSave(meters)}>حفظ ارتفاع التصوير</button>
  {tour.measurementScale&&<button className="imo-button secondary full" type="button" disabled={disabled} onClick={()=>onSave(null)}>إلغاء الارتفاع المسجّل</button>}
 </section>;
}
