import {z} from "zod";
import {bathroomFixtureSchema,roomKindSchema,type RoomKind,type RoomSemantic,type Scene} from "./model.ts";

const evidenceId=z.string().trim().min(1).max(160);
const confidence=z.number().finite().min(0).max(1);
export const roomObservationSchema=z.object({
  id:evidenceId,sceneId:z.string().min(1).max(80),kind:roomKindSchema,confidence,
  evidence:z.array(z.string().trim().min(1).max(240)).min(1).max(32),model:z.string().max(160).optional(),
});
export const roomRelationSchema=z.object({
  id:evidenceId,fromId:z.string().min(1).max(80),toId:z.string().min(1).max(80),
  kind:z.enum(["same_room","doorway","visual_overlap"]),confidence,verified:z.boolean(),
  direct:z.boolean().optional(),privateToFrom:z.boolean().optional(),provisional:z.boolean().optional(),
});
export type RoomObservation=z.infer<typeof roomObservationSchema>;
export type RoomRelation=z.infer<typeof roomRelationSchema>;
export const roomSuiteObservationSchema=z.object({
  id:evidenceId,sceneId:z.string().min(1).max(80),yaw:z.number().finite().min(-360).max(360).optional(),
  yawConvention:z.literal("native_panorama_degrees").optional(),visibleFixtures:z.array(bathroomFixtureSchema).min(1).max(16),confidence,
  evidence:z.array(z.string().trim().min(1).max(240)).min(1).max(32),model:z.string().max(160).optional(),
  doorwayVerified:z.boolean().default(false),direct:z.boolean().default(false),privateToFrom:z.boolean().default(false),
  privacyConfidence:confidence.default(0),verified:z.boolean().default(false),
});
export type RoomSuiteObservation=z.input<typeof roomSuiteObservationSchema>;
export type RoomSemanticInput={observations:readonly RoomObservation[];relations:readonly RoomRelation[];suiteObservations?:readonly RoomSuiteObservation[]};
export type SemanticRoom=RoomSemantic&{id:string;floor:number;sceneIds:string[];name:string};
export type RoomSemanticResult={scenes:Scene[];rooms:SemanticRoom[];warnings:string[]};
export const initialRoomSemantic=(sceneId:string):RoomSemantic=>({groupId:"room-"+sceneId,kind:"unknown",confidence:0,nameSource:"automatic",suggestedName:"مساحة",needsReview:true,reviewFlags:["missing_visual_evidence","room_identity_unverified"],evidenceIds:[]});
const labels:Record<RoomKind,string>={bedroom:"غرفة النوم",bathroom:"دورة المياه",kitchen:"المطبخ",living:"غرفة المعيشة",guest:"مجلس الضيوف",dining:"غرفة الطعام",corridor:"الممر",entrance:"المدخل",balcony:"الشرفة",storage:"غرفة التخزين",unknown:"مساحة"};
const generic=(name:string)=>!name.trim()||name==="لقطات تحتاج تسمية";
const unique=(values:string[])=>[...new Set(values)].sort();
const sceneOrder=(a:Scene,b:Scene)=>a.floor-b.floor||a.id.localeCompare(b.id);
const nameOwner=(scene:Scene):RoomSemantic["nameSource"]=>scene.roomSemantic?.nameSource??(generic(scene.room)?"automatic":"legacy");
const principalRoom=(room:RoomSemantic)=>room.kind==="bedroom"&&(!!room.ensuiteBathroomGroupIds?.length||room.suggestedEnsuite?.status==="confirmed");
const masterBedroomLabel="غرفة نوم ماستر";
const proposedMasterRoom=(room:RoomSemantic)=>room.kind==="bedroom"&&room.suggestedEnsuite?.status==="suggested"&&room.suggestedEnsuite.confidence>=.6&&
  !!room.suggestedEnsuite.visibleFixtures.length&&!room.reviewFlags.includes("shared_bathroom_access");

