import type {Point} from './model';

export type SavedMeasurement={id:string;sceneId:string;label:string;meters:number;estimated?:boolean;endpoints?:[Point,Point]};
export const MAX_SAVED_MEASUREMENTS=200;
const point=(value:unknown):value is Point=>Boolean(value&&typeof value==='object'&&['x','y','z'].every(key=>Number.isFinite((value as Record<string,unknown>)[key])));
/** Local storage is untrusted, and measurements belong to one source revision. */
export function readMeasurements(raw:string|null,sceneIds:ReadonlySet<string>):SavedMeasurement[]{
 if(!raw||raw.length>1_000_000)return [];
 try{
  const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value))return [];
  const ids=new Set<string>();
  return value.filter((item):item is SavedMeasurement=>{
   if(!item||typeof item!=='object'||typeof item.id!=='string'||item.id.length>4096||ids.has(item.id)||!sceneIds.has(item.sceneId)||typeof item.label!=='string'||item.label.length>200||!Number.isFinite(item.meters)||item.meters<=0)return false;
   if(item.estimated!==undefined&&typeof item.estimated!=="boolean")return false;
   if(item.endpoints!==undefined&&(!Array.isArray(item.endpoints)||item.endpoints.length!==2||!item.endpoints.every(point)))return false;
   ids.add(item.id);return true;
  }).slice(-MAX_SAVED_MEASUREMENTS);
 }catch{return [];}
}

/** Injected storage keeps quota failures non-fatal and permits isolated tests. */
export function createMeasurementStore(key:string,sceneIds:ReadonlySet<string>,storage:()=>Pick<Storage,'getItem'|'setItem'>|undefined){
 let initialized=false,items:SavedMeasurement[]=[];
 const listeners=new Set<()=>void>();
 function read(){try{return readMeasurements(storage()?.getItem(key)??null,sceneIds);}catch{return [];}}
 const getSnapshot=()=>{if(!initialized){items=read();initialized=true;}return items;};
 const emit=()=>listeners.forEach(listener=>listener());
 const update=(next:SavedMeasurement[])=>{items=next;initialized=true;try{storage()?.setItem(key,JSON.stringify(items));}catch{/* In-memory measurements still work when browser storage is unavailable. */}emit();};
 return {
  getSnapshot,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  refresh(){items=read();initialized=true;emit();},
  save(item:SavedMeasurement){const current=getSnapshot();if(current.some(value=>value.id===item.id))return;const valid=readMeasurements(JSON.stringify([item]),sceneIds);if(valid.length)update([...current,...valid].slice(-MAX_SAVED_MEASUREMENTS));},
  remove(id:string){update(getSnapshot().filter(item=>item.id!==id));},
  clear(){update([]);},
 };
}
