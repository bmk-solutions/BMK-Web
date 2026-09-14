"use client";
import { useEffect, useState } from "react";
import type { ProjectUsage } from "@/lib/imo3d/project-usage";
import { estimateProjectUsage, type UsageRates } from "@/lib/imo3d/usage-estimate";
import { api } from "./client";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import "./project-usage.css";

type Props = { projectId: string; onClose: () => void };
type RateFields = Record<keyof UsageRates, string> & { currency: string };
const blankRates: RateFields = { storagePerGBMonth: "", elapsedPerMinute: "", transferGB: "", transferPerGB: "", currency: "ر.س" };
const numeric = (value: string) => { const parsed = Number(value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 1776 : 1632))).replace("٫", ".")); return value.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e12 ? parsed : null; };
const format = (value: number, digits = 1) => value.toLocaleString("ar-SA", { maximumFractionDigits: digits });

export function ProjectUsageDialog({ projectId, onClose }: Props) {
  return <Dialog title="استخدام المشروع وتقدير التشغيل" onClose={onClose} wide className="imo-usage-dialog"><UsageContents key={projectId} projectId={projectId}/></Dialog>;
}

function UsageContents({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<ProjectUsage | null>(null), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const [rates, setRates] = useState<RateFields>(() => {
    try {
      if (typeof window === "undefined") return blankRates;
      const stored = JSON.parse(sessionStorage.getItem(`imo3d-usage-rates:${projectId}`) ?? "null");
      if (!stored || typeof stored !== "object") return blankRates;
      return Object.fromEntries(Object.entries(blankRates).map(([key, value]) => [key, typeof stored[key] === "string" && stored[key].length <= 24 ? stored[key] : value])) as RateFields;
    } catch { return blankRates; }
  });
  useEffect(() => {
    const controller = new AbortController();
    api<ProjectUsage>(`projects/${projectId}/usage`, { signal: controller.signal }).then(setUsage).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "تعذر قراءة الاستخدام."); });
    return () => controller.abort();
  }, [projectId, reload]);
  const editRate = (key: keyof RateFields, value: string) => {
    const next = { ...rates, [key]: value }; setRates(next);
    try { sessionStorage.setItem(`imo3d-usage-rates:${projectId}`, JSON.stringify(next)); } catch { /* The estimate still works when browser storage is unavailable. */ }
  };
  if (!usage) return <div className="imo-usage-loading">{error ? <><p className="imo-error" role="alert">{error}</p><button type="button" className="imo-button secondary" onClick={() => { setError(""); setReload(value => value + 1); }}>إعادة المحاولة</button></> : <><span className="imo-spinner"/><p>جارٍ قياس ملفات المشروع…</p></>}</div>;
  const values: UsageRates = { storagePerGBMonth: numeric(rates.storagePerGBMonth), elapsedPerMinute: numeric(rates.elapsedPerMinute), transferGB: numeric(rates.transferGB), transferPerGB: numeric(rates.transferPerGB) };
  const estimate = estimateProjectUsage(usage, values), anyCost = [estimate.storage, estimate.processing, estimate.transfer].some(value => value !== null);
  const price = (value: number | null) => value === null ? "غير محدد" : `${format(value, 4)} ${rates.currency}`;
  const statusLabels: Record<string, string> = { queued: "بانتظار المعالجة", running: "قيد المعالجة", completed: "مكتملة", review: "تحتاج مراجعة", failed: "فشلت", cancelled: "ملغاة", stale: "مدخلات تغيرت" };
  return <section className="imo-project-usage" aria-label="استهلاك المشروع">
    <div className="imo-usage-intro"><span className="imo-eyebrow">أرقام من ملفات مشروعك</span><h3>اعرف ما يخزّنه مشروعك</h3><p>الأحجام مقاسة من الصور الخاصة وشعار المشروع. أسعار التشغيل أدناه تختارها أنت بحسب مزودك.</p></div>
    <div className="imo-usage-stats"><article><span>الصور والشعار</span><strong><bdi>{format(usage.storage.bytes / 1_000_000, 2)}</bdi><small>MB</small></strong><p>{format(usage.storage.files, 0)} ملفات خاصة · {format(usage.storage.brandingBytes / 1000, 1)} KB للشعار</p></article><article><span>المدة المسجلة للمهام المنتهية</span><strong><bdi>{format(usage.processing.elapsedSeconds / 60, 1)}</bdi><small>دقيقة</small></strong><p>{format(usage.processing.timedJobs, 0)} مهام ذات مدة مسجلة</p></article><article><span>نقل البيانات للزوار</span><strong className="imo-usage-unknown">غير مقاس</strong><p>يمكنك إدخال تقدير النقل في الحاسبة</p></article></div>
    {!!(usage.storage.missingFiles + usage.storage.unreadableFiles) && <p className="imo-inline-alert" role="status">الحجم المقاس غير كامل: {format(usage.storage.missingFiles, 0)} ملفات غير موجودة و{format(usage.storage.unreadableFiles, 0)} ملفات تعذرت قراءتها. لم تدخل هذه الملفات في الإجمالي.</p>}
    <p className="imo-usage-basis"><Icon name="info" size={16}/>مدة المهمة من إنشائها إلى آخر تحديث نهائي، وتشمل الانتظار والمحاولات؛ ليست وقت CPU. لا يشمل الحجم ملفات قاعدة البيانات وسجلات الخادم وذاكرة المطابقة المؤقتة والأصول العامة المشتركة.</p>
    <div className="imo-usage-jobs"><strong>{format(usage.processing.jobs, 0)} مهام محفوظة</strong><div>{Object.entries(usage.processing.statuses).filter(([, count]) => count > 0).map(([status, count]) => <span key={status} data-status={status}>{statusLabels[status] ?? status}<b>{format(count, 0)}</b></span>)}</div>{usage.processing.unknownDurationJobs > 0 && <small>{format(usage.processing.unknownDurationJobs, 0)} مهام بلا أوقات صالحة للحساب.</small>}</div>
    <div className="imo-usage-estimate-heading"><div><h4>تقدير سيناريو التشغيل</h4><p>شهر تخزين بالحجم الحالي + زمن المهام المنتهية المسجّل + نقل بيانات تدخله أنت.</p></div><label>العملة<select value={rates.currency} onChange={event => editRate("currency", event.target.value)}><option value="ر.س">ر.س</option><option value="$">USD</option><option value="€">EUR</option></select></label></div>
    <div className="imo-usage-rates"><label>سعر GB تخزين / شهر<input inputMode="decimal" value={rates.storagePerGBMonth} maxLength={24} placeholder="سعر مزودك" onChange={event => editRate("storagePerGBMonth", event.target.value)}/></label><label>سعر دقيقة من الزمن المسجّل<input inputMode="decimal" value={rates.elapsedPerMinute} maxLength={24} placeholder="اختياري — ليس وقت CPU" onChange={event => editRate("elapsedPerMinute", event.target.value)}/></label><label>نقل متوقع تختاره (GB)<input inputMode="decimal" value={rates.transferGB} maxLength={24} placeholder="تقديرك، غير مقاس" onChange={event => editRate("transferGB", event.target.value)}/></label><label>سعر GB نقل<input inputMode="decimal" value={rates.transferPerGB} maxLength={24} placeholder="سعر مزودك" onChange={event => editRate("transferPerGB", event.target.value)}/></label></div>
    <div className="imo-usage-calculation"><dl><div><dt>تخزين شهر · {format(usage.storage.bytes / 1_000_000_000, 4)} GB</dt><dd>{price(estimate.storage)}</dd></div><div><dt>الزمن المسجّل · {format(usage.processing.elapsedSeconds / 60, 2)} دقيقة</dt><dd>{price(estimate.processing)}</dd></div><div><dt>النقل الذي أدخلته</dt><dd>{price(estimate.transfer)}</dd></div></dl><div className="imo-usage-total"><span>{estimate.complete ? "مجموع البنود التقديري" : "مجموع البنود المحددة فقط"}</span><strong>{anyCost ? price(estimate.subtotal) : "أدخل أسعارك"}</strong></div></div>
    <p className="imo-usage-note">هذه حاسبة سيناريو بحسب مدخلاتك، وليست فاتورة شهرية أو سعرًا من مزود. البنود غير المحددة ليست صفرًا. لا تشمل رسوم الخادم والنسخ الاحتياطي والضرائب أو تعديل الصور بالذكاء الصناعي. الأسعار تبقى في جلسة المتصفح لهذا المشروع ولا تُرسل للخادم.</p>
    <footer className="imo-usage-footer"><small>آخر قياس {new Date(usage.measuredAt).toLocaleTimeString("ar-SA")}</small><button type="button" onClick={() => { setError(""); setUsage(null); setReload(value => value + 1); }}>تحديث القياس</button></footer>
  </section>;
}