/** Review-only names do not promote a visible bathroom into confirmed privacy evidence. */
export function masterRoomNameProposals(rooms:readonly SemanticRoom[]):Map<string,string>{
  const candidates=rooms.filter(room=>principalRoom(room)||proposedMasterRoom(room)).sort((a,b)=>a.floor-b.floor||
    ([...a.sceneIds].sort()[0]??a.id).localeCompare([...b.sceneIds].sort()[0]??b.id));
  return new Map(candidates.flatMap((room,index)=>{const name=masterBedroomLabel+(candidates.length>1?" "+(index+1):"");return proposedMasterRoom(room)&&room.name!==name?[[room.id,name]]:[];}));
}
const sameRoomEvidence=(relation:RoomRelation)=>relation.kind==="same_room"&&(relation.verified&&relation.confidence>=.85||!relation.verified&&relation.provisional===true&&relation.confidence>=.75);

/** Only evaluator-accepted relations on an active reciprocal edge may group rooms. */
function currentRelation(relation:RoomRelation,byId:Map<string,Scene>){
  const from=byId.get(relation.fromId),to=byId.get(relation.toId);
  return !!from&&!!to&&from.id!==to.id&&from.floor===to.floor&&from.links.includes(to.id)&&to.links.includes(from.id)&&
    !from.blockedLinks?.includes(to.id)&&!to.blockedLinks?.includes(from.id);
}

/**
 * Consumes visual evaluator output. Filenames, proximity, matching labels and
 * visual overlap are deliberately never evidence of room identity or privacy.
 */
