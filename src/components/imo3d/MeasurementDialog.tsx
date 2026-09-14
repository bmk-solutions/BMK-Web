"use client";
import { useMemo, useRef, useState } from "react";
import type { Plan, Scene, Tour } from "@/lib/imo3d/model";
import { calibratePlanReference, horizontalPlanDistance, inversePlanProjection, planHasMetricScale, type MeasurementPoint, type PlanCalibration } from "@/lib/imo3d/measurement";
import { floorPlanPoints, floorPlanProjection, floorPlanViewport } from "./floorplan-geometry";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import "./measurement.css";

type Props = { plans: Plan[]; scenes: Scene[]; current: Scene; initialFloor?: number; spatialScale?: Tour["spatialScale"]; onClose: () => void };

export function MeasurementDialog({ plans, scenes, current, initialFloor, spatialScale, onClose }: Props) {
  const [floor, setFloor] = useState(initialFloor ?? current.floor), [calibrations, setCalibrations] = useState<Record<number, PlanCalibration>>({});
  const plan = plans.find(value => value.floor === floor) ?? plans[0];
  return <Dialog title="القياس على مخطط الشقة" onClose={onClose} wide className="imo-measure-dialog">
    <div className="imo-measure-heading"><span><Icon name="measure" size={20}/>المسافة الأفقية بين نقطتين</span><small>قياس تقريبي من المخطط</small></div>
    {plans.length > 1 && <div className="imo-floor-tabs" aria-label="دور القياس">{plans.map(value => <button key={value.floor} type="button" className={value.floor === plan?.floor ? "selected" : ""} onClick={() => setFloor(value.floor)}>{value.label}</button>)}</div>}
    {plan && plan.kind !== "missing" ? <PlanRuler key={plan.floor} plan={plan} scenes={scenes} current={current} spatialScale={spatialScale} calibration={calibrations[plan.floor]} onCalibration={value => setCalibrations(previous => {
      const next = { ...previous }; if (value) next[plan.floor] = value; else delete next[plan.floor]; return next;
    })}/> : <div className="imo-empty small"><Icon name="measure" size={30}/><h3>المخطط غير جاهز للقياس</h3><p>أكمل المعالجة المكانية أو استورد مخططًا مسجلًا بإحداثيات الصور، ثم افتح أداة القياس.</p></div>}
  </Dialog>;
}

