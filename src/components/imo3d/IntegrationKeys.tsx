"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { IntegrationKey, IntegrationScope } from "@/lib/imo3d/integrations";
import { api } from "./client";
import { Icon } from "./Icon";
import "./integration-keys.css";

const scopeNames: Record<IntegrationScope, string> = { read: "قراءة المشاريع والجولات", write: "رفع الصور وتحديث الجولات", leads: "قراءة طلبات الاهتمام" };
export function IntegrationKeys({ projectId, onError }: { projectId: string; onError: (message: string) => void }) {
  const [keys, setKeys] = useState<IntegrationKey[] | null>(null), [name, setName] = useState("");
  const [scopes, setScopes] = useState<IntegrationScope[]>(["read", "write"]), [working, setWorking] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [issued, setIssued] = useState<{ id: string; secret: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<IntegrationKey[]>(`projects/${projectId}/keys`, { signal: controller.signal }).then(setKeys).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "تعذر تحميل المفاتيح.");
    });
    return () => controller.abort();
  }, [projectId]);
  const fail = (reason: unknown) => { const message = reason instanceof Error ? reason.message : "تعذر تنفيذ العملية."; setError(message); onError(message); };
  return <div className="imo-integration-keys">
    <p className="imo-muted">اربط هذا المشروع بموقعك أو نظام إدارة العقارات. كل مفتاح يعمل ضمن هذا المشروع والصلاحيات التي تختارها.</p>
    <Link href="/imo3d/api" target="_blank" rel="noopener noreferrer" className="imo-button secondary">دليل API والتضمين</Link>
    <form className="imo-form imo-key-form" onSubmit={async event => {
      event.preventDefault(); setWorking(true); setError(""); setNotice("");
      try {
        const result = await api<{ key: IntegrationKey; secret: string }>(`projects/${projectId}/keys`, { method: "POST", body: JSON.stringify({ name, scopes }) });
        setKeys(previous => [result.key, ...(previous ?? [])]); setIssued({ id: result.key.id, secret: result.secret }); setName("");
      } catch (reason) { fail(reason); } finally { setWorking(false); }
    }}>
      <label>اسم الاتصال<input value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={working} placeholder="مثال: الموقع العقاري أو نظام العملاء"/></label>
      <fieldset className="imo-key-scopes" disabled={working}><legend>الصلاحيات</legend>{(["read", "write", "leads"] as IntegrationScope[]).map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(previous => event.target.checked ? [...previous, scope] : previous.filter(value => value !== scope))}/><span>{scopeNames[scope]}</span></label>)}</fieldset>
      <button className="imo-button primary" disabled={working || !name.trim() || !scopes.length}><Icon name="plus" size={18}/>{working ? "جارٍ التنفيذ…" : "إنشاء مفتاح API"}</button>
    </form>
    {issued && <div className="imo-issued-key" role="status"><strong>مفتاح الاتصال الجديد</strong><p>انسخه الآن واحفظه في إعدادات خادمك؛ لن يظهر كاملًا مرة أخرى.</p><code dir="ltr">{issued.secret}</code><button className="imo-button secondary" onClick={() => { navigator.clipboard.writeText(issued.secret).then(() => setNotice("تم نسخ مفتاح API.")).catch(() => setError("تعذر النسخ تلقائيًا؛ حدد المفتاح وانسخه.")); }}><Icon name="link" size={17}/>نسخ المفتاح</button></div>}
    {error && <p className="imo-error" role="alert">{error}</p>}{notice && <p className="imo-key-notice" role="status">{notice}</p>}
    <div className="imo-keys-heading"><h3>اتصالات المشروع</h3><span>{keys?.filter(key => !key.revokedAt).length ?? 0} نشطة</span></div>
    {keys === null ? !error && <p className="imo-muted">جارٍ تحميل المفاتيح…</p> : keys.length === 0 ? <p className="imo-muted">لم تُنشأ مفاتيح لهذا المشروع بعد.</p> : <div className="imo-key-list">{keys.map(key => <article key={key.id} className={key.revokedAt ? "revoked" : ""}><div><strong>{key.name}</strong><code dir="ltr">{key.prefix}…</code><small>{key.scopes.map(scope => scopeNames[scope]).join(" · ")}</small><span>{key.revokedAt ? "ملغى" : key.lastUsedAt ? `آخر استخدام ${new Date(key.lastUsedAt).toLocaleString("ar-SA")}` : "لم يُستخدم بعد"}</span></div>{!key.revokedAt && <button className="imo-button secondary" disabled={working} onClick={async () => {
      setWorking(true); setError("");
      try { await api(`projects/${projectId}/keys`, { method: "DELETE", body: JSON.stringify({ id: key.id }) }); setKeys(previous => previous?.map(value => value.id === key.id ? { ...value, revokedAt: new Date().toISOString() } : value) ?? []); if (issued?.id === key.id) setIssued(null); setNotice("أُلغي المفتاح وتوقف وصوله إلى المشروع."); }
      catch (reason) { fail(reason); } finally { setWorking(false); }
    }}>إلغاء المفتاح</button>}</article>)}</div>}
    <details className="imo-integration-help"><summary>طريقة الربط</summary><p>أرسل المفتاح في ترويسة الطلب من خادم النظام الذي تربطه:</p><code dir="ltr">Authorization: Bearer &lt;API_KEY&gt;</code><p>قراءة الجولات: <code dir="ltr">GET /api/imo3d/tours</code><br/>قراءة طلبات الاهتمام: <code dir="ltr">GET /api/imo3d/leads</code></p><p>يمكنك أيضًا نسخ كود تضمين الجولة من قسم «رابط الجولة» بعد إتاحتها.</p></details>
  </div>;
}
