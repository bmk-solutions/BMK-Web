import type {Point,Scene,DisplayDepth,Tour} from './model';
import {supportedDisplayDepth} from './display-depth';
import {radians,worldRay} from './spatial';
/** Explicit display-depth estimate, NEVER promotes a tour to metric geometry. */
/** Shared capture setup: user measured floor-to-lens height as 1.27 m.
 * Fallback for existing/new projects; a tour's recorded height takes precedence.
 * It is an assumption for captures whose individual setup was not confirmed. */
export const DEFAULT_CAPTURE_HEIGHT_METERS=1.27;
export function recordedMeasurementHeight(tour:Pick<Tour,'measurementScale'>,sceneId:string):number|null{
 const scale=tour.measurementScale;
 return scale?.source==='operator_measured'&&Number.isFinite(scale.heightMeters)&&scale.heightMeters>=.15&&scale.heightMeters<=10&&Array.isArray(scale.sceneIds)&&scale.sceneIds.includes(sceneId)?scale.heightMeters:null;
}
/** Fill only a single-cell gap bracketed by consistent neighbouring depths.
 * Never span an open doorway, a discontinuity, a large missing region or a pole.
 */
export function measurementDepthSample(depth:DisplayDepth,x:number,y:number):number|null{
 const direct=depth.values[y*depth.width+x];
 if(Number.isFinite(direct)&&direct>=.2)return direct;
 if(depth.width<64||y<=0||y>=depth.height-1)return null;
 const at=(dx:number,dy:number)=>depth.values[(y+dy)*depth.width+(x+dx+depth.width)%depth.width];
 const values=[at(-1,0),at(1,0),at(0,-1),at(0,1)];
 const valid=(v:number)=>Number.isFinite(v)&&v>=.2;
 if(!(valid(values[0])&&valid(values[1]))&&!(valid(values[2])&&valid(values[3])))return null;
 const usable=values.filter(valid).sort((a,b)=>a-b);
 if(usable.length<3||usable.at(-1)!-usable[0]>Math.max(.08,usable[0]*.12))return null;
 return usable.reduce((sum,value)=>sum+value,0)/usable.length;
}
/** Subpixel sampling on a locally continuous surface. Interpolate inverse depth,
 * which follows planar perspective more closely than radial distance. Never
 * blend the foreground door/wall with another room behind it.
 */
export function continuousMeasurementDepth(depth:DisplayDepth,u:number,v:number):number|null{
 if(!Number.isFinite(u)||!Number.isFinite(v)||v<0||v>1)return null;
 const wrapped=((u%1)+1)%1,clamped=Math.min(1-1e-8,v);
 const nearest=measurementDepthSample(depth,Math.floor(wrapped*depth.width),Math.floor(clamped*depth.height));
 if(nearest===null)return null;
 const x=wrapped*depth.width-.5,y=clamped*depth.height-.5;
 const left=Math.floor(x),top=Math.floor(y),fx=x-left,fy=y-top;
 if(top<0||top+1>=depth.height)return nearest;
 const corners=[[left,top,(1-fx)*(1-fy)],[left+1,top,fx*(1-fy)],
  [left,top+1,(1-fx)*fy],[left+1,top+1,fx*fy]];
 const samples=corners.map(([cx,cy,weight])=>({weight,value:measurementDepthSample(depth,(cx+depth.width)%depth.width,cy)}));
 if(samples.some(s=>s.value===null))return nearest;
 const values=samples.map(s=>s.value!);
 if(Math.max(...values)-Math.min(...values)>Math.max(.08,Math.min(...values)*.12))return nearest;
 const inverse=samples.reduce((sum,s)=>sum+s.weight/s.value!,0);
 return Number.isFinite(inverse)&&inverse>0?1/inverse:nearest;
}
export function estimatedMeasurementPoint(scene:Scene,yaw:number,pitch:number,heightMeters=DEFAULT_CAPTURE_HEIGHT_METERS):Point|null{
 const depth=supportedDisplayDepth(scene.displayDepth);
 if(!depth||!Number.isFinite(yaw)||!Number.isFinite(pitch)||Math.abs(pitch)>Math.PI/2||!Number.isFinite(heightMeters)||heightMeters<.15||heightMeters>10)return null;
 const u=((.5+(yaw-radians(scene.yaw))/(2*Math.PI))%1+1)%1;
 const v=Math.max(0,Math.min(1-1e-8,.5-pitch/Math.PI));
 const d=continuousMeasurementDepth(depth,u,v);
 if(d===null)return null;
 const ray=worldRay(yaw,pitch),origin=scene.position??{x:0,y:0,z:0};
 const radius=d*heightMeters;
 return {x:origin.x+ray.x*radius,y:origin.y+ray.y*radius,z:origin.z+ray.z*radius};
}