export function applyRoomSemantics(scenes:readonly Scene[],input:RoomSemanticInput):RoomSemanticResult{
  const ordered=[...scenes].sort(sceneOrder),byId=new Map(ordered.map(scene=>[scene.id,scene]));
  if(byId.size!==scenes.length)throw new Error("معرّفات اللقطات مكررة.");
  const warnings:string[]=[],observations:RoomObservation[]=[],relations:RoomRelation[]=[],suiteObservations:z.output<typeof roomSuiteObservationSchema>[]=[];
  const observationIds=new Set<string>(),relationIds=new Set<string>();
  for(const raw of input.observations){const parsed=roomObservationSchema.safeParse(raw);if(!parsed.success||!byId.has(parsed.data.sceneId)||observationIds.has(parsed.data.id))continue;observationIds.add(parsed.data.id);observations.push(parsed.data);}
  for(const raw of input.relations){const parsed=roomRelationSchema.safeParse(raw);if(!parsed.success||relationIds.has(parsed.data.id)||!currentRelation(parsed.data,byId))continue;relationIds.add(parsed.data.id);relations.push(parsed.data);}
  const suiteIds=new Set<string>();for(const raw of input.suiteObservations??[]){const parsed=roomSuiteObservationSchema.safeParse(raw);if(!parsed.success||!byId.has(parsed.data.sceneId)||suiteIds.has(parsed.data.id))continue;suiteIds.add(parsed.data.id);suiteObservations.push(parsed.data);}
  const parents=new Map(ordered.map(scene=>[scene.id,scene.id]));
  const find=(id:string):string=>{const parent=parents.get(id)!;if(parent===id)return id;const root=find(parent);parents.set(id,root);return root;};
  const union=(a:string,b:string)=>{a=find(a);b=find(b);if(a!==b)parents.set(a<b?b:a,a<b?a:b);};
  for(const relation of relations)if(sameRoomEvidence(relation))union(relation.fromId,relation.toId);
  const groups=new Map<string,Scene[]>();for(const scene of ordered){const root=find(scene.id);groups.set(root,[...(groups.get(root)??[]),scene]);}
  // One prior identity belongs to its largest surviving component, so a split
  // never gives different physical rooms the same group ID.
  const priorOwners=new Map<string,{root:string;count:number}>();
  for(const [root,members] of groups){const counts=new Map<string,number>();for(const scene of members)if(scene.roomSemantic)counts.set(scene.roomSemantic.groupId,(counts.get(scene.roomSemantic.groupId)??0)+1);
    for(const [id,count] of counts){const previous=priorOwners.get(id);if(!previous||count>previous.count||count===previous.count&&root<previous.root)priorOwners.set(id,{root,count});}}
  const usedIds=new Set<string>(),groupByScene=new Map<string,string>();
  const rooms:SemanticRoom[]=[];
  for(const [root,members] of groups){
    const previous=[...priorOwners].filter(([,owner])=>owner.root===root).sort((a,b)=>b[1].count-a[1].count||a[0].localeCompare(b[0]));
    let id=previous.find(([id])=>!usedIds.has(id))?.[0]??"room-"+root;
    while(usedIds.has(id)||priorOwners.has(id)&&priorOwners.get(id)!.root!==root)id+="-split";usedIds.add(id);for(const scene of members)groupByScene.set(scene.id,id);
    const memberIds=new Set(members.map(scene=>scene.id)),flags:string[]=[],scores=new Map<RoomKind,number>(),support=new Map<RoomKind,number>(),evidence:string[]=[];
    for(const scene of members){
      const values=observations.filter(value=>value.sceneId===scene.id).sort((a,b)=>b.confidence-a.confidence||a.id.localeCompare(b.id));
      const best=values[0];if(!best||best.kind==="unknown")continue;
      const conflicting=values.find(value=>value.kind!==best.kind&&value.kind!=="unknown"&&value.confidence>=best.confidence-.15);
      if(conflicting){flags.push("conflicting_labels");continue;}
      scores.set(best.kind,(scores.get(best.kind)??0)+best.confidence);support.set(best.kind,(support.get(best.kind)??0)+1);evidence.push(best.id);
    }
    const ranked=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const top=ranked[0],second=ranked[1],count=top?support.get(top[0])!:0,average=top?top[1]/count:0;
    const conflict=!!second&&(second[1]>=top[1]*.55||average>=.8&&second[1]/support.get(second[0])!>=.8);
    // Blank-wall captures lower evidence coverage but are not votes against a
    // visible room function. Each camera contributes at most one observation.
    const score=conflict?0:average*(.75+.25*count/members.length);
    if(conflict)flags.push("conflicting_labels");
    const kind:RoomKind=score>=.5&&!conflict?ranked[0][0]:"unknown";
    if(!ranked.length)flags.push("missing_visual_evidence");else if(score<.8)flags.push("low_confidence");
    if(evidence.length<members.length)flags.push("partial_visual_evidence");
    const identity=relations.filter(relation=>sameRoomEvidence(relation)&&memberIds.has(relation.fromId)&&memberIds.has(relation.toId)),provisional=identity.some(relation=>!relation.verified);
    if(provisional)flags.push("room_identity_provisional");
    if(members.length===1)flags.push("room_identity_unverified");evidence.push(...identity.map(relation=>relation.id));
    const owned=members.filter(scene=>nameOwner(scene)!=="automatic"&&!generic(scene.room));
    const ownedNames=unique(owned.map(scene=>scene.room));if(ownedNames.length>1)flags.push("conflicting_user_names");
    const source:RoomSemantic["nameSource"]=owned.some(scene=>nameOwner(scene)==="user")?"user":owned.length?"legacy":"automatic";
    if(source==="legacy")flags.push("legacy_name_unverified");
    const userName=owned.find(scene=>nameOwner(scene)==="user")?.room;
    rooms.push({id,groupId:id,floor:members[0].floor,sceneIds:members.map(scene=>scene.id),kind,confidence:Math.min(score,provisional?.79:1,...identity.map(relation=>relation.confidence)),name:userName??ownedNames[0]??"",nameSource:source,suggestedName:"",needsReview:flags.length>0,reviewFlags:unique(flags),evidenceIds:unique(evidence)});
  }
  const roomById=new Map(rooms.map(room=>[room.id,room]));
  const doors=relations.filter(relation=>relation.kind==="doorway"&&relation.verified&&relation.direct&&relation.confidence>=.85);
  const bathroomAccess=new Map<string,Set<string>>();
  for(const relation of doors){const from=groupByScene.get(relation.fromId)!,to=groupByScene.get(relation.toId)!;if(from===to)continue;
    for(const [bath,other] of [[from,to],[to,from]])if(roomById.get(bath)?.kind==="bathroom"){const access=bathroomAccess.get(bath)??new Set<string>();access.add(other);bathroomAccess.set(bath,access);}}
  for(const relation of relations){
    const from=roomById.get(groupByScene.get(relation.fromId)!),to=roomById.get(groupByScene.get(relation.toId)!);
    if(!from||!to||from.id===to.id||from.kind!=="bedroom"||to.kind!=="bathroom")continue;
    if(relation.kind!=="doorway"||!relation.privateToFrom)continue;
    const accepted=doors.includes(relation)&&from.confidence>=.8&&to.confidence>=.8&&bathroomAccess.get(to.id)?.size===1;
    if(!accepted){from.reviewFlags.push(bathroomAccess.get(to.id)&&bathroomAccess.get(to.id)!.size>1?"shared_bathroom_access":"private_bathroom_unverified");continue;}
    from.ensuiteBathroomGroupIds=unique([...(from.ensuiteBathroomGroupIds??[]),to.id]);from.evidenceIds.push(relation.id);from.confidence=Math.min(from.confidence,to.confidence,relation.confidence);
  }
  // A separately captured bathroom is optional, but a visible fixture alone
  // cannot establish a private entrance. Keep that weaker evidence reviewable.
  for(const room of rooms){
    const candidates=suiteObservations.filter(value=>groupByScene.get(value.sceneId)===room.id);if(!candidates.length)continue;
    const shared=room.reviewFlags.includes("shared_bathroom_access")||candidates.some(value=>value.verified&&value.doorwayVerified&&value.direct&&!value.privateToFrom&&value.privacyConfidence>=.9);
    const accepted=(value:typeof candidates[number])=>!shared&&room.kind==="bedroom"&&room.confidence>=.8&&value.verified&&value.doorwayVerified&&value.direct&&value.privateToFrom&&value.privacyConfidence>=.9&&value.confidence>=.85;
    const best=[...candidates].sort((a,b)=>Number(accepted(b))-Number(accepted(a))||b.privacyConfidence-a.privacyConfidence||b.confidence-a.confidence||a.id.localeCompare(b.id))[0];
    const confirmed=accepted(best);
    room.suggestedEnsuite={status:confirmed?"confirmed":"suggested",confidence:best.confidence,privacyConfidence:best.privacyConfidence,
      doorwayVerified:best.doorwayVerified,direct:best.direct,privateToFrom:best.privateToFrom,evidenceIds:[best.id],visibleFixtures:[...new Set(best.visibleFixtures)],sceneIds:[best.sceneId]};
    room.evidenceIds.push(best.id);
    if(!confirmed)room.reviewFlags.push(shared?"shared_bathroom_access":"visible_bathroom_requires_review");
    else room.confidence=Math.min(room.confidence,best.confidence,best.privacyConfidence);
  }
  const buckets=new Map<string,SemanticRoom[]>();
  for(const room of rooms){const base=principalRoom(room)?masterBedroomLabel:labels[room.kind];buckets.set(base,[...(buckets.get(base)??[]),room]);}
  for(const [base,members] of buckets)members.forEach((room,index)=>{room.suggestedName=base+(members.length>1||room.kind==="unknown"?" "+(index+1):"");if(room.nameSource==="automatic")room.name=room.suggestedName;room.reviewFlags=unique(room.reviewFlags);room.needsReview=room.reviewFlags.length>0;room.evidenceIds=unique(room.evidenceIds).slice(0,1000);});
  if(!observations.length&&scenes.length)warnings.push("لم تتوفر أدلة بصرية لتسمية الغرف؛ لكل مساحة غير مؤكدة اسم مستقل للمراجعة.");
  if(rooms.some(room=>room.needsReview))warnings.push("تحتاج بعض أسماء الغرف أو مجموعات الصور إلى مراجعتك.");
  const next=scenes.map(scene=>{
    const room=roomById.get(groupByScene.get(scene.id)!)!;
    const preserve=nameOwner(scene)!=="automatic"&&!generic(scene.room);
    const name=preserve?scene.room:room.name;
    // Preserve camera-local evidence separately from the group's inferred
    // function. A doorway capture must not inherit an interior view's score
    // when the viewer chooses a representative image for this room.
    const local=observations.filter(value=>value.sceneId===scene.id).sort((a,b)=>b.confidence-a.confidence||a.id.localeCompare(b.id));
    const best=local[0],conflicting=best&&local.some(value=>value.kind!==best.kind&&value.kind!=="unknown"&&value.confidence>=best.confidence-.15);
    const observedKind=best&&!conflicting?best.kind:"unknown",observedConfidence=best&&!conflicting?best.confidence:0;
    const roomSemantic:RoomSemantic={groupId:room.id,kind:room.kind,confidence:room.confidence,nameSource:preserve?nameOwner(scene):room.nameSource,
      observedKind,observedConfidence,
      suggestedName:room.suggestedName,needsReview:room.needsReview,reviewFlags:room.reviewFlags,evidenceIds:room.evidenceIds,
      ...(room.ensuiteBathroomGroupIds?{ensuiteBathroomGroupIds:room.ensuiteBathroomGroupIds}:{}),...(room.suggestedEnsuite?{suggestedEnsuite:room.suggestedEnsuite}:{})};
    return{...scene,room:name,name:preserve?scene.name:name,roomSemantic};
  });
  return{scenes:next,rooms,warnings};
}

