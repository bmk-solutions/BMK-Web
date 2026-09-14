import type {Point,Tour,Wall} from "../../src/lib/imo3d/model";

// Entirely synthetic geometry: a rectangle and six invented camera positions.
// This fixture contains no apartment photos, addresses or production IDs.
const angle=Math.PI/6,scale=40;
export const syntheticPlanPoint=(point:{x:number;z:number})=>({x:180+scale*(Math.cos(angle)*point.x-Math.sin(angle)*point.z),y:50+scale*(Math.sin(angle)*point.x+Math.cos(angle)*point.z)});
const walls:Wall[]=[
  {a:{x:0,z:0},b:{x:8,z:0}},{a:{x:8,z:0},b:{x:8,z:6}},
  {a:{x:8,z:6},b:{x:0,z:6}},{a:{x:0,z:6},b:{x:0,z:0}},
];
export function syntheticTour():Tour {
  const positions:Point[]=[{x:1,y:1.6,z:1},{x:2,y:1.6,z:1},{x:6,y:1.6,z:1},{x:6,y:1.6,z:2},{x:2,y:1.6,z:4},{x:3,y:1.6,z:4}];
  const rooms=["الصالة","الصالة","المطبخ","المطبخ","غرفة النوم","غرفة النوم"];
  const scenes=positions.map((position,index)=>({id:`synthetic-${index}`,name:`Camera ${index}`,room:rooms[index],floor:0,image:`/api/imo3d/assets/synthetic-${index}.webp`,preview:`/api/imo3d/assets/synthetic-${index}.webp`,thumbnail:`/api/imo3d/assets/synthetic-${index}.webp`,sourceName:`synthetic-${index}.jpg`,position,yaw:0,links:positions.map((_,other)=>`synthetic-${other}`).filter(id=>id!==`synthetic-${index}`)}));
  return {id:"synthetic-tour",projectId:"synthetic-project",title:"Synthetic apartment",published:false,revision:0,createdAt:"2020-01-01T00:00:00.000Z",updatedAt:"2020-01-01T00:00:00.000Z",scenes,
    plans:[{floor:0,label:"Synthetic floor",kind:"geometry",image:"/api/imo3d/assets/synthetic-plan.svg",width:600,height:500,bounds:{minX:0,minZ:0,maxX:8,maxZ:6},walls:structuredClone(walls),scenePoints:Object.fromEntries(scenes.map(scene=>[scene.id,syntheticPlanPoint(scene.position)]))}],
    unit:{code:"",area:null,price:null,bedrooms:null,bathrooms:null},quality:{positioned:scenes.length,depthScenes:0,components:1,warnings:[]}};
}
