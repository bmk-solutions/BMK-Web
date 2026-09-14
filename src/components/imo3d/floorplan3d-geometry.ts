import type {Plan,Scene,Wall,PlanRoom} from "@/lib/imo3d/model";
import {pointInRoom} from "../../lib/imo3d/boundary-shapes";
import {roomChoices,roomIdentity} from "./room-labels";

export type Plan3DPoint={x:number;z:number};
export type Plan3DSegment={a:Plan3DPoint;b:Plan3DPoint;length:number;angle:number;estimated:boolean};
export type Plan3DLayout={
  origin:Plan3DPoint;bounds:{minX:number;maxX:number;minZ:number;maxZ:number};width:number;depth:number;span:number;
  walls:Plan3DSegment[];estimatedSurfaces:Plan3DSegment[];truncated:boolean;
  cameras:{id:string;name:string;room:string;point:Plan3DPoint;scene:Scene}[];
  links:{from:string;to:string;a:Plan3DPoint;b:Plan3DPoint;manual:boolean}[];
  rooms:{id:string;name:string;sceneId:string;positioned:boolean}[];metric:boolean;estimatedHeight?:number;
  floorRooms?:{id:string;outline:Plan3DPoint[];finish:PlanRoom["finish"]}[];
};
const finite=(point:Plan3DPoint)=>Number.isFinite(point.x)&&Number.isFinite(point.z)&&Math.abs(point.x)<1e7&&Math.abs(point.z)<1e7;
const segmentKey=(wall:Wall)=>{const a=`${wall.a.x.toFixed(5)},${wall.a.z.toFixed(5)}`,b=`${wall.b.x.toFixed(5)},${wall.b.z.toFixed(5)}`;return a<b?`${a}/${b}`:`${b}/${a}`;};

/** All horizontal coordinates come from the plan/cameras; no missing room outline is completed. */
export function buildFloorPlan3D(plan:Plan,scenes:Scene[],spatialScale?:"metric"|"relative"):Plan3DLayout{
  const floorScenes=scenes.filter(scene=>scene.floor===plan.floor),positioned=floorScenes.filter(scene=>scene.position&&finite(scene.position));
  const metric=spatialScale!=="relative"&&plan.authoredScale!=="relative"&&!plan.generatedFrom&&!plan.generatedRooms?.length&&(plan.kind==="geometry"||plan.kind==="depth");
  const clean=(walls:readonly Wall[])=>[...new Map(walls.filter(wall=>finite(wall.a)&&finite(wall.b)&&Math.hypot(wall.a.x-wall.b.x,wall.a.z-wall.b.z)>1e-7).map(wall=>[segmentKey(wall),wall])).values()];
  const boundaryRooms=plan.authoredRooms??plan.generatedRooms;
  // Closed inferred rooms are drawn as walls, but never acquire metric scale.
  const trusted=plan.kind==="geometry"||plan.kind==="depth"||!!plan.generatedRooms?.length?clean(plan.walls):[];
  const estimates=plan.kind==="estimated"&&!boundaryRooms?.length?clean([...(plan.estimatedSurfaces??[]),...plan.walls]):[];
  const points=[...positioned.map(scene=>scene.position!),...trusted.flatMap(wall=>[wall.a,wall.b]),...estimates.flatMap(wall=>[wall.a,wall.b])];
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const point of points){minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);minZ=Math.min(minZ,point.z);maxZ=Math.max(maxZ,point.z);}
  if(!points.length){minX=0;maxX=0;minZ=0;maxZ=0;}
  const origin={x:(minX+maxX)/2,z:(minZ+maxZ)/2};
  const centered=(point:Plan3DPoint)=>({x:point.x-origin.x,z:point.z-origin.z});
  const span=Math.max(maxX-minX,maxZ-minZ,metric?2:1),width=Math.max(maxX-minX,span*.1),depth=Math.max(maxZ-minZ,span*.1);
  const cap=6000;
  const segments=(walls:Wall[],estimated:boolean)=>walls.filter((_,index)=>walls.length<=cap||Math.floor(index*cap/walls.length)!==Math.floor((index-1)*cap/walls.length)).slice(0,cap).map(wall=>({a:centered(wall.a),b:centered(wall.b),length:Math.hypot(wall.b.x-wall.a.x,wall.b.z-wall.a.z),angle:-Math.atan2(wall.b.z-wall.a.z,wall.b.x-wall.a.x),estimated}));
  const cameras=positioned.map(scene=>({id:scene.id,name:scene.name,room:scene.room,point:centered(scene.position!),scene}));
  const byId=new Map(cameras.map(camera=>[camera.id,camera]));
  const links=cameras.flatMap(camera=>camera.scene.links.flatMap(id=>{
    const target=byId.get(id);
    if(!target||camera.id>=id||!target.scene.links.includes(camera.id)||camera.scene.blockedLinks?.includes(id)||target.scene.blockedLinks?.includes(camera.id))return [];
    return [{from:camera.id,to:id,a:camera.point,b:target.point,manual:!!camera.scene.manualLinks?.some(link=>link.targetId===id)}];
  }));
  const roomIds=[...new Set(floorScenes.map(roomIdentity))];
  const rooms=roomIds.map(id=>{const first=floorScenes.find(scene=>roomIdentity(scene)===id)!,name=first.room,group=cameras.filter(camera=>roomIdentity(camera.scene)===id);let sceneId=first.id;
    if(group.length){const center={x:group.reduce((sum,camera)=>sum+camera.point.x,0)/group.length,z:group.reduce((sum,camera)=>sum+camera.point.z,0)/group.length};sceneId=group.reduce((best,camera)=>Math.hypot(camera.point.x-center.x,camera.point.z-center.z)<Math.hypot(best.point.x-center.x,best.point.z-center.z)?camera:best).id;}
    return {id,name,sceneId,positioned:!!group.length};});
  const representatives=new Map(roomChoices(positioned,plan.floor).map(choice=>[choice.scene.roomSemantic?.groupId??choice.id,choice.scene]));
  const authored=boundaryRooms?.map(room=>{const member=representatives.get(room.id)??floorScenes.find(scene=>scene.roomSemantic?.groupId===room.id),scene=member??positioned.find(scene=>pointInRoom(scene.position!,room.outline));return{id:room.id,name:plan.authoredRooms?room.name:member?.room??room.name,sceneId:scene?.id??"",positioned:!!scene?.position};});
  const inferredHeight=plan.generatedFrom?.ceilingHeight;
  return {origin,bounds:{minX:minX-origin.x,maxX:maxX-origin.x,minZ:minZ-origin.z,maxZ:maxZ-origin.z},width,depth,span,walls:segments(trusted,false),estimatedSurfaces:segments(estimates,true),truncated:trusted.length>cap||estimates.length>cap,cameras,links,rooms:authored??rooms,metric,estimatedHeight:inferredHeight&&Number.isFinite(inferredHeight)&&inferredHeight>.2&&inferredHeight<20?inferredHeight:undefined,floorRooms:boundaryRooms?.map(room=>({id:room.id,outline:room.outline.map(centered),finish:room.finish}))};
}

