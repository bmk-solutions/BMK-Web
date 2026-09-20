export type MeasurementUnit='m'|'cm'|'in';
export function measurementValue(meters:number,unit:MeasurementUnit):number{
 return unit==='cm'?meters*100:unit==='in'?meters/.0254:meters;
}
export function formatMeasurement(meters:number,unit:MeasurementUnit):string{
 if(!Number.isFinite(meters)||meters<0)return '—';
 return `${measurementValue(meters,unit).toFixed(unit==='m'?2:1)} ${unit==='m'?'م':unit==='cm'?'سم':'in'}`;
}
