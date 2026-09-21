import type {RoomKind,Scene} from "@/lib/imo3d/model";
export const unnamedRoom=(room:string)=>!room.trim()||room==="لقطات تحتاج تسمية";
export const roomIdentity=(scene:Scene)=>scene.floor+":"+(scene.roomSemantic?"semantic:"+scene.roomSemantic.groupId:unnamedRoom(scene.room)?"scene:"+scene.id:"legacy:"+scene.room);
export function captureLabel(scene:Scene,scenes:Scene[]){return unnamedRoom(scene.room)?"لقطة "+(scenes.findIndex(item=>item.id===scene.id)+1):scene.room;}
export const roomFunctionLabels:Record<RoomKind,string>={living:"المعيشة",guest:"الضيوف",dining:"الطعام",kitchen:"المطبخ",bedroom:"غرف النوم",bathroom:"الحمامات",entrance:"المدخل",corridor:"الممرات",balcony:"الشرفات",storage:"التخزين",unknown:"غير مصنّف"};
const functionOrder:RoomKind[]=["living","guest","dining","kitchen","bedroom","bathroom","entrance","corridor","balcony","storage","unknown"];
export type RoomChoice={id:string;name:string;scene:Scene;count:number;kind:RoomKind;needsReview:boolean};

/** Functions filter physical identities; they never merge different bedrooms. */
export function roomChoices(scenes:Scene[],floor:number,kind?:RoomKind):RoomChoice[]{
  const groups=new Map<string,Scene[]>();
  for(const scene of scenes){if(scene.floor!==floor)continue;const id=roomIdentity(scene);groups.set(id,[...(groups.get(id)??[]),scene]);}
  return [...groups].flatMap(([id,members])=>{
    const kinds=new Set(members.map(scene=>scene.roomSemantic?.kind??"unknown"));
    const functionKind:RoomKind=kinds.size===1?[...kinds][0]:"unknown";
    if(kind!==undefined&&functionKind!==kind)return[];
    const score=(scene:Scene)=>scene.roomSemantic?.observedKind===functionKind&&functionKind!=="unknown"?scene.roomSemantic.observedConfidence??0:0;
    // Sort a copy, preserving original scene order on ties and for legacy tours.
    const representative=members.find(scene=>scene.entryView)??[...members].sort((a,b)=>score(b)-score(a))[0];
    const named=members.find(scene=>scene.roomSemantic?.nameSource==="user")??members[0];
    return [{id,name:captureLabel(named,scenes),scene:representative,count:members.length,kind:functionKind,
      needsReview:kinds.size>1||members.some(scene=>scene.roomSemantic?.needsReview??false)}];
  });
}

export function roomFunctionCategories(scenes:Scene[],floor:number):{kind:RoomKind;label:string;count:number}[]{
  const choices=roomChoices(scenes,floor);
  return functionOrder.flatMap(kind=>{const count=choices.filter(choice=>choice.kind===kind).length;return count?[{kind,label:roomFunctionLabels[kind],count}]:[];});
}