/** A group rename records user ownership on every capture, surviving reanalysis. */
export function renameSemanticRoom(scenes:readonly Scene[],groupId:string,name:string):Scene[]{
  name=name.trim();if(!name||name.length>100)throw new Error("اسم الغرفة يجب أن يحتوي من حرف إلى 100 حرف.");
  const members=scenes.filter(scene=>scene.roomSemantic?.groupId===groupId);if(!members.length)throw new Error("مجموعة الغرفة غير موجودة. أعد تحميل الجولة.");
  return scenes.map(scene=>scene.roomSemantic?.groupId===groupId?{...scene,room:name,name,roomSemantic:{...scene.roomSemantic,nameSource:"user" as const,
    reviewFlags:scene.roomSemantic.reviewFlags.filter(flag=>flag!=="legacy_name_unverified"&&flag!=="conflicting_user_names"),
    needsReview:scene.roomSemantic.reviewFlags.some(flag=>flag!=="legacy_name_unverified"&&flag!=="conflicting_user_names")}}:scene);
}

/** Existing per-image name edits also need explicit ownership before processing. */
export function markRoomNameAsUser(scene:Scene):Scene{
  return{...scene,roomSemantic:scene.roomSemantic?{...scene.roomSemantic,nameSource:"user"}:{groupId:"room-"+scene.id,kind:"unknown",confidence:0,nameSource:"user",suggestedName:"مساحة",needsReview:true,reviewFlags:["missing_visual_evidence","room_identity_unverified"],evidenceIds:[]}};
}

