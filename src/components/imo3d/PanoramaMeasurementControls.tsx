"use client";
import { useState } from "react";
import { calibratePanoramaHeight, calibratePanoramaReference, calibratePanoramaWall, calibratePanoramaWallHeight, calibratePanoramaCeiling, measurePanoramaPlane, parseMeasurementMeters, type PanoramaMeasurementCalibration, type PanoramaMeasurementRay, type PanoramaWallCalibration } from "@/lib/imo3d/panorama-measurement";
import { Icon } from "./Icon";
import "./panorama-measurement.css";

type Props = {
  sceneId: string;
  initialCalibration?: PanoramaMeasurementCalibration | null;
  points: readonly PanoramaMeasurementRay[];
  markers?: readonly { x: number; y: number; visible: boolean }[];
  onClear: () => void;
  onClose: () => void;
  onCalibrationChange?: (calibration: PanoramaMeasurementCalibration | null) => void;
};

/** Mount with key={scene.id}; this scale belongs only to the current capture. */
export function PanoramaMeasurementControls({ sceneId, initialCalibration, points, markers, onClear, onClose, onCalibrationChange }: Props) {
  const [showSetup,setShowSetup]=useState(Boolean(initialCalibration?.sceneId===sceneId));
  const [method, setMethod] = useState<"floor_reference" | "camera_height" | "wall_reference">("camera_height");
  const [calibration, setCalibration] = useState<PanoramaMeasurementCalibration | null>(initialCalibration?.sceneId===sceneId?initialCalibration:null);
  const [setup,setSetup]=useState<"wall"|"ceiling"|null>(null);
  const [lastWall,setLastWall]=useState<PanoramaWallCalibration|null>(initialCalibration?.sceneId===sceneId&&(initialCalibration.source==="wall_reference"||initialCalibration.source==="wall_height")?initialCalibration:null);
  const [value, setValue] = useState(""), [error, setError] = useState("");
  const validCalibration = calibration?.sceneId === sceneId ? calibration : null;
  const length = !setup && validCalibration && points.length === 2 ? measurePanoramaPlane(sceneId, points[0], points[1], validCalibration) : null;
  const clear = () => { setError(""); onClear(); };
  const applyCalibration=(next:PanoramaMeasurementCalibration|null)=>{setCalibration(next);onCalibrationChange?.(next);if(next?.source==="wall_reference"||next?.source==="wall_height")setLastWall(next);};
  const changeMethod = (next: typeof method) => { setMethod(next); setValue(""); applyCalibration(null); setSetup(null);setLastWall(null);clear(); };
  const wallMode = validCalibration?.source==="wall_height"||(validCalibration?.source ?? method) === "wall_reference";
  const ceilingMode=validCalibration?.source==="ceiling_height";
  const surface = setup==="ceiling"?"التقاء الجدار بالسقف":setup==="wall"?"التقاء الجدار بالأرض":ceilingMode?"السقف نفسه":validCalibration && wallMode ? "الجدار أو الباب في مستواه" : wallMode ? "التقاء الجدار بالأرض" : "الأرض";
  const selection = setup==="ceiling"?(points.length?"تم تحديد تقاطع السقف؛ اضغط اعتماد السقف":"اختر نقطة التقاء الجدار بالسقف"):points.length === 0 ? `اختر النقطة الأولى على ${surface}` : points.length === 1 ? `اختر النقطة الثانية على ${surface}` : "تم تحديد النقطتين";
  if(!showSetup)return <section className="imo-photo-ruler" aria-label="القياس على الصورة"><header><span><Icon name="measure" size={18}/>القياس بالمتر</span><button type="button" onClick={onClose} aria-label="إنهاء القياس"><Icon name="close" size={17}/></button></header><p role="status">القياس التلقائي غير متاح لهذه اللقطة؛ لا توجد بيانات عمق مُعايرة بالمتر.</p><p>الصور الحالية لا تحدد طول الباب أو ارتفاع السقف بوحدة المتر دون مرجع.</p><button type="button" className="imo-button secondary" onClick={()=>{onClear();setShowSetup(true);}}>قياس بمرجع معلوم</button></section>;
  return <>
    {points.length === 2 && markers?.length === 2 && markers.every(point => point.visible) && <svg className="imo-photo-ruler-line" aria-hidden="true">
      <line x1={markers[0].x} y1={markers[0].y} x2={markers[1].x} y2={markers[1].y} stroke="#102a23" strokeOpacity=".65" strokeWidth="6"/>
      <line x1={markers[0].x} y1={markers[0].y} x2={markers[1].x} y2={markers[1].y} stroke={validCalibration ? "#65edbd" : "#f4ca82"} strokeWidth="2.5"/>
    </svg>}
    <section className="imo-photo-ruler" aria-label="القياس مباشرة على صورة 360" data-calibrated={Boolean(validCalibration)}>
      <header><span><Icon name="measure" size={18}/>قياس على الصورة <small>{ceilingMode?"السقف":wallMode ? "الجدار والأبواب" : "الأرضية"}</small></span><button type="button" onClick={onClose} aria-label="إنهاء القياس على الصورة"><Icon name="close" size={17}/></button></header>
      {!validCalibration ? <>
        <div className="imo-photo-ruler-methods" role="group" aria-label="طريقة ضبط القياس">
          <button type="button" aria-pressed={method === "floor_reference"} onClick={() => changeMethod("floor_reference")}>طول مرجعي على الأرض</button>
          <button type="button" aria-pressed={method === "camera_height"} onClick={() => changeMethod("camera_height")}>ارتفاع العدسة</button>
          <button type="button" aria-pressed={method === "wall_reference"} onClick={() => changeMethod("wall_reference")}>جدار رأسي</button>
        </div>
        <p>{method === "wall_reference" ? "حدّد نقطتين عند التقاء الجدار نفسه بالأرض، وأدخل المسافة الحقيقية بينهما. بعدها يمكنك قياس ارتفاعه وعرضه على الصورة." : method === "floor_reference" ? "حدّد طرفي طول تعرفه على الأرض داخل الصورة، ثم أدخل طوله الحقيقي." : "أدخل ارتفاع عدسة الكاميرا عن الأرض وقت تصوير هذه اللقطة."}</p>
        {method !== "camera_height" && <div className="imo-photo-ruler-selection" role="status"><span>{selection}</span><button type="button" onClick={clear} disabled={!points.length}>مسح النقطتين</button></div>}
        <form onSubmit={event => {
          event.preventDefault();
          const amount = parseMeasurementMeters(value);
          const next = method === "camera_height" ? calibratePanoramaHeight(sceneId, amount)
            : points.length === 2 ? (method === "wall_reference" ? calibratePanoramaWall : calibratePanoramaReference)(sceneId, points[0], points[1], amount) : null;
          if (!next) { setError(method === "camera_height" ? "أدخل ارتفاع العدسة الحقيقي بين 0.15 و10 أمتار." : wallMode ? "اختر نقطتين متباعدتين على قاعدة الجدار المقابل وأدخل المسافة الصحيحة بينهما." : "اختر طرفين متباعدين على الأرض وأدخل طولًا صحيحًا؛ تأكد من النقطتين إذا لم يُقبل المرجع."); return; }
          applyCalibration(next); clear();
        }}>
          <label>{method === "camera_height" ? "ارتفاع العدسة (م)" : "الطول بين النقطتين (م)"}<input value={value} onChange={event => { setValue(event.target.value); setError(""); }} inputMode="decimal" maxLength={16} placeholder={method === "camera_height" ? "مثلًا 1.60" : "مثلًا 3.00"} aria-label={method === "camera_height" ? "ارتفاع عدسة الكاميرا بالمتر" : "الطول المرجعي على الأرض بالمتر"}/></label>
          <button type="submit" disabled={!value.trim() || method !== "camera_height" && points.length !== 2}>بدء القياس</button>
        </form>
      </> : <>
        <div className="imo-photo-ruler-methods" role="group" aria-label="سطح القياس">
          <button type="button" aria-pressed={!wallMode&&!ceilingMode&&!setup} onClick={()=>{applyCalibration(calibratePanoramaHeight(sceneId,validCalibration.heightMeters));setSetup(null);clear();}}>الأرضية</button>
          <button type="button" aria-pressed={wallMode||setup==="wall"} onClick={()=>{applyCalibration(calibratePanoramaHeight(sceneId,validCalibration.heightMeters));setSetup("wall");clear();}}>الجدران والأبواب</button>
          <button type="button" aria-pressed={ceilingMode||setup==="ceiling"} disabled={!lastWall&&!ceilingMode} onClick={()=>{if(lastWall){applyCalibration(lastWall);setSetup("ceiling");clear();}else if(ceilingMode)clear();}}>السقف</button>
        </div>
        {!lastWall&&!setup&&!ceilingMode&&<p>لقياس جدار أو باب، اختر «الجدران والأبواب» وحدّد قاعدته. بعدها يمكنك تحديد السقف دون إدخال أبعاد إضافية.</p>}
        {setup&&<div className="imo-photo-ruler-selection" role="status"><span>{setup==="wall"?"حدّد نقطتين متباعدتين عند التقاء الجدار نفسه بالأرض، ثم اعتمد الجدار.":"حدّد نقطة واحدة عند التقاء الجدار المحدد بالسقف الأفقي، ثم اعتمد السقف."}</span><button type="button" disabled={points.length!==(setup==="wall"?2:1)} onClick={()=>{
          const next=setup==="wall"?calibratePanoramaWallHeight(sceneId,points[0],points[1],validCalibration.heightMeters):lastWall?calibratePanoramaCeiling(sceneId,points[0],lastWall):null;
          if(!next){setError("تعذر تحديد السطح من هذه النقاط. اختر التقاطعات الحقيقية بوضوح، بعيدًا عن الأفق والأثاث.");return;}
          applyCalibration(next);setSetup(null);clear();
        }}>{setup==="wall"?"اعتماد الجدار":"اعتماد السقف"}</button><button type="button" onClick={clear} disabled={!points.length}>مسح النقاط</button></div>}
        <div className="imo-photo-ruler-result" aria-live="polite"><div><small>{length === null ? selection : "المسافة بين النقطتين"}</small><strong>{length === null ? "—" : <><bdi>{length.toLocaleString("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</bdi><span>م تقريبًا</span></>}</strong></div><button type="button" onClick={clear} disabled={!points.length}>قياس جديد</button></div>
        <div className="imo-photo-ruler-source"><span>ارتفاع العدسة المستخدم: <bdi>{validCalibration.heightMeters.toLocaleString("ar",{maximumFractionDigits:2})}</bdi> م · محفوظ لهذه اللقطة أثناء الجولة</span><button type="button" onClick={() => { applyCalibration(null);setLastWall(null);setSetup(null);setMethod("camera_height");setValue(String(validCalibration.heightMeters));clear(); }}>تعديل ارتفاع العدسة</button></div>
      </>}
      {error && <p className="imo-photo-ruler-error" role="alert">{error}</p>}
      <details className="imo-photo-ruler-details"><summary>شروط دقة القياس</summary><p className="imo-photo-ruler-note">{ceilingMode?"للسقف الأفقي عند الارتفاع الذي حددته فقط؛ لا يشمل الأسقف المائلة أو اختلاف مستويات الجبس.":wallMode ? "للجدار الرأسي المستوي الذي حددته، وفتحات الأبواب في مستواه. الباب المفتوح أو الغائر يحتاج تحديد مستواه الخاص." : "للأرضية الأفقية المستوية فقط."} الدقة تعتمد على ارتفاع العدسة الحقيقي واستواء التصوير واختيار التقاطعات. القياس تقديري ولا يغني عن القياس الميداني للتنفيذ. اسحب الصورة لتوجيه النظر.</p></details>
    </section>
  </>;
}
