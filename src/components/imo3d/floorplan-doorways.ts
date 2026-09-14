import type {Plan} from "../../lib/imo3d/model";

type Point={x:number;z:number};
export type PlanDoorway={a:Point;b:Point;length:number;angle:number;source:"manual"|"estimated";confidence:number;roomIds:string[]};
const finite=(point:Point)=>Number.isFinite(point.x)&&Number.isFinite(point.z);

/** Only explicit saved aperture intervals become symbols; proximity never adds a door. */
export function floorPlanDoorways(plan:Plan):PlanDoorway[]{
  const raw:PlanDoorway[]=[];
  for(const room of plan.authoredRooms??plan.generatedRooms??[]){
    const intervals=[...room.openings.map(edge=>({edge,start:.38,end:.62,source:plan.authoredRooms?"manual" as const:"estimated" as const,confidence:plan.authoredRooms?1:plan.generatedFrom?.confidence??0})),...(room.doorwayCandidates??[]).map(door=>({edge:door.edge,start:door.offset-door.width/2,end:door.offset+door.width/2,source:"estimated" as const,confidence:door.confidence}))];
    for(const interval of intervals){
      if(!Number.isInteger(interval.edge)||interval.edge<0||interval.edge>=room.outline.length||!Number.isFinite(interval.start)||!Number.isFinite(interval.end)||interval.start<0||interval.end>1||interval.end<=interval.start||!Number.isFinite(interval.confidence))continue;
      const edgeA=room.outline[interval.edge],edgeB=room.outline[(interval.edge+1)%room.outline.length];if(!finite(edgeA)||!finite(edgeB))continue;
      const at=(t:number)=>({x:edgeA.x+(edgeB.x-edgeA.x)*t,z:edgeA.z+(edgeB.z-edgeA.z)*t});
      let a=at(interval.start),b=at(interval.end);if(a.x>b.x||a.x===b.x&&a.z>b.z)[a,b]=[b,a];
      const length=Math.hypot(b.x-a.x,b.z-a.z);if(length<1e-7)continue;
      raw.push({a,b,length,angle:-Math.atan2(b.z-a.z,b.x-a.x),source:interval.source,confidence:Math.max(0,Math.min(1,interval.confidence)),roomIds:[room.id]});
    }
  }
  // A shared doorway is stored on both room edges. Merge only collinear,
  // overlapping intervals, matching the gaps already cut by apartmentWalls.
  const result:PlanDoorway[]=[];
  for(const opening of raw){
    let merged=opening;
    for(let index=result.length-1;index>=0;index--){
      const other=result[index],dx=(merged.b.x-merged.a.x)/merged.length,dz=(merged.b.z-merged.a.z)/merged.length;
      const cross=(p:Point)=>Math.abs((p.x-merged.a.x)*dz-(p.z-merged.a.z)*dx),project=(p:Point)=>(p.x-merged.a.x)*dx+(p.z-merged.a.z)*dz;
      if(cross(other.a)>1e-7||cross(other.b)>1e-7)continue;
      const start=Math.min(project(other.a),project(other.b)),end=Math.max(project(other.a),project(other.b));if(start>merged.length+1e-7||end< -1e-7)continue;
      const from=Math.min(0,start),to=Math.max(merged.length,end);
      const manualCovers=merged.source==="manual"&&start>=-1e-7&&end<=merged.length+1e-7||other.source==="manual"&&start<=1e-7&&end>=merged.length-1e-7;
      const a={x:merged.a.x+dx*from,z:merged.a.z+dz*from},b={x:merged.a.x+dx*to,z:merged.a.z+dz*to};
      merged={a,b,length:to-from,angle:merged.angle,source:manualCovers?"manual":"estimated",confidence:manualCovers?1:Math.min(merged.confidence,other.confidence),roomIds:[...new Set([...merged.roomIds,...other.roomIds])]};result.splice(index,1);
    }
    result.push(merged);
  }
  return result;
}
