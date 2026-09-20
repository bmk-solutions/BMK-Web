"use client";
import {useCallback,useEffect,useMemo,useSyncExternalStore} from 'react';
import {createMeasurementStore,rescaleSavedEstimate,type MeasurementScaleContext,type SavedMeasurement} from '../../lib/imo3d/measurement-notebook';
import {formatMeasurement,type MeasurementUnit} from "@/lib/imo3d/measurement-units";
import {MeasurementUnitPicker} from "./MeasurementUnitPicker";
import type {Point} from '@/lib/imo3d/model';
export type {SavedMeasurement} from '../../lib/imo3d/measurement-notebook';
const empty:SavedMeasurement[]=[];

export function MeasurementNotebook({measurements,onRemove,onSelect,unit,onUnitChange}:{unit:MeasurementUnit;onUnitChange:(unit:MeasurementUnit)=>void;measurements:SavedMeasurement[];onRemove:(id:string)=>void;onSelect:(id:string)=>void}){
 return <details style={{position:'absolute',top:90,left:16,zIndex:25,background:'#f5faf5ed',color:'#173d31',borderRadius:12,padding:12,maxWidth:260,maxHeight:'35vh',overflow:'auto'}}><summary>القياسات المحفوظة ({measurements.length})</summary><MeasurementUnitPicker value={unit} onChange={onUnitChange}/>{measurements.map(item=><div key={item.id} style={{display:'flex',gap:10,alignItems:'center',marginTop:10}}><button type="button" onClick={()=>onSelect(item.sceneId)}>{item.label} · {formatMeasurement(item.meters,unit)} تقريبًا</button><button type="button" aria-label={`حذف قياس ${item.label}`} onClick={()=>onRemove(item.id)}>×</button></div>)}</details>;
}
/** Scoped to the tour/source revision, never shared with another apartment. */
export function useMeasurementNotebook(tourId:string,revision:number,sceneIds:string[],scaleContexts:Record<string,MeasurementScaleContext>={}){
 const key=`imo3d:measurements:v1:${tourId}:${revision}`;
 const sceneKey=JSON.stringify(sceneIds);
 const contextKey=JSON.stringify(scaleContexts);
 const store=useMemo(()=>{const contexts:Record<string,MeasurementScaleContext>=JSON.parse(contextKey);return createMeasurementStore(key,new Set<string>(JSON.parse(sceneKey)),()=>typeof window==='undefined'?undefined:window.localStorage,item=>rescaleSavedEstimate(item,contexts[item.sceneId]));},[key,sceneKey,contextKey]);
 const subscribe=useCallback((listener:()=>void)=>{
  const unsubscribe=store.subscribe(listener);
  const update=(event:StorageEvent)=>{if(event.key===key||event.key===null)store.refresh();};
  window.addEventListener('storage',update);
  return()=>{unsubscribe();window.removeEventListener('storage',update);};
 },[store,key]);
 const measurements=useSyncExternalStore(subscribe,store.getSnapshot,()=>empty);
 return {measurements,save:store.save,remove:store.remove,clear:store.clear};
}
/** Notify after a completed, calibrated pair; changing viewing angle adds nothing. */
export function CompletedMeasurement({id,sceneId,label,meters,onSave,endpoints,estimated,lensHeightMeters}:{lensHeightMeters?:number;estimated?:boolean;id:string;sceneId:string;label:string;meters:number|null;endpoints?:[Point,Point];onSave:(item:SavedMeasurement)=>void}){
 useEffect(()=>{if(meters!==null&&Number.isFinite(meters)&&meters>0)onSave({id,sceneId,label,meters,endpoints,estimated,lensHeightMeters});},[id,sceneId,label,meters,onSave,endpoints,estimated,lensHeightMeters]);
 return null;
}