/** Presentation heights are deliberately separate from all source measurements. */
export function floorPlan3DDisplay(layout:Plan3DLayout,lowWalls=true){
  const height=layout.metric?(lowWalls?1.05:2.45):layout.estimatedHeight?layout.estimatedHeight*(lowWalls?.43:1):layout.span*(lowWalls?.09:.2);
  return {height,thickness:layout.metric?.045:layout.span*.004,markerRadius:layout.span*.011,padding:layout.span*.09};
}

export function floorPlan3DFitDistance(width:number,depth:number,height:number,aspect:number,fov=42,top=false){
  const vertical=Math.tan(fov*Math.PI/360),horizontal=vertical*Math.max(.1,aspect);
  const raw=top?{x:0,y:1,z:.001}:{x:.85,y:1.1,z:1.05},length=Math.hypot(raw.x,raw.y,raw.z);
  const back={x:raw.x/length,y:raw.y/length,z:raw.z/length},horizontalLength=Math.hypot(back.x,back.z);
  const right={x:back.z/horizontalLength,z:-back.x/horizontalLength};
  const up={x:back.y*right.z,y:back.z*right.x-back.x*right.z,z:-back.y*right.x};
  let distance=1;
  // Fit the actual box against both frustum axes at the intended camera angle.
  // A bounding sphere left excessive empty space around shallow apartment plans.
  for(const x of [-width/2,width/2])for(const z of [-depth/2,depth/2])for(const floorY of [0,height]){
    const y=floorY-height*.12,near=x*back.x+y*back.y+z*back.z;
    const screenX=x*right.x+z*right.z,screenY=x*up.x+y*up.y+z*up.z;
    distance=Math.max(distance,near+Math.abs(screenX)/horizontal*1.08,near+Math.abs(screenY)/vertical*1.08);
  }
  return distance;
}
