import type {MeasurementUnit} from '@/lib/imo3d/measurement-units';
export function MeasurementUnitPicker({value,onChange}:{value:MeasurementUnit;onChange:(unit:MeasurementUnit)=>void}){
 return <label className="imo-measure-units">الوحدة <select aria-label="وحدة القياس" value={value} onChange={event=>onChange(event.target.value as MeasurementUnit)}><option value="m">متر · m</option><option value="cm">سنتيمتر · cm</option><option value="in">إنش · in</option></select></label>;
}
