import type {RasterNavigation} from "@/lib/imo3d/ai-plan-jobs";
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
