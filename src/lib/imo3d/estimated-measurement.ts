import type {Point,Scene,DisplayDepth} from './model';
import {supportedDisplayDepth} from './display-depth';
import {radians,worldRay} from './spatial';
/** Explicit display-depth estimate, NEVER promotes a tour to metric geometry. */
export const ASSUMED_CAMERA_HEIGHT_METERS=1.6;
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
export function estimatedMeasurementPoint(scene:Scene,yaw:number,pitch:number):Point|null{
 const depth=supportedDisplayDepth(scene.displayDepth);
 if(!depth||!Number.isFinite(yaw)||!Number.isFinite(pitch)||Math.abs(pitch)>Math.PI/2)return null;
 const u=((.5+(yaw-radians(scene.yaw))/(2*Math.PI))%1+1)%1;
 const v=Math.max(0,Math.min(1-1e-8,.5-pitch/Math.PI));
 const d=measurementDepthSample(depth,Math.floor(u*depth.width),Math.floor(v*depth.height));
 if(d===null)return null;
 const ray=worldRay(yaw,pitch),origin=scene.position??{x:0,y:0,z:0};
 const radius=d*ASSUMED_CAMERA_HEIGHT_METERS;
 return {x:origin.x+ray.x*radius,y:origin.y+ray.y*radius,z:origin.z+ray.z*radius};
}
