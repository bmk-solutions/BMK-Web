import type {RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
import type {Scene} from '@/lib/imo3d/model';
import {navigationLink} from '../../lib/imo3d/navigation';
/** Fit a circular consensus from registered neighbours; never assume image north. */
export function rasterViewHeading(map:RasterNavigation,scenes:Scene[],currentId:string,yaw:number):number|undefined{
 const current=scenes.find(s=>s.id===currentId),origin=map.points.find(p=>p.sceneId===currentId);
 if(!current||!origin||!Number.isFinite(yaw))return;
 const offsets=map.points.flatMap(point=>{
  const scene=scenes.find(s=>s.id===point.sceneId),link=scene&&navigationLink(current,scene);
  const dx=(point.x-origin.x)*map.width,dy=(point.y-origin.y)*map.height;
  return link&&Math.hypot(dx,dy)>2?[Math.atan2(dx,-dy)-link.fromYaw]:[];
 });
 if(offsets.length<2)return;
 // Registration on an illustrated plan is approximate. A single noisy anchor
 // must not hide the heading of an otherwise consistent group.
 const delta=(a:number,b:number)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
 const candidates=offsets.map(center=>offsets.filter(value=>delta(value,center)<=Math.PI/6));
 const consensus=candidates.sort((a,b)=>b.length-a.length)[0];
 if(consensus.length<2||consensus.length<=offsets.length/2)return;
 const x=consensus.reduce((sum,v)=>sum+Math.cos(v),0),y=consensus.reduce((sum,v)=>sum+Math.sin(v),0);
 if(Math.hypot(x,y)/consensus.length<.85)return;
 return (yaw+Math.atan2(y,x))*180/Math.PI;
}
/** Image aspect ratio matters: normalized x/y alone distorts nearest selection. */
export function nearestRasterScene(map:RasterNavigation,x:number,y:number,eligible:ReadonlySet<string>):string|null{
 if(!Number.isFinite(x)||!Number.isFinite(y))return null;
 let best:string|null=null,distance=Infinity;
 for(const point of map.points){
  if(!eligible.has(point.sceneId))continue;
  const score=((point.x-x)*map.width)**2+((point.y-y)*map.height)**2;
  if(score<distance){distance=score;best=point.sceneId;}
 }
 return best;
}
