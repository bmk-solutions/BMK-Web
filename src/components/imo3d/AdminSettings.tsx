"use client";
import {useState} from 'react';
import {Dialog} from './Dialog';
import {api} from './client';
export function AdminSettings({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Dialog title="الإعدادات" onClose={()=>{if(!busy)onClose();}}><form className="imo-form" onSubmit={async event=>{
    event.preventDefault();if(busy)return;const form=event.currentTarget,values=new FormData(form);
    const currentPassword=String(values.get('currentPassword')),newPassword=String(values.get('newPassword')),confirmPassword=String(values.get('confirmPassword'));
    if(newPassword!==confirmPassword){setError('كلمتا المرور الجديدتان غير متطابقتين.');return;}
    setBusy(true);setError('');
    try{await api('settings/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword,confirmPassword})});form.reset();onSaved();}
    catch(reason){setError(reason instanceof Error?reason.message:'تعذر تغيير كلمة المرور.');}finally{setBusy(false);}
  }}><h3>تغيير كلمة مرور الإدارة</h3><p>استخدم 12 حرفًا على الأقل. بعد الحفظ ستُسجّل الأجهزة الأخرى خروجها، وستبقى جلستك الحالية مفتوحة.</p>
    <label>كلمة المرور الحالية<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} disabled={busy}/></label>
    <label>كلمة المرور الجديدة<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy}/></label>
    <label>تأكيد كلمة المرور الجديدة<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy}/></label>
    {error&&<p className="imo-error" role="alert">{error}</p>}<button className="imo-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ كلمة المرور'}</button>
  </form></Dialog>;
}
