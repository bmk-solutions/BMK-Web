import type {Plan,PlanRoom,Wall} from "./model";
export class BoundaryError extends Error{readonly status:number;constructor(message:string,status=400){super(message);this.status=status;}}
export function pointInRoom(point:{x:number;z:number},outline:{x:number;z:number}[]){let inside=false;for(let i=0,j=outline.length-1;i<outline.length;j=i++){const a=outline[i],b=outline[j];if((a.z>point.z)!==(b.z>point.z)&&point.x<(b.x-a.x)*(point.z-a.z)/(b.z-a.z)+a.x)inside=!inside;}return inside;}
const cross=(a:{x:number;z:number},b:{x:number;z:number},c:{x:number;z:number})=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
export function validateRoom(room:PlanRoom){
  const p=room.outline,n=p.length;let area=0;
  for(let i=0;i<n;i++){const a=p[i],b=p[(i+1)%n];if(Math.hypot(a.x-b.x,a.z-b.z)<.001)throw new BoundaryError("حرّك نقاط الجدار المتطابقة أو احذف إحداها.");area+=a.x*b.z-b.x*a.z;
    for(let j=i+2;j<n;j++){if(i===0&&j===n-1)continue;const c=p[j],d=p[(j+1)%n];if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))&&Math.max(Math.min(a.z,b.z),Math.min(c.z,d.z))<=Math.min(Math.max(a.z,b.z),Math.max(c.z,d.z)))throw new BoundaryError("حدود الغرفة تتقاطع. رتّب زواياها دون تقاطع.");}
  }
  if(Math.abs(area)<.01)throw new BoundaryError("ارسم مساحة مغلقة للغرفة.");
  if(new Set(room.openings).size!==room.openings.length||room.openings.some(index=>index>=n))throw new BoundaryError("فتحة الباب غير مرتبطة بجدار صحيح.");
  for(const door of room.doorwayCandidates??[])if(!Number.isInteger(door.edge)||door.edge<0||door.edge>=n||!Number.isFinite(door.offset)||!Number.isFinite(door.width)||door.width<=0||door.offset-door.width/2<0||door.offset+door.width/2>1||!Number.isFinite(door.confidence)||door.confidence<0||door.confidence>1||door.verified!==false)throw new BoundaryError("موضع فتحة الباب المقدرة غير صالح.");
}
export function roomWalls(room:PlanRoom):Wall[]{return room.outline.flatMap((a,index)=>{const b=room.outline[(index+1)%room.outline.length];if(!room.openings.includes(index))return[{a,b}];const at=(t:number)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});return[{a,b:at(.38)},{a:at(.62),b}];});}

/** A doorway belongs to the shared wall, so its adjoining room cannot fill it. */
export function apartmentWalls(rooms:PlanRoom[]):Wall[]{
  const edges=rooms.flatMap(room=>room.outline.map((a,index)=>({a,b:room.outline[(index+1)%room.outline.length]})));
  const gaps=rooms.flatMap(room=>[...room.openings.map(index=>{
    const a=room.outline[index],b=room.outline[(index+1)%room.outline.length];
    const at=(t:number)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});return{a:at(.38),b:at(.62)};
  }),...(room.doorwayCandidates??[]).map(door=>{const a=room.outline[door.edge],b=room.outline[(door.edge+1)%room.outline.length];const at=(t:number)=>({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});return{a:at(door.offset-door.width/2),b:at(door.offset+door.width/2)};})]);
  const epsilon=1e-8;
  const walls=edges.flatMap(edge=>{
    const dx=edge.b.x-edge.a.x,dz=edge.b.z-edge.a.z,length=Math.hypot(dx,dz),squared=length*length;
    const cuts=gaps.flatMap(gap=>{
      if(Math.abs(cross(edge.a,edge.b,gap.a))>epsilon*length||Math.abs(cross(edge.a,edge.b,gap.b))>epsilon*length)return [];
      const project=(p:Wall["a"])=>(dx*(p.x-edge.a.x)+dz*(p.z-edge.a.z))/squared;
      const a=project(gap.a),b=project(gap.b),start=Math.max(0,Math.min(a,b)),end=Math.min(1,Math.max(a,b));
      return end-start>epsilon?[[start,end]]:[];
    }).sort((a,b)=>a[0]-b[0]);
    const at=(t:number)=>({x:edge.a.x+dx*t,z:edge.a.z+dz*t}),segments:Wall[]=[];let cursor=0;
    for(const [start,end] of cuts){if(start>cursor+epsilon)segments.push({a:at(cursor),b:at(start)});cursor=Math.max(cursor,end);}
    if(cursor<1-epsilon)segments.push({a:at(cursor),b:at(1)});
    return segments;
  });
  const key=(wall:Wall)=>{const a=wall.a.x.toFixed(8)+","+wall.a.z.toFixed(8),b=wall.b.x.toFixed(8)+","+wall.b.z.toFixed(8);return a<b?a+"/"+b:b+"/"+a;};
  return [...new Map(walls.map(wall=>[key(wall),wall])).values()];
}
export function planFromRooms(previous:Plan|undefined,rooms:PlanRoom[],floor:number):Plan{
  const names=new Set<string>();for(const room of rooms){validateRoom(room);if(names.has(room.id))throw new BoundaryError("معرّفات الغرف مكررة.");names.add(room.id);}
  const points=rooms.flatMap(room=>room.outline),xs=points.map(p=>p.x),zs=points.map(p=>p.z);
  return{floor,label:previous?.label??(floor===0?"الدور الأرضي":`الدور ${floor}`),kind:"geometry",bounds:{minX:Math.min(...xs),maxX:Math.max(...xs),minZ:Math.min(...zs),maxZ:Math.max(...zs)},walls:apartmentWalls(rooms),authoredRooms:rooms,authoredScale:previous&&(previous.kind==="geometry"||previous.kind==="depth")&&previous.authoredScale!=="relative"&&!previous.generatedFrom&&!previous.generatedRooms?.length?"metric":"relative"};
}
