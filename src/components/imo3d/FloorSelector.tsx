"use client";
import {useState} from "react";
export const floorLabel=(floor:number)=>floor===0?"الدور الأرضي":floor<0?`القبو ${Math.abs(floor)}`:`الدور ${floor}`;
export function FloorSelector({value,floors,onChange,disabled,label}:{value:number;floors:number[];onChange:(floor:number)=>void;disabled?:boolean;label:string}){
  const [custom,setCustom]=useState(false),[input,setInput]=useState(String(value));
  const choices=[...new Set([-1,0,1,2,...floors,value])].sort((a,b)=>a-b);
  return <label className="imo-floor-selector"><span>{label}</span><select disabled={disabled} value={custom?"custom":value} onChange={event=>{if(event.target.value==="custom"){setCustom(true);setInput(String(value));}else{setCustom(false);onChange(Number(event.target.value));}}}>{choices.map(floor=><option key={floor} value={floor}>{floorLabel(floor)}</option>)}<option value="custom">دور آخر…</option></select>{custom&&<input type="number" min={-10} max={200} step={1} disabled={disabled} aria-label={`${label} — رقم الدور`} value={input} onChange={event=>{setInput(event.target.value);const next=Number(event.target.value);if(event.target.value!==""&&Number.isInteger(next)&&next>=-10&&next<=200)onChange(next);}}/>}</label>;
}
