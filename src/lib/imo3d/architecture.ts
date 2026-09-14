import {z} from "zod";

const scalar=z.number().finite().min(-1e6).max(1e6);
const pointSchema=z.object({x:scalar,z:scalar}).strict();
const id=z.string().min(1).max(160);
const positive=z.number().finite().positive().max(1e5);
const confidence=z.number().min(0).max(1);
const source=z.enum(['observed','manual']);
export const architectureSchema=z.object({
  version:z.literal(1),floor:z.number().int().min(-100).max(1000),
  scale:z.object({status:z.enum(['estimated','calibrated']),metersPerUnit:positive.nullable(),displayUnit:z.enum(['mm','cm','m'])}).strict(),
  walls:z.array(z.object({id,a:pointSchema,b:pointSchema,thickness:positive.nullable(),height:positive.nullable(),kind:z.enum(['exterior','partition','structural']),confidence,source,evidenceIds:z.array(id).max(1000)}).strict()).max(2000),
  openings:z.array(z.object({id,wallId:id,kind:z.enum(['door','window','opening']),offset:z.number().finite().min(0).max(1e6),width:positive,height:positive.nullable(),sillHeight:z.number().finite().min(0).max(1e5).nullable(),hinge:z.enum(['start','end']).nullable(),swing:z.enum(['left','right']).nullable(),confidence,source}).strict()).max(4000),
  rooms:z.array(z.object({id,name:z.string().max(200),polygon:z.array(pointSchema).min(3).max(1000),wallIds:z.array(id).max(2000),cameraIds:z.array(id).max(10000),confidence}).strict()).max(1000),
  columns:z.array(z.object({id,polygon:z.array(pointSchema).min(3).max(100),height:positive.nullable(),confidence}).strict()).max(1000),
}).strict();
export type Architecture=z.infer<typeof architectureSchema>;
export type ArchitecturalWall=Architecture['walls'][number];
export type ArchitecturalOpening=Architecture['openings'][number];
export type ArchitecturalRoom=Architecture['rooms'][number];
export type ArchitecturalColumn=Architecture['columns'][number];
export type Point={x:number,z:number};
export type ArchitectureIssue={code:string,message:string,objectId?:string,severity:'error'|'warning'};
const EPS=1e-6;
const length=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.z-b.z);
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const same=(a:Point,b:Point)=>length(a,b)<EPS;
const onSegment=(p:Point,a:Point,b:Point)=>Math.abs(cross(a,b,p))<EPS&&p.x>=Math.min(a.x,b.x)-EPS&&p.x<=Math.max(a.x,b.x)+EPS&&p.z>=Math.min(a.z,b.z)-EPS&&p.z<=Math.max(a.z,b.z)+EPS;
function intersects(a:Point,b:Point,c:Point,d:Point){return (cross(a,b,c)*cross(a,b,d)<-EPS&&cross(c,d,a)*cross(c,d,b)<-EPS)||onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b);}
function signedArea(p:Point[]){return p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a.x*b.z-b.x*a.z;},0)/2;}
function invalidPolygon(p:Point[]){if(Math.abs(signedArea(p))<EPS)return true;for(let i=0;i<p.length;i++){if(same(p[i],p[(i+1)%p.length]))return true;for(let j=i+1;j<p.length;j++){if(j===i+1||(i===0&&j===p.length-1))continue;if(intersects(p[i],p[(i+1)%p.length],p[j],p[(j+1)%p.length]))return true;}}return false;}
function inside(p:Point,polygon:Point[]){let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if(onSegment(p,a,b))return true;if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)yes=!yes;}return yes;}
export function emptyArchitecture(floor:number):Architecture{return {version:1,floor,scale:{status:'estimated',metersPerUnit:null,displayUnit:'m'},walls:[],openings:[],rooms:[],columns:[]};}
export function wallPolygon(wall:ArchitecturalWall):Point[]{const l=length(wall.a,wall.b);if(l<EPS||wall.thickness===null)return [];const dx=-(wall.b.z-wall.a.z)/l*wall.thickness/2,dz=(wall.b.x-wall.a.x)/l*wall.thickness/2;return [{x:wall.a.x+dx,z:wall.a.z+dz},{x:wall.b.x+dx,z:wall.b.z+dz},{x:wall.b.x-dx,z:wall.b.z-dz},{x:wall.a.x-dx,z:wall.a.z-dz}];}
export function roomMetrics(room:ArchitecturalRoom){return {area:Math.abs(signedArea(room.polygon)),perimeter:room.polygon.reduce((s,a,i)=>s+length(a,room.polygon[(i+1)%room.polygon.length]),0)};}
export function formatArchitectureLength(value:number,scale:Architecture['scale']):string{if(!Number.isFinite(value)||scale.metersPerUnit===null)return 'غير معاير';const factor=scale.displayUnit==='mm'?1000:scale.displayUnit==='cm'?100:1;return `${scale.status==='estimated'?'≈ ':''}${Number((value*scale.metersPerUnit*factor).toFixed(scale.displayUnit==='m'?2:1))} ${scale.displayUnit}`;}
export function architectureIssues(model:Architecture,cameras?:{id:string,position:Point|null}[]):ArchitectureIssue[]{
 const issues:ArchitectureIssue[]=[];const add=(code:string,message:string,objectId?:string,severity:'error'|'warning'='error')=>issues.push({code,message,objectId,severity});
 if(!architectureSchema.safeParse(model).success){add('schema','Architectural data does not satisfy its bounded schema.');return issues;}
 if(model.scale.status==='calibrated'&&model.scale.metersPerUnit===null)add('scale','Calibrated geometry requires a positive metric scale.');
 if(model.scale.status==='estimated')add('uncalibrated','Dimensions are estimates until calibrated.',undefined,'warning');
 const ids=new Set<string>();for(const item of [...model.walls,...model.openings,...model.rooms,...model.columns]){if(ids.has(item.id))add('duplicate-id','Object IDs must be unique.',item.id);ids.add(item.id);}
 const walls=new Map(model.walls.map(w=>[w.id,w]));
 for(const w of model.walls){if(length(w.a,w.b)<EPS)add('degenerate-wall','Wall endpoints coincide.',w.id);if(w.thickness===null||w.height===null)add('unknown-dimensions','Wall thickness or height is unverified.',w.id,'warning');}
 for(let i=0;i<model.walls.length;i++)for(let j=i+1;j<model.walls.length;j++){const a=model.walls[i],b=model.walls[j];if(!intersects(a.a,a.b,b.a,b.b))continue;const shared=same(a.a,b.a)||same(a.a,b.b)||same(a.b,b.a)||same(a.b,b.b);const collinear=Math.abs(cross(a.a,a.b,b.a))<EPS&&Math.abs(cross(a.a,a.b,b.b))<EPS;const overlap=collinear&&((onSegment(b.a,a.a,a.b)&&!same(b.a,a.a)&&!same(b.a,a.b))||(onSegment(b.b,a.a,a.b)&&!same(b.b,a.a)&&!same(b.b,a.b))||(same(a.a,b.a)&&same(a.b,b.b))||(same(a.a,b.b)&&same(a.b,b.a))||(onSegment(a.a,b.a,b.b)&&!same(a.a,b.a)&&!same(a.a,b.b)));if(overlap)add('overlapping-walls','Wall centerlines overlap.',b.id);else if(!shared)add('unsplit-junction','Intersecting walls must be split at their junction.',b.id);}
 for(const o of model.openings){const w=walls.get(o.wallId);if(!w){add('missing-host','Opening requires an existing wall.',o.id);continue;}if(o.offset+o.width>length(w.a,w.b)+EPS)add('opening-bounds','Opening exceeds its host wall.',o.id);if(o.kind==='window'&&o.sillHeight===null)add('unknown-sill','Window sill height is unverified.',o.id,'warning');if(o.height!==null&&w.height!==null&&(o.sillHeight??0)+o.height>w.height+EPS)add('opening-height','Opening exceeds wall height.',o.id);}
 for(let i=0;i<model.openings.length;i++)for(let j=i+1;j<model.openings.length;j++){const a=model.openings[i],b=model.openings[j];if(a.wallId===b.wallId&&Math.min(a.offset+a.width,b.offset+b.width)-Math.max(a.offset,b.offset)>EPS)add('overlapping-openings','Openings overlap along the same wall.',b.id);}
 for(const r of model.rooms){if(invalidPolygon(r.polygon))add('invalid-room','Room boundary must be a simple, nondegenerate polygon.',r.id);for(const wallId of r.wallIds)if(!walls.has(wallId))add('missing-room-wall','Room references a missing wall.',r.id);for(const cameraId of r.cameraIds){const camera=cameras?.find(c=>c.id===cameraId);if(cameras&&!camera)add('missing-camera','Room references a missing camera.',r.id);else if(camera?.position&&!inside(camera.position,r.polygon))add('camera-room','Camera lies outside its assigned room.',cameraId);}}
 for(const c of model.columns)if(invalidPolygon(c.polygon))add('invalid-column','Column footprint must be a simple polygon.',c.id);
 for(const c of cameras??[]){if(!c.position)continue;if(model.rooms.length&&!model.rooms.some(r=>inside(c.position!,r.polygon)))add('camera-outside','Camera lies outside all room boundaries.',c.id,'warning');for(const w of model.walls){if(!inside(c.position,wallPolygon(w)))continue;const l=length(w.a,w.b);const offset=((c.position.x-w.a.x)*(w.b.x-w.a.x)+(c.position.z-w.a.z)*(w.b.z-w.a.z))/l;const passage=model.openings.some(o=>o.wallId===w.id&&o.kind!=='window'&&offset>=o.offset&&offset<=o.offset+o.width);if(!passage)add('camera-on-wall','Camera intersects a wall footprint.',c.id);}}
 for(const w of model.walls){
  if(w.source==='observed'&&!w.evidenceIds.length)add('missing-wall-evidence','الجدار المرصود غير مرتبط بأدلة من الصور.',w.id,'warning');
  if([w.a,w.b].some(p=>!model.walls.some(other=>other.id!==w.id&&(same(p,other.a)||same(p,other.b)))))add('dangling-wall','طرف جدار غير متصل؛ يجب مراجعة حدود الغرف.',w.id,'warning');
 }
 for(const c of cameras??[])if(c.position&&model.columns.some(column=>inside(c.position!,column.polygon)))add('camera-in-column','موضع الكاميرا يقع داخل عمود.',c.id);
 const arabic:Record<string,string>={schema:'البيانات المعمارية لا تطابق البنية والحدود المسموحة.',scale:'المقياس المعاير يحتاج قيمة موجبة للتحويل إلى المتر.',uncalibrated:'الأبعاد تقديرية حتى معايرة المقياس.','duplicate-id':'معرّفات العناصر يجب أن تكون فريدة.','degenerate-wall':'طرفا الجدار متطابقان.','unknown-dimensions':'سماكة الجدار أو ارتفاعه غير موثّق.','overlapping-walls':'محاور الجدران متداخلة.','unsplit-junction':'يجب تقسيم الجدران عند نقطة التقاطع.','missing-host':'الفتحة تحتاج جدارًا مضيفًا موجودًا.','opening-bounds':'الفتحة تتجاوز طول الجدار.','unknown-sill':'ارتفاع جلسة النافذة غير موثّق.','opening-height':'الفتحة تتجاوز ارتفاع الجدار.','overlapping-openings':'فتحات الجدار متداخلة.','invalid-room':'حدود الغرفة متقاطعة أو مساحتها غير صالحة.','missing-room-wall':'الغرفة تشير إلى جدار غير موجود.','missing-camera':'الغرفة تشير إلى كاميرا غير موجودة.','camera-room':'الكاميرا خارج الغرفة المعيّنة لها.','invalid-column':'حدود العمود متقاطعة أو غير صالحة.','camera-outside':'الكاميرا خارج حدود جميع الغرف؛ راجع موضعها.','camera-on-wall':'الكاميرا تتقاطع مع مساحة جدار.'};
 return issues.map(issue=>({...issue,message:arabic[issue.code]??issue.message}));
}
export function wallRuns(model:Architecture,wall:ArchitecturalWall):{a:Point,b:Point,bottom:number,top:number}[]{
 if(wall.height===null||wall.thickness===null||length(wall.a,wall.b)<EPS)return [];
 const l=length(wall.a,wall.b),openings=model.openings.filter(o=>o.wallId===wall.id).sort((a,b)=>a.offset-b.offset);
 if(openings.some((o,i)=>o.offset<0||o.offset+o.width>l+EPS||i>0&&o.offset<openings[i-1].offset+openings[i-1].width-EPS))return [];
 const p=(t:number)=>({x:wall.a.x+(wall.b.x-wall.a.x)*t/l,z:wall.a.z+(wall.b.z-wall.a.z)*t/l});const runs:{a:Point,b:Point,bottom:number,top:number}[]=[];
 const emit=(start:number,end:number,bottom:number,top:number)=>{if(end-start>EPS&&top-bottom>EPS)runs.push({a:p(start),b:p(end),bottom,top});};let cursor=0;
 for(const o of openings){emit(cursor,o.offset,0,wall.height);const sill=o.sillHeight??(o.kind==='window'?null:0);if(sill!==null&&o.height!==null&&sill+o.height<=wall.height+EPS){emit(o.offset,o.offset+o.width,0,sill);emit(o.offset,o.offset+o.width,sill+o.height,wall.height);}cursor=o.offset+o.width;}emit(cursor,l,0,wall.height);return runs;
}
/** Inset each face by the actual half thickness; reject collapsed or ambiguous geometry. */
function interiorFace(points:Point[],thicknesses:number[]):Point[]|null{
 const shifted=points.map((a,i)=>{const b=points[(i+1)%points.length],l=length(a,b),t=thicknesses[i]/2;return {a:{x:a.x-(b.z-a.z)/l*t,z:a.z+(b.x-a.x)/l*t},dx:b.x-a.x,dz:b.z-a.z};});
 const result:Point[]=[];
 for(let i=0;i<shifted.length;i++){const prev=shifted[(i+shifted.length-1)%shifted.length],next=shifted[i],det=prev.dx*next.dz-prev.dz*next.dx;
 if(Math.abs(det)<EPS){if(Math.abs(cross(prev.a,{x:prev.a.x+prev.dx,z:prev.a.z+prev.dz},next.a))>EPS)return null;result.push(next.a);continue;}
 const dx=next.a.x-prev.a.x,dz=next.a.z-prev.a.z,t=(dx*next.dz-dz*next.dx)/det;result.push({x:prev.a.x+t*prev.dx,z:prev.a.z+t*prev.dz});}
 if(invalidPolygon(result)||signedArea(result)<=EPS||Math.abs(signedArea(result))>=Math.abs(signedArea(points))||result.some(p=>!inside(p,points)))return null;
 if(result.some((p,i)=>{const q=result[(i+1)%result.length],a=points[i],b=points[(i+1)%points.length];return (q.x-p.x)*(b.x-a.x)+(q.z-p.z)*(b.z-a.z)<=EPS;}))return null;
 return result;
}
/** Enumerate bounded faces of an explicitly connected planar wall graph. Never infer geometry from cameras. */
export function deriveArchitecturalRooms(model:Architecture):ArchitecturalRoom[]{
 if(!model.walls.length||model.walls.some(w=>w.thickness===null)||architectureIssues({...model,rooms:[]}).some(i=>i.severity==='error'))return [];
 const vertices:Point[]=[];const vertex=(p:Point)=>{const i=vertices.findIndex(v=>same(v,p));if(i>=0)return i;vertices.push(p);return vertices.length-1;};
 const edges:modelEdge[]=[];type modelEdge={from:number,to:number,wall:ArchitecturalWall,twin:number};
 for(const wall of model.walls){const a=vertex(wall.a),b=vertex(wall.b),n=edges.length;edges.push({from:a,to:b,wall,twin:n+1},{from:b,to:a,wall,twin:n});}
 const outgoing=vertices.map((v,i)=>edges.map((e,j)=>({e,j})).filter(({e})=>e.from===i).sort((a,b)=>Math.atan2(vertices[a.e.to].z-v.z,vertices[a.e.to].x-v.x)-Math.atan2(vertices[b.e.to].z-v.z,vertices[b.e.to].x-v.x)).map(({j})=>j));
 const seen=new Set<number>(),rooms:ArchitecturalRoom[]=[];
 for(let first=0;first<edges.length;first++){if(seen.has(first))continue;let at=first;const face:number[]=[];while(!seen.has(at)){seen.add(at);face.push(at);const e=edges[at],list=outgoing[e.to],back=list.indexOf(e.twin);at=list[(back-1+list.length)%list.length];}if(at!==first)continue;const polygon=face.map(i=>vertices[edges[i].from]);if(signedArea(polygon)<=EPS||invalidPolygon(polygon))continue;const wallIds=face.map(i=>edges[i].wall.id);if(new Set(wallIds).size!==wallIds.length)continue;const interior=interiorFace(polygon,face.map(i=>edges[i].wall.thickness!));if(!interior)continue;rooms.push({id:`room-${rooms.length+1}`,name:`مساحة ${rooms.length+1}`,polygon:interior,wallIds,cameraIds:[],confidence:Math.min(...face.map(i=>edges[i].wall.confidence))});}
 if(rooms.some((r,i)=>rooms.some((other,j)=>i!==j&&r.polygon.every(p=>inside(p,other.polygon)))))return [];
 return rooms;
}