function PlanRuler({ plan, scenes, current, spatialScale, calibration, onCalibration }: Omit<Props, "plans" | "onClose"> & { plan: Plan; calibration?: PlanCalibration; onCalibration: (value: PlanCalibration | null) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const projection = useMemo(() => floorPlanProjection(plan, scenes), [plan, scenes]);
  const inverse = useMemo(() => projection ? inversePlanProjection(projection.project) : null, [projection]);
  const nativeMetric = planHasMetricScale(plan, spatialScale, !!inverse);
  const [mode, setMode] = useState<"measure" | "calibrate">((nativeMetric || calibration) ? "measure" : "calibrate");
  const [points, setPoints] = useState<MeasurementPoint[]>([]), [reference, setReference] = useState("");
  const [error, setError] = useState(""), [zoom, setZoom] = useState(1), [keyboardPoint, setKeyboardPoint] = useState<MeasurementPoint | null>(null);
  const captures = useMemo(() => floorPlanPoints(plan, scenes), [plan, scenes]);
  const viewport = floorPlanViewport(plan), viewWidth = viewport.width / zoom, viewHeight = viewport.height / zoom;
  const [center, setCenter] = useState<MeasurementPoint>({ x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 });
  const viewX = Math.max(viewport.x, Math.min(viewport.x + viewport.width - viewWidth, center.x - viewWidth / 2));
  const viewY = Math.max(viewport.y, Math.min(viewport.y + viewport.height - viewHeight, center.y - viewHeight / 2));
  const unit = Math.max(viewWidth, viewHeight) / 600;
  const sourcePoint = (point: MeasurementPoint) => inverse ? inverse(point) : point;
  const scale = calibration?.metersPerUnit ?? (nativeMetric ? 1 : null);
  const length = points.length === 2 && scale !== null ? horizontalPlanDistance(sourcePoint(points[0]), sourcePoint(points[1]), scale) : null;
  const choose = (point: MeasurementPoint) => { setError(""); setPoints(previous => previous.length === 2 ? [point] : [...previous, point]); };
  const changeMode = (value: "measure" | "calibrate") => { setMode(value); setPoints([]); setError(""); };
  const countLabel = points.length === 0 ? "اختر النقطة الأولى" : points.length === 1 ? "اختر النقطة الثانية" : "اختر نقطة جديدة لبدء قياس آخر";
  const source = calibration ? "مقياس مرجعي أدخلته أنت · محفوظ حتى إغلاق الأداة" : nativeMetric ? plan.kind === "depth" ? "من إحداثيات العمق بالمتر" : "من إحداثيات المخطط المسجّل بالمتر" : "المخطط لا يملك مقياسًا متريًا معتمدًا";
  return <section className="imo-plan-ruler" aria-label="مسطرة المخطط">
    <div className="imo-ruler-toolbar"><div className="imo-ruler-modes"><button type="button" className={mode === "measure" ? "selected" : ""} disabled={scale === null} onClick={() => changeMode("measure")}>قياس مسافة</button><button type="button" className={mode === "calibrate" ? "selected" : ""} onClick={() => changeMode("calibrate")}>ضبط مقياس معلوم</button></div><div className="imo-ruler-zoom"><button type="button" disabled={zoom >= 3} aria-label="تكبير مخطط القياس" onClick={() => { if (points.length) setCenter(points[points.length - 1]); setZoom(value => Math.min(3, value + .5)); }}>+</button><button type="button" disabled={zoom === 1} onClick={() => { setZoom(1); setCenter({ x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }); }}>إظهار الكل</button><button type="button" disabled={zoom <= 1} aria-label="تصغير مخطط القياس" onClick={() => setZoom(value => Math.max(1, value - .5))}>−</button></div></div>
    <p className="imo-ruler-instruction">{mode === "calibrate" ? "حدّد طرفي مسافة تعرف طولها الحقيقي على المخطط، ثم أدخل طولها بالمتر." : "حدّد نقطتين على المخطط لقياس المسافة الأفقية بينهما."}</p>
    <div className="imo-ruler-canvas"><svg ref={svg} viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet" tabIndex={0} role="group" aria-label={`${countLabel}. يمكنك تحريك علامة التحديد بالأسهم ثم الضغط على Enter.`} onClick={event => {
      const matrix = svg.current?.getScreenCTM(); if (!matrix || !svg.current) return;
      const point = svg.current.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const mapped = point.matrixTransform(matrix.inverse());
      if (mapped.x < viewX || mapped.x > viewX + viewWidth || mapped.y < viewY || mapped.y > viewY + viewHeight) return;
      choose({ x: mapped.x, y: mapped.y }); setKeyboardPoint(null);
    }} onKeyDown={event => {
      const point = keyboardPoint ?? { x: viewX + viewWidth / 2, y: viewY + viewHeight / 2 };
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(point); return; }
      const step = Math.max(viewWidth, viewHeight) * (event.shiftKey ? .03 : .005);
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (dx || dy) { event.preventDefault(); setKeyboardPoint({ x: Math.max(viewX, Math.min(viewX + viewWidth, point.x + dx)), y: Math.max(viewY, Math.min(viewY + viewHeight, point.y + dy)) }); }
    }}>
      {plan.image ? <image href={plan.image} width={plan.width ?? plan.bounds.maxX - plan.bounds.minX} height={plan.height ?? plan.bounds.maxZ - plan.bounds.minZ}/> : <>
        {plan.walls.map((wall, index) => <line key={index} x1={wall.a.x - plan.bounds.minX} y1={wall.a.z - plan.bounds.minZ} x2={wall.b.x - plan.bounds.minX} y2={wall.b.z - plan.bounds.minZ} stroke="#596a64" strokeWidth={1.8 * unit}/>)}
        {plan.estimatedSurfaces?.map((wall, index) => <line key={`estimated-${index}`} x1={wall.a.x - plan.bounds.minX} y1={wall.a.z - plan.bounds.minZ} x2={wall.b.x - plan.bounds.minX} y2={wall.b.z - plan.bounds.minZ} stroke="#98a79e" strokeWidth={1.8 * unit} strokeDasharray={`${5 * unit} ${3 * unit}`}/>)}
      </>}
      {captures.map(({ scene, point }) => <g key={scene.id}><title>{scene.room}</title><circle cx={point.x} cy={point.y} r={(scene.id === current.id ? 4 : 2.3) * unit} fill={scene.id === current.id ? "#2baa82" : "#a5b1aa"} stroke="#fff" strokeWidth={unit}/></g>)}
      {points.length === 2 && <><line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} stroke="#fff" strokeWidth={5 * unit}/><line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} stroke={mode === "calibrate" ? "#b98336" : "#168e70"} strokeWidth={2.5 * unit}/></>}
      {points.map((point, index) => <g key={index}><circle cx={point.x} cy={point.y} r={6 * unit} fill={mode === "calibrate" ? "#b98336" : "#168e70"} stroke="#fff" strokeWidth={2 * unit}/><text x={point.x} y={point.y - 11 * unit} textAnchor="middle" fill="#185440" fontSize={14 * unit} fontWeight="700" stroke="#fff" strokeWidth={3 * unit} paintOrder="stroke">{index + 1}</text></g>)}
      {keyboardPoint && <path d={`M${keyboardPoint.x - 9 * unit} ${keyboardPoint.y}h${18 * unit}M${keyboardPoint.x} ${keyboardPoint.y - 9 * unit}v${18 * unit}`} stroke="#14775e" strokeWidth={1.5 * unit}/>}
    </svg><span className="imo-ruler-pick-hint">{countLabel}</span></div>
    <div className="imo-ruler-result" aria-live="polite"><div><small>{mode === "calibrate" ? "مرجع القياس" : "المسافة على المخطط"}</small><strong>{mode === "measure" && length !== null ? <><bdi>{length.toLocaleString("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</bdi><span>م تقريبًا</span></> : points.length === 2 ? "النقطتان محددتان" : "—"}</strong></div><div className="imo-ruler-point-actions"><button type="button" disabled={!points.length} onClick={() => setPoints(previous => previous.slice(0, -1))}>تراجع</button><button type="button" disabled={!points.length} onClick={() => { setPoints([]); setError(""); }}>مسح</button></div></div>
    {mode === "calibrate" && <form className="imo-ruler-calibration" onSubmit={event => {
      event.preventDefault(); const amount = Number(reference.replace(/[٠-٩۰-۹]/g, value => String(value.charCodeAt(0) - (value >= "۰" ? 1776 : 1632))).replace("٫", "."));
      const value = points.length === 2 ? calibratePlanReference(sourcePoint(points[0]), sourcePoint(points[1]), amount) : null;
      if (!value) { setError("حدّد نقطتين مختلفتين، ثم أدخل طولًا معلومًا أكبر من صفر بالمتر."); return; }
      onCalibration(value); changeMode("measure");
    }}><label>الطول الحقيقي بين النقطتين (م)<input inputMode="decimal" value={reference} onChange={event => setReference(event.target.value)} placeholder="مثلًا 3.50" aria-label="الطول المرجعي بالمتر" maxLength={20}/></label><button className="imo-button primary" type="submit" disabled={points.length !== 2 || !reference.trim()}>اعتماد المقياس</button></form>}
    {error && <p className="imo-error" role="alert">{error}</p>}
    <p className="imo-ruler-source"><Icon name="info" size={15}/>{source}{calibration && <button type="button" onClick={() => { onCalibration(null); changeMode(nativeMetric ? "measure" : "calibrate"); }}>إلغاء المعايرة</button>}</p>
    <p className="imo-ruler-note">النتيجة تخص المسافة الأفقية على المخطط، وليست ارتفاعًا أو قياسًا على سطح الصورة. {plan.kind === "estimated" || plan.kind === "path" ? "المواضع والأسطح المقدرة من الصور قد تكون غير دقيقة؛ المرجع يضبط المقياس فقط ولا يصحّح الشكل." : "تعتمد دقتها على معايرة المخطط ودقة اختيار النقطتين."}</p>
  </section>;
}
