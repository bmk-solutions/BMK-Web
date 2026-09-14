"use client";
import { useEffect, useRef, useState } from "react";
import type { ProjectBranding } from "@/lib/imo3d/branding";
import { api } from "./client";
import {uploadResumable,type SignedPanoramaUpload} from "./panorama-upload";
import { Icon } from "./Icon";
import {BrandLogo} from "./BrandLogo";
import "./branding.css";

type Props = { projectId: string; onSaved: (branding: ProjectBranding) => void; onError: (message: string) => void };

export function BrandingEditor({ projectId, onSaved, onError }: Props) {
  const [branding, setBranding] = useState<ProjectBranding | null>(null);
  const [logoStyle,setLogoStyle]=useState<"clean"|"original">("clean");
  const [name, setName] = useState(""), [accent, setAccent] = useState("#24b18b");
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState("");
  const [removeLogo, setRemoveLogo] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true), objectUrl = useRef("");
  useEffect(() => {
    mounted.current = true; const abort = new AbortController();
    api<ProjectBranding>(`projects/${projectId}/branding`, { signal: abort.signal }).then(value => {
      setBranding(value); setName(value.name); setAccent(value.accent);setLogoStyle(value.logoStyle??"clean");
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "تعذر تحميل العلامة."); });
    return () => { mounted.current = false; abort.abort(); };
  }, [projectId]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  const clearFile = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = ""; setFile(null); setPreview("");
  };
  const logo = preview || (!removeLogo ? branding?.logo : undefined);
  const changed = !!branding && (name !== branding.name || accent !== branding.accent || logoStyle!==(branding.logoStyle??"clean") || !!file || removeLogo);
  const chooseFile = (selected?: File) => {
    if (!selected) return;
    if (selected.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(selected.type)) {
      setError("اختر صورة PNG أو JPG أو WEBP بحجم لا يتجاوز 5 ميجابايت."); return;
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(selected);
    setError(""); setFile(selected); setPreview(objectUrl.current); setRemoveLogo(false);
  };
  if (!branding) return <div className="imo-branding-loading">{error ? <p className="imo-error" role="alert">{error}</p> : <><span className="imo-spinner"/><p>جارٍ تحميل هوية المشروع…</p></>}</div>;
  return <form className="imo-form imo-branding-editor" onSubmit={async event => {
    event.preventDefault(); setWorking(true); setError("");
    try {
      let saved: ProjectBranding;
      if (file) {
        const mode=await api<{cloud?:boolean}>("session");
        if(mode.cloud){
          const session=await api<SignedPanoramaUpload>(`projects/${projectId}/branding-init`,{method:"POST",body:JSON.stringify({name,accent,logoStyle,size:file.size,type:file.type})});
          await uploadResumable(file,session);
          saved=await api<ProjectBranding>(`projects/${projectId}/branding-finalize`,{method:"POST",body:JSON.stringify({uploadId:session.uploadId})});
        }else{
          const body = new FormData(); body.set("name", name); body.set("accent", accent); body.set("file", file);body.set("logoStyle",logoStyle);
          saved = await api<ProjectBranding>(`projects/${projectId}/branding`, { method: "POST", body });
        }
      } else saved = await api<ProjectBranding>(`projects/${projectId}/branding`, { method: "PATCH", body: JSON.stringify({ name, accent, removeLogo,logoStyle }) });
      if (mounted.current) { setBranding(saved); setName(saved.name); setAccent(saved.accent); clearFile(); setRemoveLogo(false); onSaved(saved); }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "تعذر حفظ الهوية.";
      if (mounted.current) { setError(message); onError(message); }
    } finally { if (mounted.current) setWorking(false); }
  }}>
    <p className="imo-muted">اختر الاسم والشعار اللذين يظهران للزوار في جميع جولات هذا المشروع.</p>
    <label>اسم العلامة المعروض<input value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={working} placeholder="اسم شركتك أو مشروعك" autoComplete="organization"/></label>
    <div className="imo-branding-logo-field"><span>شعار المشروع</span><div className="imo-branding-logo-upload"><div className="imo-branding-logo-swatch">{logo ? <BrandLogo src={logo} alt="معاينة الشعار المختار" clean={logoStyle==="clean"}/> : <Icon name="eye" size={32}/>}</div><div><button type="button" className="imo-button secondary" disabled={working} onClick={() => input.current?.click()}><Icon name="upload" size={17}/>{logo ? "تغيير الشعار" : "اختيار الشعار"}</button><small>PNG، JPG، WEBP · حتى 5 MB<br/>تُحفظ خلفية الشعار الشفافة.</small></div>{logo && <button type="button" disabled={working} className="imo-branding-remove" onClick={() => { clearFile(); setRemoveLogo(true); }}>إزالة</button>}</div><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ""; }}/></div>
    {logo&&<label>عرض الشعار<select value={logoStyle} disabled={working} onChange={event=>setLogoStyle(event.target.value as "clean"|"original")}><option value="clean">واضح دون هوامش أو خلفية بيضاء</option><option value="original">ألوان وخلفية الملف الأصلي</option></select><small>التحسين يغيّر العرض فقط. ملف الشعار محفوظ ويمكن الرجوع إليه في أي وقت.</small></label>}
    <label className="imo-branding-color">لون العلامة<input type="color" value={accent} onChange={event => setAccent(event.target.value)} disabled={working}/><span dir="ltr">{accent.toUpperCase()}</span></label>
    <div className="imo-branding-preview"><span className="imo-branding-preview-label">معاينة ظهور العلامة في الجولة</span><div className="imo-branding-preview-corner" style={{ borderColor: accent }}>{logo && <BrandLogo src={logo} clean={logoStyle==="clean"} tone="light"/>}{(!logo||name.trim()!=="IMO 3D")&&<strong>{name.trim() || "اسم العلامة"}</strong>}</div><div className="imo-branding-preview-button" style={{ background: accent }}>استكشف المكان <Icon name="arrow" size={17}/></div></div>
    {error && <p className="imo-error" role="alert">{error}</p>}
    <button type="submit" className="imo-button primary full" disabled={working || !changed || !name.trim()}>{working ? "جارٍ حفظ الهوية…" : "حفظ الاسم والشعار"}</button>
  </form>;
}
