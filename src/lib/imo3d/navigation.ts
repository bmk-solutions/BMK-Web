import type {Scene,Tour} from "./model";
import {angleDifference,radians} from "./spatial";

const movementCodes=new Set(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"]);
export const isMovementCode=(code:string)=>movementCodes.has(code);

/** Physical codes keep WASD usable with an Arabic keyboard layout. */
export function heldHeading(keys:ReadonlySet<string>,yaw:number):number|null {
  const forward=Number(keys.has("KeyW")||keys.has("ArrowUp"))-Number(keys.has("KeyS")||keys.has("ArrowDown"));
  const right=Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft"));
  return forward||right?yaw+Math.atan2(right,forward):null;
}

export type NavigationBearings={fromYaw:number;toYaw:number};
type NavigationLink=NavigationBearings&{kind:"manual"|"visual"|"spatial";distance:number|null};

/** A diagram position is optional: a reciprocal visual pair has its own bearing. */
export function navigationLink(from:Scene,to:Scene):NavigationLink|null {
  if(from.id===to.id||from.floor!==to.floor||!from.links.includes(to.id)||!to.links.includes(from.id)||
    from.blockedLinks?.includes(to.id)||to.blockedLinks?.includes(from.id))return null;
  const dx=from.position&&to.position?to.position.x-from.position.x:0,dz=from.position&&to.position?to.position.z-from.position.z:0;
  const distance=from.position&&to.position&&Math.hypot(dx,dz)>.0001?Math.hypot(dx,dz):null;
  for(const [field,kind] of [["manualLinks","manual"],["visualLinks","visual"]] as const){
    const forward=from[field]?.find(link=>link.targetId===to.id),back=to[field]?.find(link=>link.targetId===from.id);
    if(forward&&back&&Number.isFinite(forward.yaw)&&Number.isFinite(back.yaw))return {kind,fromYaw:radians(forward.yaw),toYaw:radians(back.yaw),distance};
  }
  if(distance===null)return null;
  const fromYaw=Math.atan2(dx,-dz);
  return {kind:"spatial",fromYaw,toYaw:fromYaw+Math.PI,distance};
}

/** Prefer the aimed corridor, then the closest capture along nearly the same ray. */
export function pickNavigationDirection(scenes:Scene[],currentId:string,yaw:number,cone=Math.PI*55/180):Scene|null {
  if(!Number.isFinite(yaw))return null;
  const current=scenes.find(scene=>scene.id===currentId);if(!current)return null;
  const candidates=scenes.flatMap(scene=>{
    const link=navigationLink(current,scene);if(!link)return [];
    const angle=Math.abs(angleDifference(link.fromYaw,yaw));
    return angle<=cone?[{scene,link,angle}]:[];
  });
  const closestAngle=Math.min(...candidates.map(candidate=>candidate.angle));
  // Distance only breaks a near-alignment tie; a close side room must not beat
  // the doorway the user is actually facing because diagram scale is relative.
  const linked=candidates.filter(candidate=>candidate.angle<=closestAngle+radians(7)).sort((a,b)=>
    (a.link.distance??Infinity)-(b.link.distance??Infinity)||a.angle-b.angle||a.scene.id.localeCompare(b.scene.id))[0]?.scene;
  if(linked)return linked;
  // Fill missing directional graph edges locally without mutating saved links.
  // Explicit bearings and user-blocked pairs remain authoritative. Null or
  // coincident coordinates cannot establish a fallback movement direction.
  if(!current.position||!Number.isFinite(current.position.x)||!Number.isFinite(current.position.z))return null;
  const nearby=scenes.flatMap(scene=>{
    if(scene.id===current.id||scene.floor!==current.floor||!scene.position||
      current.blockedLinks?.includes(scene.id)||scene.blockedLinks?.includes(current.id))return [];
    const dx=scene.position.x-current.position!.x,dz=scene.position.z-current.position!.z,distance=Math.hypot(dx,dz);
    if(!Number.isFinite(distance)||distance<.01)return [];
    return [{scene,distance,yaw:Math.atan2(dx,-dz)}];
  });
  const nearest=nearby.map(candidate=>candidate.distance).sort((a,b)=>a-b)[0];
  if(nearest===undefined)return null;
  return nearby.filter(({scene,distance,yaw:heading})=>
    !navigationLink(current,scene)&&
    !current.manualLinks?.some(link=>link.targetId===scene.id)&&!scene.manualLinks?.some(link=>link.targetId===current.id)&&
    !current.visualLinks?.some(link=>link.targetId===scene.id)&&!scene.visualLinks?.some(link=>link.targetId===current.id)&&
    distance<=nearest*3&&Math.abs(angleDifference(heading,yaw))<=Math.min(cone,radians(35)))
    .sort((a,b)=>a.distance-b.distance||Math.abs(angleDifference(a.yaw,yaw))-Math.abs(angleDifference(b.yaw,yaw))||a.scene.id.localeCompare(b.scene.id))[0]?.scene??null;
}

/** Prefer reciprocal links, then nearby directional captures; never modify graph edges. */
export function pointerDestination(scenes:Scene[],currentId:string,yaw:number,pitch:number):Scene|null {
  if(!Number.isFinite(pitch)||pitch>Math.PI/3)return null;
  return pickNavigationDirection(scenes,currentId,yaw,radians(40));
}

export function cursorDirection(viewYaw:number,destinationYaw:number) {
  const delta=angleDifference(destinationYaw,viewYaw);
  return delta < -0.28?"left":delta > 0.28?"right":"forward";
}

/** Match the two doorway directions without inventing relative camera positions. */
export function manualArrivalYaw(from:Scene,to:Scene,viewYaw:number):number|undefined {
  if(from.floor!==to.floor||from.blockedLinks?.includes(to.id)||to.blockedLinks?.includes(from.id))return undefined;
  const forward=from.manualLinks?.find(link=>link.targetId===to.id),back=to.manualLinks?.find(link=>link.targetId===from.id);
  if(!forward||!back||!from.links.includes(to.id)||!to.links.includes(from.id))return undefined;
  return radians(back.yaw)+Math.PI+angleDifference(viewYaw,radians(forward.yaw));
}

export function navigationTransition(from:Scene,to:Scene,viewYaw:number,spatialSource?:Tour["spatialSource"],intent:"step"|"direct"="step"):{
  animation:true|"handover"|"visual"|false;arrivalYaw?:number;bearings?:NavigationBearings;
} {
  if(intent==="direct")return {animation:"handover",arrivalYaw:viewYaw};
  const link=navigationLink(from,to);
  if(!link)return {animation:"handover"};
  if(link.kind==="spatial"&&spatialSource!=="images")return {animation:true};
  return {animation:"visual",arrivalYaw:link.toYaw+Math.PI+angleDifference(viewYaw,link.fromYaw),
    bearings:{fromYaw:link.fromYaw,toYaw:link.toYaw}};
}
