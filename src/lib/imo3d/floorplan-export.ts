import type {Plan,PlanRoom,Scene,Wall} from "./model";
import {apartmentWalls,pointInRoom,validateRoom} from "./boundary-shapes";
import {floorPlanDoorways} from "../../components/imo3d/floorplan-doorways";

type Point={x:number;z:number};
type ExportInput={tourTitle:string;plan:Plan;scenes:readonly Scene[];brandingName?:string};
const finite=(point:Point)=>Number.isFinite(point.x)&&Number.isFinite(point.z);
const number=(value:number)=>String(Number(value.toFixed(6)));
// Remove characters XML 1.0 cannot encode before escaping every text attribute.
const xml=(value:string)=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[char]!);

function exportGeometry(plan:Plan):{rooms:PlanRoom[];walls:Wall[]}{
  if(plan.reviewStatus==="rejected")throw new Error("المخطط قيد المراجعة ولا يمكن تصديره.");
  const rooms=plan.authoredRooms??plan.generatedRooms??[];
  for(const room of rooms){
    if(room.outline.length<3||room.outline.some(point=>!finite(point)))throw new Error("حدود المخطط غير صالحة للتصدير.");
    validateRoom(room);
  }
  // Room outlines are authoritative, including shared-wall aperture cuts. A
  // raster floor-plan image or a camera path cannot become architectural walls.
  const walls=rooms.length?apartmentWalls(rooms):plan.walls;
  if(!walls.length||walls.some(wall=>!finite(wall.a)||!finite(wall.b))||!walls.some(wall=>Math.hypot(wall.a.x-wall.b.x,wall.a.z-wall.b.z)>1e-8))throw new Error("لا توجد حدود جدران قابلة للتصدير لهذا الطابق بعد.");
  return{rooms,walls};
}

export function canExportFloorPlanSvg(plan:Plan):boolean{
  try{exportGeometry(plan);return true;}catch{return false;}
}

export function floorPlanExportFilename(tourTitle:string,planLabel:string,extension:"svg"|"png"="svg"):string{
  const clean=(value:string)=>value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g," ").replace(/\s+/g," ").trim().replace(/[. ]+$/g,"").slice(0,70);
  return `IMO3D-${clean(tourTitle)||"tour"}-${clean(planLabel)||"floor"}.${extension}`;
}

function labelAnchor(room:PlanRoom):Point&{clearance:number}{
  const xs=room.outline.map(point=>point.x),zs=room.outline.map(point=>point.z),minX=Math.min(...xs),minZ=Math.min(...zs),width=Math.max(...xs)-minX,height=Math.max(...zs)-minZ;
  const clearance=(point:Point)=>Math.min(...room.outline.map((a,index)=>{
    const b=room.outline[(index+1)%room.outline.length],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.z-a.z)*dz)/(dx*dx+dz*dz||1)));
    return Math.hypot(point.x-a.x-dx*t,point.z-a.z-dz*t);
  }));
  const candidates=Array.from({length:625},(_,i)=>({x:minX+width*((i%25)+.5)/25,z:minZ+height*(Math.floor(i/25)+.5)/25})).filter(point=>pointInRoom(point,room.outline));
  const center={x:minX+width/2,z:minZ+height/2};if(pointInRoom(center,room.outline))candidates.push(center);
  const best=candidates.map(point=>({...point,clearance:clearance(point)})).sort((a,b)=>b.clearance-a.clearance)[0];
  if(best)return best;
  // A valid very thin polygon may evade the grid. An edge midpoint moved just
  // inside its adjacent triangle supplies a label without moving any geometry.
  for(let i=0;i<room.outline.length;i++){
    const a=room.outline[i],b=room.outline[(i+1)%room.outline.length],c=room.outline[(i+2)%room.outline.length];
    const point={x:(a.x+b.x+c.x)/3,z:(a.z+b.z+c.z)/3};
    if(pointInRoom(point,room.outline))return{...point,clearance:clearance(point)};
  }
  throw new Error("تعذر وضع تسمية داخل حدود الغرفة.");
}

