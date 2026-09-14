"use client";
import {useEffect,useRef} from "react";
import {Icon} from "./Icon";
export function Dialog({title,children,onClose,wide=false,className=""}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean;className?:string}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
  return <dialog ref={ref} className={`imo-dialog ${wide?"wide":""} ${className}`} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}>
    <header><h2>{title}</h2><button className="imo-icon" aria-label="إغلاق" onClick={onClose}><Icon name="close"/></button></header>{children}
  </dialog>;
}
