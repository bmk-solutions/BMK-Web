import {z} from 'zod';

export const planLabelsSchema=z.array(z.object({roomId:z.string().min(1).max(80),name:z.string().trim().min(1).max(80),x:z.number().min(0).max(1),y:z.number().min(0).max(1)}).strict()).max(100);
export type PlanLabel=z.infer<typeof planLabelsSchema>[number];
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
/** Labels are separate from the generated pixels, so renaming needs no model call. */
export function labeledPlanSVG(png:Buffer,width:number,height:number,labels:PlanLabel[]){
 const font=Math.max(12,width*.017);
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/>${labels.map(label=>`<text x="${label.x*width}" y="${label.y*height}" text-anchor="middle" dominant-baseline="middle" direction="rtl" font-family="Arial,sans-serif" font-size="${font}" font-weight="600" fill="#193d32" stroke="#f7f6ed" stroke-width="${font*.26}" stroke-linejoin="round" paint-order="stroke">${escape(label.name)}</text>`).join('')}</svg>`;
}
