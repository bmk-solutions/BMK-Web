"use client";
import {useEffect,useState} from "react";
import {nextThemeChoice,resolveTheme,THEME_KEY,type Theme} from "@/lib/imo3d/theme";
import {Icon} from "./Icon";

const shownTheme=():Theme=>document.documentElement.dataset.imoTheme==="light"?"light":"dark";
/** Flips light/dark for the studio and the viewer; the boot script keeps following the device otherwise. */
export function ThemeToggle({className="",showLabel=true,onToggled}:{className?:string;showLabel?:boolean;onToggled?:()=>void}){
 const [theme,setTheme]=useState<Theme|null>(null);
 useEffect(()=>{
  const read=()=>setTheme(shownTheme());read();
  const observer=new MutationObserver(read);observer.observe(document.documentElement,{attributes:true,attributeFilter:["data-imo-theme"]});
  return()=>observer.disconnect();
 },[]);
 const toggle=()=>{
  const prefersLight=matchMedia("(prefers-color-scheme: light)").matches,choice=nextThemeChoice(shownTheme(),prefersLight);
  try{if(choice==="system")localStorage.removeItem(THEME_KEY);else localStorage.setItem(THEME_KEY,choice);}catch{/* A private window still switches for this visit. */}
  const next=resolveTheme(choice,prefersLight);
  document.documentElement.dataset.imoTheme=next;document.documentElement.style.colorScheme=next;onToggled?.();
 };
 const label=theme==="light"?"الوضع الداكن":"الوضع الفاتح";
 return <button type="button" className={`imo-theme-toggle ${className}`.trim()} onClick={toggle} aria-label={`التبديل إلى ${label}`} title={`التبديل إلى ${label}`}>
  <Icon name={theme==="light"?"moon":"sun"} size={19}/>{showLabel&&<span>{theme?label:"المظهر"}</span>}
 </button>;
}
