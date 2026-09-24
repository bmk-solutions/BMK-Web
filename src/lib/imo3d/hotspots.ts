import {z} from 'zod';
import type {Point,Scene,Tour} from './model';
import {storedAssetPath} from './base-path.ts';
export const hotspotKinds={text:'نص',image:'صورة',video:'فيديو',audio:'صوت',pano:'بانوراما',link:'رابط',point:'نقطة انتقال',space:'جولة أخرى',screen:'شاشة فيديو',staging:'تصوّر بديل',product:'منتج',area:'منطقة'} as const;
// A served asset path (under the suite basePath) is stored in its canonical form.
export const hotspotUrl=z.string().max(2000).transform(storedAssetPath).refine(value=>{if(!value||/^\/api\/imo3d\/assets\/[0-9a-f-]{36}$/i.test(value))return true;try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'استخدم رابط HTTPS صحيحًا.');
export const hotspotSchema=z.object({
 id:z.string().uuid(),sceneId:z.string().min(1).max(80),kind:z.enum(Object.keys(hotspotKinds) as [keyof typeof hotspotKinds,...(keyof typeof hotspotKinds)[]]),
 title:z.string().trim().min(1).max(120),body:z.string().max(4000).default(''),url:hotspotUrl.default(''),link:hotspotUrl.default(''),
 yaw:z.number().finite().min(-180).max(180),pitch:z.number().finite().min(-85).max(85),
 targetSceneId:z.string().max(80).default(''),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#24b18b'),
 width:z.number().finite().min(3).max(80).default(20),height:z.number().finite().min(3).max(80).default(15),
 scale:z.number().min(.75).max(2).default(1),stem:z.number().min(0).max(80).default(0),
 visible:z.boolean().default(true),price:z.string().max(100).default(''),
}).strict().superRefine((value,ctx)=>{
 if(['image','video','audio','pano','link','space','screen','staging'].includes(value.kind)&&!value.url)ctx.addIssue({code:'custom',message:'أضف رابط المحتوى.',path:['url']});
 if(value.kind==='point'&&(!value.targetSceneId||value.targetSceneId===value.sceneId))ctx.addIssue({code:'custom',message:'اختر لقطة الانتقال.',path:['targetSceneId']});
});
export type Hotspot=z.infer<typeof hotspotSchema>;
export const hotspotsSchema=z.array(hotspotSchema).max(1000).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length,'معرّف نقطة مكرر.');
export function validateHotspots(tour:Tour,input:unknown):Hotspot[]{
 const rows=hotspotsSchema.parse(input),ids=new Set(tour.scenes.map(s=>s.id));
 if(rows.some(row=>!ids.has(row.sceneId)||(row.targetSceneId&&!ids.has(row.targetSceneId))))throw Error('اختر صورًا من الجولة نفسها للهوت سبوت والانتقال.');
 return rows;
}
export function hotspotPoint(scene:Scene,yaw:number,pitch:number):Point{
 const y=(yaw+scene.yaw)*Math.PI/180,p=pitch*Math.PI/180,o=scene.position??{x:0,y:0,z:0};
 return{x:o.x+Math.sin(y)*Math.cos(p)*3,y:o.y+Math.sin(p)*3,z:o.z-Math.cos(y)*Math.cos(p)*3};
}
