import {supportedDisplayDepth} from "./display-depth";
import type {Point,Scene,Tour} from "./model";
import {angleDifference,radians,sampleDepth,surfacePoint} from "./spatial";

const movementCodes=new Set(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"]);
export const isMovementCode=(code:string)=>movementCodes.has(code);

/** Physical codes keep WASD usable with an Arabic keyboard layout. */
export function heldHeading(keys:ReadonlySet<string>,yaw:number):number|null {
  const forward=Number(keys.has("KeyW")||keys.has("ArrowUp"))-Number(keys.has("KeyS")||keys.has("ArrowDown"));
  const right=Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft"));
  return forward||right?yaw+Math.atan2(right,forward):null;
}

export type NavigationBearings={fromYaw:number;toYaw:number};

/** Warm the direction being explored, not the arbitrary order of stored links. */
export function navigationPrefetch(scenes:Scene[],current:Scene,yaw:number,intentId?:string):Scene[] {
  return scenes.flatMap(scene=>{
    const link=navigationLink(current,scene);
    return link?[{scene,angle:Math.abs(angleDifference(link.fromYaw,yaw)),distance:link.distance??Infinity}]:[];
  }).sort((a,b)=>Number(b.scene.id===intentId)-Number(a.scene.id===intentId)||a.angle-b.angle||a.distance-b.distance||a.scene.id.localeCompare(b.scene.id)).map(item=>item.scene);
}
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

export type PointerSurface={kind:"floor"|"wall"|"unknown";point?:Point};
export function sameNavigationRoom(a:Scene,b:Scene):boolean{
  if(a.floor!==b.floor)return false;
  if(a.roomSemantic?.groupId||b.roomSemantic?.groupId)return Boolean(a.roomSemantic?.groupId)&&a.roomSemantic?.groupId===b.roomSemantic?.groupId;
  return Boolean(a.room?.trim())&&a.room.trim()===b.room?.trim();
}
/** Walls select a capture on this side; a room exit needs a supported floor ray
 * aimed through a reciprocal visual/manual connection, not a diagram shortcut. */
export function pointerRoomAllowed(current:Scene,target:Scene,yaw:number,surface:PointerSurface):boolean{
  if(sameNavigationRoom(current,target))return true;
  if(surface.kind!=="floor")return false;
  const link=navigationLink(current,target);
  return Boolean(link&&link.kind!=="spatial"&&Math.abs(angleDifference(link.fromYaw,yaw))<=radians(12));
}

/** Extend a doorway click along reciprocal forward links. A bent graph path is
 * not evidence that the destination is visible through the door. */
function forwardDoorwayDestinations(scenes:Scene[],current:Scene,yaw:number):Set<string>{
  const byId=new Map(scenes.map(scene=>[scene.id,scene]));
  const reached=new Set<string>([current.id]),queue=[current];
  for(let index=0;index<queue.length;index++){
    const from=queue[index];
    for(const id of from.links){
      const to=byId.get(id);if(!to||reached.has(id)||to.floor!==current.floor||current.blockedLinks?.includes(id)||to.blockedLinks?.includes(current.id))continue;
      const link=navigationLink(from,to);if(!link)continue;
      const crossing=!sameNavigationRoom(from,to);
      if(crossing&&link.kind==="spatial")continue;
      if(Math.abs(angleDifference(link.fromYaw,yaw))>radians(crossing?12:25))continue;
      if(current.position&&to.position){
        const dx=to.position.x-current.position.x,dz=to.position.z-current.position.z;
        if(Math.abs(angleDifference(Math.atan2(dx,-dz),yaw))>radians(25))continue;
        if(from.position){
          const progress=(to.position.x-from.position.x)*Math.sin(yaw)-(to.position.z-from.position.z)*Math.cos(yaw);
          if(progress<=.001)continue;
        }
      }
      reached.add(id);queue.push(to);
    }
  }
  return reached;
}

/** Prefer reciprocal links, then nearby directional captures; never modify graph edges. */
export function pointerDestination(scenes:Scene[],currentId:string,yaw:number,pitch:number,metricGeometry=false,surface?:PointerSurface):Scene|null {
  if(!Number.isFinite(yaw)||!Number.isFinite(pitch)||(!surface&&pitch>Math.PI/3))return null;
  const current=scenes.find(scene=>scene.id===currentId);
  const doorwayTargets=current&&surface?.kind==="floor"?forwardDoorwayDestinations(scenes,current,yaw):new Set<string>();
  const allowed=(scene:Scene)=>!surface||Boolean(current&&(pointerRoomAllowed(current,scene,yaw,surface)||doorwayTargets.has(scene.id)));
  // The clicked surface position takes priority over screen-height heuristics.
  // This works without a graph edge, but never relaxes room/doorway boundaries.
  if(current?.position&&surface?.point&&surface.kind!=="unknown"&&(!metricGeometry||surface.kind==="wall")&&
    [surface.point.x,surface.point.z,current.position.x,current.position.z].every(Number.isFinite)){
    const hit=surface.point;
    const separation=(scene:Scene)=>scene.position?Math.hypot(scene.position.x-hit.x,scene.position.z-hit.z):Infinity;
    let best:Scene|null=null,bestDistance=separation(current);
    for(const scene of scenes){
      if(scene.id===current.id||scene.floor!==current.floor||!allowed(scene)||current.blockedLinks?.includes(scene.id)||scene.blockedLinks?.includes(current.id))continue;
      const d=separation(scene);
      if(d+1e-5<bestDistance){best=scene;bestDistance=d;}
    }
    return best;
  }
  if(metricGeometry&&current?.depth&&current.position){
    const hit=surfacePoint(current,yaw,pitch);
    if(hit){
      const origin=current.position;
      let best:Scene|null=null,bestDistance=Math.hypot(hit.x-origin.x,hit.z-origin.z);
      for(const scene of scenes){
        if(scene.id===current.id||scene.floor!==current.floor||!scene.position||current.blockedLinks?.includes(scene.id)||scene.blockedLinks?.includes(current.id))continue;
        if(!allowed(scene))continue;
        const dx=scene.position.x-origin.x,dy=scene.position.y-origin.y,dz=scene.position.z-origin.z;
        const horizontal=Math.hypot(dx,dz),distance=Math.hypot(dx,dy,dz),heading=Math.atan2(dx,-dz);
        if(distance<.01||!Number.isFinite(distance)||Math.abs(angleDifference(heading,yaw))>radians(40))continue;
        // A distant destination needs a clear corridor, not just a graph path
        // that could turn around a wall. Image-only display depth is never used.
        const margin=Math.min(.12,Math.atan2(.16,distance));
        if(![-margin,0,margin].every(offset=>sampleDepth(current.depth!,heading-radians(current.yaw)+offset,Math.atan2(dy,horizontal))>distance+.12))continue;
        const score=Math.hypot(hit.x-scene.position.x,hit.z-scene.position.z);
        if(score<bestDistance){best=scene;bestDistance=score;}
      }
      return best;
    }
  }
  // Pointer selection is a direct destination, unlike keyboard walking steps.
  // Search the connected tour, not only the nearest immediate neighbour. This
  // does not assert that the straight line is a physical walkable corridor.
  if(current&&Number.isFinite(yaw)){
    const candidates=scenes.flatMap(scene=>{
      if(scene.floor!==current.floor||scene.id===current.id||current.blockedLinks?.includes(scene.id)||scene.blockedLinks?.includes(current.id))return [];
      if(!allowed(scene))return [];
      const link=navigationLink(current,scene);
      const dx=current.position&&scene.position?scene.position.x-current.position.x:0;
      const dz=current.position&&scene.position?scene.position.z-current.position.z:0;
      const distance=Math.hypot(dx,dz);
      if(!link&&(!Number.isFinite(distance)||distance<.01))return [];
      const heading=link?.fromYaw??Math.atan2(dx,-dz);
      const angle=Math.abs(angleDifference(heading,yaw));
      return angle<=radians(40)?[{scene,angle,distance:link?.distance??distance}]:[];
    });
    // Screen height distinguishes destinations along the same corridor. Looking
    // near the horizon selects farther captures; looking down selects closer ones.
    // This relative navigation heuristic is NOT metric geometry or measurement.
    const bestAngle=Math.min(...candidates.map(item=>item.angle));
    const aimed=candidates.filter(item=>item.angle<=bestAngle+radians(8));
    const distances=candidates.map(item=>item.distance).filter(value=>value>0&&Number.isFinite(value)).sort((a,b)=>a-b);
    const step=distances[0];
    if(step&&aimed.length>1){
      const targetDistance=step/Math.tan(Math.max(radians(2),Math.min(radians(85),-pitch)));
      const score=(item:typeof aimed[number])=>Math.abs(Math.log(Math.max(.001,item.distance)/targetDistance))+item.angle*.5;
      aimed.sort((a,b)=>score(a)-score(b)||a.scene.id.localeCompare(b.scene.id));
    }else aimed.sort((a,b)=>a.angle-b.angle||a.distance-b.distance||a.scene.id.localeCompare(b.scene.id));
    if(aimed[0])return aimed[0].scene;
    // Missing surface geometry must not make most of the panorama unclickable.
    // A same-room fallback may choose an off-axis capture; it cannot exit a room.
    if(surface){
      const local=scenes.flatMap(scene=>{
        if(scene.id===current.id||!sameNavigationRoom(current,scene)||current.blockedLinks?.includes(scene.id)||scene.blockedLinks?.includes(current.id))return [];
        const link=navigationLink(current,scene),a=current.position,b=scene.position;
        if(!link&&(!a||!b||![a.x,a.z,b.x,b.z].every(Number.isFinite)||Math.hypot(b.x-a.x,b.z-a.z)<.01))return [];
        const heading=link?.fromYaw??Math.atan2(b!.x-a!.x,-(b!.z-a!.z)),angle=Math.abs(angleDifference(heading,yaw));
        return angle<Math.PI/2?[{scene,angle,distance:link?(link.distance??Infinity):Math.hypot(b!.x-a!.x,b!.z-a!.z)}]:[];
      }).sort((a,b)=>a.angle-b.angle||a.distance-b.distance||a.scene.id.localeCompare(b.scene.id));
      if(local[0])return local[0].scene;
    }
  }
  return surface?null:pickNavigationDirection(scenes,currentId,yaw,radians(40));
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
  const link=navigationLink(from,to);
  if(!link){
    // A direct destination can have useful local depth without an immediate graph
    // edge. Preserve heading and use bounded depth parallax, never invent a route
    // through intermediate captures or promote diagram coordinates to meters.
    const a=from.position,b=to.position;
    if(intent==="direct"&&from.id!==to.id&&from.floor===to.floor&&a&&b&&
      !from.blockedLinks?.includes(to.id)&&!to.blockedLinks?.includes(from.id)&&
      supportedDisplayDepth(from.displayDepth)&&supportedDisplayDepth(to.displayDepth)&&
      [a.x,a.z,b.x,b.z].every(Number.isFinite)&&Math.hypot(b.x-a.x,b.z-a.z)>.001){
      const heading=Math.atan2(b.x-a.x,-(b.z-a.z));
      return {animation:"visual",arrivalYaw:viewYaw,bearings:{fromYaw:heading,toYaw:heading+Math.PI}};
    }
    return intent==="direct"?{animation:"handover",arrivalYaw:viewYaw}:{animation:"handover"};
  }
  if(link.kind==="spatial"&&spatialSource!=="images")return {animation:true};
  return {animation:"visual",arrivalYaw:link.toYaw+Math.PI+angleDifference(viewYaw,link.fromYaw),
    bearings:{fromYaw:link.fromYaw,toYaw:link.toYaw}};
}