export function semanticRooms(scenes:readonly Scene[]):SemanticRoom[]{
  const groups=new Map<string,SemanticRoom>();
  for(const scene of [...scenes].sort(sceneOrder)){
    const semantic=scene.roomSemantic;if(!semantic)continue;
    const existing=groups.get(semantic.groupId);
    if(existing){existing.sceneIds.push(scene.id);if(scene.room!==existing.name){existing.reviewFlags=unique([...existing.reviewFlags,"conflicting_user_names"]);existing.needsReview=true;}}
    else groups.set(semantic.groupId,{...semantic,id:semantic.groupId,name:scene.room,floor:scene.floor,sceneIds:[scene.id],reviewFlags:[...semantic.reviewFlags]});
  }
  return [...groups.values()];
}

/** Floor edits and deletion must not leave cross-floor groups or missing suites. */
export function reconcileRoomMembership(scenes:readonly Scene[]):Scene[]{
  const floors=new Map<string,Set<number>>();
  for(const scene of scenes)if(scene.roomSemantic){const values=floors.get(scene.roomSemantic.groupId)??new Set<number>();values.add(scene.floor);floors.set(scene.roomSemantic.groupId,values);}
  let next=scenes.map(scene=>{
    const semantic=scene.roomSemantic;if(!semantic||floors.get(semantic.groupId)!.size<2)return scene;
    return{...scene,roomSemantic:{...semantic,groupId:semantic.groupId.slice(0,140)+"@floor"+scene.floor,needsReview:true,reviewFlags:unique([...semantic.reviewFlags,"room_floor_changed"])}};
  });
  const groups=new Map(next.filter(scene=>scene.roomSemantic).map(scene=>[scene.roomSemantic!.groupId,{floor:scene.floor,kind:scene.roomSemantic!.kind}]));
  let removedSuite=false;
  const remaining=new Map(next.map(scene=>[scene.id,scene]));
  next=next.map(scene=>{
    const semantic=scene.roomSemantic,suite=semantic?.suggestedEnsuite;if(!semantic||!suite)return scene;
    const sourceIds=suite.sceneIds.filter(id=>{const source=remaining.get(id);return source?.floor===scene.floor&&source.roomSemantic?.groupId===semantic.groupId;});
    if(sourceIds.length===suite.sceneIds.length)return scene;
    removedSuite=true;
    return{...scene,roomSemantic:{...semantic,suggestedEnsuite:sourceIds.length?{...suite,sceneIds:sourceIds,status:"suggested" as const}:undefined,
      needsReview:true,reviewFlags:unique([...semantic.reviewFlags,"visible_bathroom_evidence_changed"])}};
  });
  next=next.map(scene=>{
    const semantic=scene.roomSemantic;if(!semantic?.ensuiteBathroomGroupIds?.length)return scene;
    const kept=semantic.ensuiteBathroomGroupIds.filter(id=>groups.get(id)?.floor===scene.floor&&groups.get(id)?.kind==="bathroom");
    if(kept.length===semantic.ensuiteBathroomGroupIds.length)return scene;
    removedSuite=true;
    return{...scene,roomSemantic:{...semantic,ensuiteBathroomGroupIds:kept.length?kept:undefined,needsReview:true,reviewFlags:unique([...semantic.reviewFlags,"private_bathroom_unverified"])}};
  });
  if(!removedSuite&&![...floors.values()].some(values=>values.size>1))return next;
  const names=new Map<string,string>(),buckets=new Map<string,string[]>();
  for(const scene of [...next].sort(sceneOrder))if(scene.roomSemantic){const semantic=scene.roomSemantic,base=principalRoom(semantic)?masterBedroomLabel:labels[semantic.kind];const ids=buckets.get(base)??[];if(!ids.includes(semantic.groupId))ids.push(semantic.groupId);buckets.set(base,ids);}
  for(const [base,ids] of buckets)ids.forEach((id,index)=>names.set(id,base+(ids.length>1||base===labels.unknown?" "+(index+1):"")));
  return next.map(scene=>{const semantic=scene.roomSemantic;if(!semantic)return scene;const name=names.get(semantic.groupId)!;return{...scene,...(semantic.nameSource==="automatic"?{room:name,name}:{}),roomSemantic:{...semantic,suggestedName:name}};});
}
