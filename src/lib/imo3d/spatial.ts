import type { Depth, Plan, Point, Scene, Tour, Wall } from "./model";
import { applyConnectionOverrides } from "./connection-overrides";

export const radians = (v: number) => v * Math.PI / 180;
export const distance = (a: Point, b: Point) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
export const angleDifference = (a: number,b: number) => Math.atan2(Math.sin(a-b),Math.cos(a-b));
export function worldRay(yaw: number, pitch: number): Point {
  return { x: Math.sin(yaw)*Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw)*Math.cos(pitch) };
}
// The panorama centre faces local -Z; yaw is clockwise from north in degrees.
export function sampleDepth(depth: Depth, localYaw: number, pitch: number) {
  const u = ((0.5 + localYaw/(2*Math.PI)) % 1 + 1) % 1;
  const v = Math.max(0,Math.min(1-1e-8,0.5-pitch/Math.PI));
  return depth.values[Math.floor(v*depth.height)*depth.width+Math.floor(u*depth.width)];
}
export function surfacePoint(scene: Scene, yaw: number,pitch: number): Point | null {
  if(!scene.position||!scene.depth)return null;
  const d=sampleDepth(scene.depth,yaw-radians(scene.yaw),pitch);
  if(!d||d<0.05)return null;
  const ray=worldRay(yaw,pitch);
  return {x:scene.position.x+ray.x*d,y:scene.position.y+ray.y*d,z:scene.position.z+ray.z*d};
}
function hasClearRay(from: Scene,to: Scene) {
  if(!from.position||!to.position||!from.depth)return false;
  const d=distance(from.position,to.position);
  const dx=to.position.x-from.position.x,dy=to.position.y-from.position.y,dz=to.position.z-from.position.z;
  const yaw=Math.atan2(dx,-dz)-radians(from.yaw),pitch=Math.atan2(dy,Math.hypot(dx,dz));
  // Require a corridor around the centre ray, not a single pinhole through a wall.
  const margin=Math.min(0.12,Math.atan2(0.16,d));
  return [-margin,0,margin].every(offset=>sampleDepth(from.depth!,yaw+offset,pitch)>d+0.12);
}
export function autoConnect(scenes: Scene[],maxDistance=5): Scene[] {
  const result=scenes.map(scene=>({...scene,links:[] as string[]}));
  for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++){
    const a=result[i],b=result[j];
    if(a.floor!==b.floor||!a.position||!b.position)continue;
    const d=distance(a.position,b.position);
    if(d<0.15||d>maxDistance||!hasClearRay(a,b)||!hasClearRay(b,a))continue;
    a.links.push(b.id);b.links.push(a.id);
  }
  return applyConnectionOverrides(result);
}
export function connectedComponents(scenes: Scene[]) {
  const byId=new Map(scenes.map(s=>[s.id,s]));const visited=new Set<string>();let components=0;
  for(const scene of scenes){if(visited.has(scene.id))continue;components++;const queue=[scene.id];
    while(queue.length){const id=queue.pop()!;if(visited.has(id))continue;visited.add(id);
      for(const next of byId.get(id)?.links??[])if(byId.has(next)&&!visited.has(next))queue.push(next);
    }
  }return components;
}
export function shortestPath(scenes: Scene[],from:string,to:string): string[] {
  const byId=new Map(scenes.map(s=>[s.id,s]));if(!byId.has(from)||!byId.has(to))return [];
  const costs=new Map([[from,0]]),previous=new Map<string,string>(),pending=new Set([from]);
  while(pending.size){const current=[...pending].sort((a,b)=>costs.get(a)!-costs.get(b)!)[0];pending.delete(current);if(current===to)break;
    const source=byId.get(current)!;
    for(const id of source.links){const target=byId.get(id);if(!target)continue;
      const cost=costs.get(current)!+(source.position&&target.position?distance(source.position,target.position):1);
      if(cost<(costs.get(id)??Infinity)){costs.set(id,cost);previous.set(id,current);pending.add(id);}
    }
  }
  if(!costs.has(to))return [];const path=[to];while(path[0]!==from)path.unshift(previous.get(path[0])!);return path;
}
export function pickDirection(scenes: Scene[],currentId:string,yaw:number) {
  const current=scenes.find(s=>s.id===currentId);if(!current)return null;
  return scenes.filter(s=>current.links.includes(s.id)&&s.floor===current.floor&&!current.blockedLinks?.includes(s.id)&&!s.blockedLinks?.includes(current.id)).flatMap(s=>{
    const manual=current.manualLinks?.find(link=>link.targetId===s.id);
    const dx=s.position&&current.position?s.position.x-current.position.x:0,dz=s.position&&current.position?s.position.z-current.position.z:0;
    if(!manual&&(!current.position||!s.position))return [];
    const heading=manual?radians(manual.yaw):Math.atan2(dx,-dz);
    const angle=Math.abs(angleDifference(heading,yaw));
    return [{scene:s,angle,score:angle*3+Math.hypot(dx,dz)*0.12}];
  }).filter(s=>s.angle<Math.PI/2.7).sort((a,b)=>a.score-b.score)[0]?.scene??null;
}
export function derivePlans(scenes: Scene[]): Plan[] {
  return [...new Set(scenes.map(s=>s.floor))].sort((a,b)=>a-b).map(floor=>{
    const floorScenes=scenes.filter(s=>s.floor===floor&&s.position);const walls:Wall[]=[];
    for(const scene of floorScenes){if(!scene.depth)continue;
      const points=Array.from({length:360},(_,i)=>surfacePoint(scene,radians(i)+radians(scene.yaw),0));
      for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];
        if(a&&b&&distance(a,b)<0.55)walls.push({a:{x:a.x,z:a.z},b:{x:b.x,z:b.z}});
      }
    }
    const points=[...floorScenes.map(s=>s.position!),...walls.flatMap(w=>[w.a,w.b])];
    const xs=points.map(p=>p.x),zs=points.map(p=>p.z);
    return {floor,label:floor===0?"الدور الأرضي":`الدور ${floor}`,kind:walls.length?"depth":floorScenes.length?"path":"missing",
      bounds:{minX:(xs.length?Math.min(...xs):0)-0.5,maxX:(xs.length?Math.max(...xs):1)+0.5,minZ:(zs.length?Math.min(...zs):0)-0.5,maxZ:(zs.length?Math.max(...zs):1)+0.5},walls};
  });
}
export function quality(scenes: Scene[]): Tour["quality"] {
  const positioned=scenes.filter(s=>s.position).length,depthScenes=scenes.filter(s=>s.depth).length,components=connectedComponents(scenes);
  const warnings=[];
  if(positioned<scenes.length)warnings.push("بعض اللقطات بلا موضع كاميرا؛ يلزم استكمال المعالجة المكانية قبل إنشاء مخطط الشقة.");
  if(depthScenes<scenes.length)warnings.push("خرائط العمق غير مكتملة؛ المشي بعمق والقياس متاحان فقط للقطات ذات العمق.");
  if(components>1)warnings.push(`توجد ${components} مجموعات منفصلة. الانتقال المباشر متاح، لكن مسار المشي بينها غير مثبت.`);
  if(scenes.some(scene=>scene.manualLinks?.length))warnings.push("الروابط اليدوية تحدد اتجاه الانتقال بين الصور؛ لا تثبت خلو المسار من الحواجز أو وجود عمق معاير.");
  return {positioned,depthScenes,components,warnings};
}
export function monthlyPayment(price:number,downPercent:number,annualRate:number,years:number) {
  const principal=price*(1-downPercent/100),months=years*12,rate=annualRate/1200;
  return rate===0?principal/months:principal*rate/(1-Math.pow(1+rate,-months));
}
