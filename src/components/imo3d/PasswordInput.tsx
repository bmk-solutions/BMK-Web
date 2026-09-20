"use client";
import {useId,useState,type InputHTMLAttributes} from 'react';
import {Icon} from './Icon';
import './password-input.css';

export function PasswordInput(props:Omit<InputHTMLAttributes<HTMLInputElement>,'type'>){
  const [visible,setVisible]=useState(false),generatedId=useId();
  const id=props.id??generatedId;
  const action=visible?'إخفاء كلمة المرور':'إظهار كلمة المرور';
  return <span className="imo-password-field">
    <input {...props} id={id} type={visible?'text':'password'} spellCheck={false} autoCapitalize="none"/>
    <button type="button" className="imo-password-toggle" aria-label={action} title={action} aria-controls={id} aria-pressed={visible} disabled={props.disabled} onClick={()=>setVisible(value=>!value)}>
      <Icon name="eye" size={20}/>{visible&&<span className="imo-password-slash" aria-hidden="true"/>}
    </button>
  </span>;
}
