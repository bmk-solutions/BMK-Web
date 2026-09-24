import type {Plan, Point, Scene} from "@/lib/imo3d/model";
import {roomIdentity} from "./room-labels";
import {storedAssetPath} from "../../lib/imo3d/base-path";

export type MapPoint = {x:number;y:number};
export type MapViewport = {x:number;y:number;width:number;height:number};

/** A map click selects the nearest available capture in this map's frame. */
export function nearestPlanLocation(locations:readonly {id:string;point:MapPoint}[],target:MapPoint):string|null {
  if(!Number.isFinite(target.x)||!Number.isFinite(target.y))return null;
  let best:string|null=null,distance=Infinity;
  for(const location of locations){
    if(!Number.isFinite(location.point.x)||!Number.isFinite(location.point.y))continue;
    const next=Math.hypot(location.point.x-target.x,location.point.y-target.y);
    if(next<distance){distance=next;best=location.id;}
  }
  return best;
}

// Measured from all 485 line elements in the bundled architectural drawing.
// Unknown drawings keep their entire canvas so we never trim unmeasured walls.
export function floorPlanViewport(plan:Plan):MapViewport {
  if(plan.image&&storedAssetPath(plan.image)==="/imo3d/example/plan-f0.svg"&&plan.width===473&&plan.height===583)
    return {x:40,y:40,width:392.7,height:502.8};
  const width=Math.max(0.1,plan.width??plan.bounds.maxX-plan.bounds.minX);
  const height=Math.max(0.1,plan.height??plan.bounds.maxZ-plan.bounds.minZ);
  const padding=Math.max(width,height)*0.025;
  return {x:-padding,y:-padding,width:width+padding*2,height:height+padding*2};
}

export function floorPlanPoints(plan:Plan,scenes:Scene[]) {
  return scenes.filter(scene=>scene.floor===plan.floor&&(plan.scenePoints?.[scene.id]||scene.position&&!plan.image)).map(scene=>({
    scene,
    point:plan.scenePoints?.[scene.id]??{x:scene.position!.x-plan.bounds.minX,y:scene.position!.z-plan.bounds.minZ},
  }));
}

/** Fit the calibrated drawing from camera coordinates, including any axis flip. */
export function floorPlanProjection(plan:Plan,scenes:Scene[]) {
  if(!plan.image)return {
    project:(point:Point):MapPoint=>({x:point.x-plan.bounds.minX,y:point.z-plan.bounds.minZ}),
    heading:(yaw:number)=>yaw*180/Math.PI,
  };
  const pairs=floorPlanPoints(plan,scenes).filter(pair=>pair.scene.position);
  if(pairs.length<3)return null;
  const count=pairs.length;
  const mean=pairs.reduce((sum,{scene,point})=>({
    x:sum.x+scene.position!.x/count,z:sum.z+scene.position!.z/count,
    px:sum.px+point.x/count,py:sum.py+point.y/count,
  }),{x:0,z:0,px:0,py:0});
  let xx=0,xz=0,zz=0,xpx=0,zpx=0,xpy=0,zpy=0;
  for(const {scene,point} of pairs){
    const x=scene.position!.x-mean.x,z=scene.position!.z-mean.z,px=point.x-mean.px,py=point.y-mean.py;
    xx+=x*x;xz+=x*z;zz+=z*z;xpx+=x*px;zpx+=z*px;xpy+=x*py;zpy+=z*py;
  }
  const determinant=xx*zz-xz*xz;
  if(determinant<=Math.max(xx*zz,1)*1e-9)return null;
  const a=(xpx*zz-zpx*xz)/determinant,b=(zpx*xx-xpx*xz)/determinant;
  const c=(xpy*zz-zpy*xz)/determinant,d=(zpy*xx-xpy*xz)/determinant;
  if(Math.abs(a*d-b*c)<1e-9)return null;
  const project=(point:Point):MapPoint=>({x:a*(point.x-mean.x)+b*(point.z-mean.z)+mean.px,y:c*(point.x-mean.x)+d*(point.z-mean.z)+mean.py});
  const extent=Math.max(plan.width??0,plan.height??0,1);
  // A drawing with manually adjusted, non-affine points cannot truthfully place
  // an intermediate camera. In that case retain the exact captured positions.
  if(pairs.some(({scene,point})=>{const mapped=project(scene.position!);return Math.hypot(mapped.x-point.x,mapped.y-point.y)>extent*0.01;}))return null;
  return {project,heading:(yaw:number)=>{
    const x=Math.sin(yaw),z=-Math.cos(yaw);
    return Math.atan2(a*x+b*z,-(c*x+d*z))*180/Math.PI;
  }};
}

export function floorPlanRooms(points:ReturnType<typeof floorPlanPoints>) {
  const groups=new Map<string,typeof points>();
  for(const point of points){const id=roomIdentity(point.scene),group=groups.get(id)??[];group.push(point);groups.set(id,group);}
  return [...groups].map(([id,group])=>{
    const name=group[0].scene.room;
    const center=group.reduce((sum,{point})=>({x:sum.x+point.x/group.length,y:sum.y+point.y/group.length}),{x:0,y:0});
    // Anchor labels to a real capture location, never an invented room polygon.
    const anchor=group.reduce((best,item)=>Math.hypot(item.point.x-center.x,item.point.y-center.y)<Math.hypot(best.point.x-center.x,best.point.y-center.y)?item:best);
    return {id,name,scene:anchor.scene,point:anchor.point};
  });
}

export function floorPlanRoomLabels(rooms:ReturnType<typeof floorPlanRooms>,unit:number,viewport:MapViewport) {
  const occupied:{x:number;y:number;width:number;height:number}[]=[];
  return rooms.map(room=>{
    const width=Math.max(68,room.name.length*6)*unit,height=20*unit;
    const candidates=[-15.4,15.4,-40,40,-65,65].map(offset=>({x:room.point.x,y:room.point.y+offset*unit}));
    let label=candidates[0];
    for(const candidate of candidates){
      candidate.x=Math.max(viewport.x+width/2,Math.min(viewport.x+viewport.width-width/2,candidate.x));
      candidate.y=Math.max(viewport.y+height/2,Math.min(viewport.y+viewport.height-height/2,candidate.y));
      label=candidate;
      if(!occupied.some(rect=>Math.abs(candidate.x-rect.x)<(width+rect.width)/2+2*unit&&Math.abs(candidate.y-rect.y)<(height+rect.height)/2+2*unit))break;
    }
    occupied.push({...label,width,height});
    return {...room,label,width,height};
  });
}