function wrapText(text:string,limit:number):string[]{
  const lines:string[]=[];let line="";
  for(const word of text.trim().split(/\s+/)){
    if(line&&(line+" "+word).length>limit){lines.push(line);line=word;}else line+=(line?" ":"")+word;
  }
  if(line)lines.push(line);return lines.length?lines:[""];
}

/** Standalone, resource-free architectural sheet. Coordinates are preserved;
 * page fitting changes display scale only and never asserts metric dimensions. */
export function renderFloorPlanSvg({tourTitle,plan,scenes,brandingName="IMO 3D"}:ExportInput):string{
  const {rooms,walls}=exportGeometry(plan),points=[...walls.flatMap(wall=>[wall.a,wall.b]),...rooms.flatMap(room=>room.outline)];
  const minX=Math.min(...points.map(point=>point.x)),maxX=Math.max(...points.map(point=>point.x)),minZ=Math.min(...points.map(point=>point.z)),maxZ=Math.max(...points.map(point=>point.z));
  const spanX=maxX-minX,spanZ=maxZ-minZ;
  if(Math.max(spanX,spanZ)<1e-8)throw new Error("مساحة المخطط غير صالحة للتصدير.");
  const scale=1840/Math.max(spanX,spanZ),drawWidth=Math.max(1,spanX*scale),drawHeight=Math.max(1,spanZ*scale);
  const sheetWidth=Math.max(1100,drawWidth+160);
  const title=`${tourTitle} · ${plan.label}`,doorways=floorPlanDoorways(plan);
  const relative=!!plan.generatedFrom||!!plan.generatedRooms?.length||plan.authoredScale==="relative"||plan.kind==="estimated"||plan.kind==="path";
  const caption=relative?`مقياس نسبي · ليس بالمتر · ${plan.authoredRooms?"حدود محددة يدويًا":"الحدود المستنتجة تحتاج إلى مراجعة"}`:plan.authoredScale==="metric"?"إحداثيات معايرة بالمتر · مقياس الطباعة غير محدد":"دون أبعاد قياس · مقياس الطباعة غير محدد";
  const notes=[caption,...(doorways.some(door=>door.source==="estimated")?["العلامات الذهبية: أجزاء مرئية من فتحات مقدّرة؛ ليست قياسًا للعرض الكامل للباب."]:[]),...(doorways.some(door=>door.source==="manual")?["العلامات الداكنة: فتحات محددة يدويًا؛ اتجاه فتح الأبواب غير محدد."]:[]),...(!rooms.length?["تصدير خطوط الجدران المحفوظة؛ لا تتوفر حدود غرف مغلقة لهذا الطابق."]:[]),...(plan.image?["الصورة المرجعية غير مضمنة؛ يعرض الملف هندسة الجدران المحفوظة فقط."]:[])];
  const footerLines=notes.flatMap(note=>wrapText(note,Math.floor((sheetWidth-140)/(19*.62)))),footerHeight=Math.max(170,footerLines.length*29+65);
  const sheetHeight=Math.max(800,drawHeight+230+footerHeight),drawX=(sheetWidth-drawWidth)/2,drawY=190+(sheetHeight-230-footerHeight-drawHeight)/2;
  const size=2200/Math.max(sheetWidth,sheetHeight),width=Math.round(sheetWidth*size),height=Math.round(sheetHeight*size);
  const at=(point:Point)=>({x:drawX+(point.x-minX)*scale,y:drawY+(point.z-minZ)*scale});
  const text=(x:number,y:number,value:string,size:number,extra="")=>`<text x="${number(x)}" y="${number(y)}" font-size="${number(size)}" ${extra}>${xml(value)}</text>`;
  const wallPath=walls.map(wall=>`M${number(wall.a.x)} ${number(wall.a.z)}L${number(wall.b.x)} ${number(wall.b.z)}`).join("");
  const polygons=rooms.map(room=>`<path data-room-id="${xml(room.id)}" d="${room.outline.map((point,i)=>`${i?"L":"M"}${number(point.x)} ${number(point.z)}`).join("")}Z" fill="#fcfcfb"><title>${xml(room.name)}</title></path>`).join("");
  const labels=rooms.map(room=>{
    const name=plan.authoredRooms?room.name:scenes.find(scene=>scene.floor===plan.floor&&scene.roomSemantic?.groupId===room.id)?.room??room.name;
    const anchor=labelAnchor(room),position=at(anchor),clearance=anchor.clearance*scale;
    const choices=[12,16,22].map(limit=>{const lines=wrapText(name,limit);return{lines,font:Math.max(.1,Math.min(30,clearance*1.5/(Math.max(...lines.map(line=>line.length),1)*.62),clearance*1.5/(lines.length*1.3)))};});
    const {lines,font}=choices.sort((a,b)=>b.font-a.font||a.lines.length-b.lines.length)[0];
    return `<g data-label-room="${xml(room.id)}" data-anchor-x="${number(anchor.x)}" data-anchor-z="${number(anchor.z)}"><title>${xml(name)}</title>${lines.map((line,i)=>text(position.x,position.y+(i-(lines.length-1)/2)*font*1.3,line,font,'dominant-baseline="middle" font-weight="600"')).join("")}</g>`;
  }).join("");
  const symbols=doorways.map(door=>{
    const a=at(door.a),b=at(door.b),nx=-(b.y-a.y)/(door.length*scale),ny=(b.x-a.x)/(door.length*scale),estimated=door.source==="estimated";
    const description=estimated?"جزء مرئي من فتحة مقدّرة؛ لا يمثل العرض الكامل للباب":"فتحة محددة يدويًا؛ اتجاه الفتح غير محدد";
    return `<g data-door-source="${door.source}" fill="none" stroke="${estimated?"#a56a13":"#26372f"}" stroke-width="2"><title>${description}</title><path d="M${number(a.x-nx*5)} ${number(a.y-ny*5)}L${number(a.x+nx*5)} ${number(a.y+ny*5)}M${number(b.x-nx*5)} ${number(b.y-ny*5)}L${number(b.x+nx*5)} ${number(b.y+ny*5)}"/><path d="M${number(a.x)} ${number(a.y)}L${number(b.x)} ${number(b.y)}"${estimated?' stroke-dasharray="5 4"':' opacity=".45"'}/></g>`;
  }).join("");
  const titleLines=wrapText(title,56).slice(0,2),titleFont=Math.min(32,(sheetWidth-160)/(Math.max(...titleLines.map(line=>line.length),1)*.62));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${number(sheetWidth)} ${number(sheetHeight)}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="sheet-title sheet-description">
<title id="sheet-title">${xml(title)}</title><desc id="sheet-description">${xml(notes.join(" "))}</desc>
<rect width="100%" height="100%" fill="white"/><g font-family="Arial, sans-serif" fill="#182a22" text-anchor="middle" direction="rtl">
${text(sheetWidth/2,56,brandingName,Math.min(21,(sheetWidth-160)/(Math.max(1,brandingName.length)*.62)))}
${titleLines.map((line,i)=>text(sheetWidth/2,106+i*38,line,titleFont,'font-weight="700"')).join("")}
<path d="M60 165H${number(sheetWidth-60)}" fill="none" stroke="#d5ddd8"/>
<g transform="translate(${number(drawX)} ${number(drawY)}) scale(${number(scale)}) translate(${number(-minX)} ${number(-minZ)})">${polygons}<path data-layer="walls" d="${wallPath}" fill="none" stroke="#203129" stroke-width="${number(4/scale)}" stroke-linecap="butt" stroke-linejoin="miter"/></g>
${symbols}${labels}<path d="M60 ${number(sheetHeight-footerHeight)}H${number(sheetWidth-60)}" fill="none" stroke="#d5ddd8"/>
${footerLines.map((line,i)=>text(sheetWidth/2,sheetHeight-footerHeight+39+i*29,line,19,i===0?'font-weight="700"':"")).join("")}
</g></svg>`;
}
