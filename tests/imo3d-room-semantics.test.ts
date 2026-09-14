import test from "node:test";
import assert from "node:assert/strict";
import {roomSemanticSchema,type RoomKind,type Scene} from "../src/lib/imo3d/model";
import {applyRoomSemantics,masterRoomNameProposals,reconcileRoomMembership,renameSemanticRoom,roomSuiteObservationSchema,type RoomObservation,type RoomRelation,type RoomSuiteObservation} from "../src/lib/imo3d/room-semantics";
import {roomChoices,roomFunctionCategories} from "../src/components/imo3d/room-labels";
const scene=(id:string,floor=0):Scene=>({id,floor,name:"لقطات تحتاج تسمية",room:"لقطات تحتاج تسمية",sourceName:"master-bedroom-kitchen.jpg",image:"/api/imo3d/assets/"+id,preview:"/api/imo3d/assets/"+id,thumbnail:"/api/imo3d/assets/"+id,position:null,yaw:0,links:[]});
const observation=(sceneId:string,kind:RoomKind,confidence=.95):RoomObservation=>({id:"observation-"+sceneId,sceneId,kind,confidence,evidence:["structured visual evaluator finding"],model:"fixture"});
const relation=(fromId:string,toId:string,kind:RoomRelation["kind"]="same_room",extra:Partial<RoomRelation>={}):RoomRelation=>({id:fromId+"-"+toId+"-"+kind,fromId,toId,kind,confidence:.95,verified:true,...extra});
function linked(ids:string[],edges:[string,string][]):Scene[]{return ids.map(id=>({...scene(id),links:edges.flatMap(([a,b])=>a===id?[b]:b===id?[a]:[])}));}
const suite=(sceneId:string,extra:Partial<RoomSuiteObservation>={}):RoomSuiteObservation=>({id:"suite-"+sceneId,sceneId,yaw:90,yawConvention:"native_panorama_degrees",visibleFixtures:["toilet","shower"],confidence:.95,evidence:["Visible bathroom beyond the bedroom doorway"],...extra});
const confirmedSuite=(sceneId:string,extra:Partial<RoomSuiteObservation>={})=>suite(sceneId,{verified:true,doorwayVerified:true,direct:true,privateToFrom:true,privacyConfidence:.96,...extra});

test("functional room filters preserve separate identities and all user-assigned names",()=>{
  const input=[scene("bed-a"),scene("bed-b"),scene("guest"),scene("dining"),scene("upstairs",1)];
  const evidence={observations:input.map(value=>observation(value.id,value.id==="guest"?"guest":value.id==="dining"?"dining":"bedroom")),relations:[]};
  const processed=applyRoomSemantics(input,evidence),named=renameSemanticRoom(processed.scenes,processed.scenes[0].roomSemantic!.groupId,"غرفة نوم ماستر خاصة");
  const before=structuredClone(named),choices=roomChoices(named,0,"bedroom");
  assert.equal(choices.length,2);assert.notEqual(choices[0].id,choices[1].id);
  assert.equal(choices[0].name,"غرفة نوم ماستر خاصة");
  assert.deepEqual(roomFunctionCategories(named,0).map(({kind,count})=>({kind,count})),[{kind:"guest",count:1},{kind:"dining",count:1},{kind:"bedroom",count:2}]);
  assert.equal(roomChoices(named,0,"living").length,0);assert.deepEqual(named,before);
});

test("room entry chooses the strongest local functional view instead of a doorway capture",()=>{
  const input=linked(["doorway","interior","blank"],[["doorway","interior"],["interior","blank"]]);
  const processed=applyRoomSemantics(input,{observations:[observation("doorway","living",.55),observation("interior","living",.95),observation("blank","unknown",.25)],relations:[relation("doorway","interior"),relation("interior","blank")]});
  const choice=roomChoices(processed.scenes,0,"living")[0];
  assert.equal(choice.scene.id,"interior");assert.equal(choice.count,3);
  assert.equal(processed.scenes[0].roomSemantic?.observedConfidence,.55);
  assert.equal(processed.scenes[1].roomSemantic?.observedConfidence,.95);
  assert.equal(processed.scenes[2].roomSemantic?.observedKind,"unknown");
  assert.ok(processed.scenes.every(value=>roomSemanticSchema.safeParse(value.roomSemantic).success));
});

test("conflicting local evidence cannot win a functional room representative selection",()=>{
  const input=linked(["conflict","interior"],[["conflict","interior"]]);
  const processed=applyRoomSemantics(input,{observations:[observation("conflict","living",.96),{...observation("conflict","bedroom",.94),id:"other-evaluator"},observation("interior","living",.85)],relations:[relation("conflict","interior")]});
  assert.equal(processed.scenes[0].roomSemantic?.observedKind,"unknown");assert.equal(processed.scenes[0].roomSemantic?.observedConfidence,0);
  assert.equal(roomChoices(processed.scenes,0)[0].scene.id,"interior");
});

test("legacy or inconsistent semantic groups remain reviewable without guessed functions",()=>{
  const legacy=[{...scene("legacy"),room:"المجلس الذي اخترته",name:"اسمي",roomSemantic:undefined}];
  assert.equal(roomChoices(legacy,0)[0].name,"المجلس الذي اخترته");assert.equal(roomChoices(legacy,0)[0].scene.id,"legacy");
  assert.deepEqual(roomFunctionCategories(legacy,0),[{kind:"unknown",label:"غير مصنّف",count:1}]);
  const prepared=applyRoomSemantics(linked(["a","b"],[["a","b"]]),{observations:[observation("a","living"),observation("b","living")],relations:[relation("a","b")]});
  prepared.scenes[1].roomSemantic!.kind="dining";
  const choice=roomChoices(prepared.scenes,0)[0];assert.equal(choice.kind,"unknown");assert.ok(choice.needsReview);
  assert.equal(roomChoices(prepared.scenes,0,"living").length,0);
});

test("reviewable master names are numbered without confirming privacy or changing saved names",()=>{
  const input=[scene("a"),scene("b")],evidence={observations:input.map(value=>observation(value.id,"bedroom")),relations:[],suiteObservations:[suite("a"),suite("b")]};
  const before=structuredClone(input),result=applyRoomSemantics(input,evidence);
  assert.deepEqual(result.rooms.map(room=>room.name),["غرفة النوم 1","غرفة النوم 2"]);
  assert.deepEqual([...masterRoomNameProposals([...result.rooms].reverse()).values()],["غرفة نوم ماستر 1","غرفة نوم ماستر 2"]);
  assert.ok(result.rooms.every(room=>room.suggestedEnsuite?.status==="suggested"&&room.suggestedEnsuite.privateToFrom===false));
  assert.deepEqual(input,before);
  const proposed=masterRoomNameProposals(result.rooms).get(result.rooms[0].id)!;
  const renamed=renameSemanticRoom(result.scenes,result.rooms[0].id,proposed),again=applyRoomSemantics(renamed,evidence);
  assert.equal(again.scenes[0].room,"غرفة نوم ماستر 1");assert.equal(again.scenes[0].roomSemantic?.nameSource,"user");
  assert.equal(again.scenes[0].roomSemantic?.suggestedEnsuite?.status,"suggested");assert.ok(again.scenes[0].roomSemantic?.needsReview);
  assert.equal(masterRoomNameProposals(again.rooms).has(again.rooms[0].id),false);
});

test("one proposed master name is unnumbered and shared or non-bedroom fixtures are excluded",()=>{
  const input=[scene("bed"),scene("hall")],result=applyRoomSemantics(input,{observations:[observation("bed","bedroom"),observation("hall","corridor")],relations:[],suiteObservations:[suite("bed"),suite("hall")]});
  const proposals=masterRoomNameProposals(result.rooms);assert.equal(proposals.size,1);assert.equal([...proposals.values()][0],"غرفة نوم ماستر");
  const shared=result.rooms.map(room=>({...room,reviewFlags:[...room.reviewFlags,"shared_bathroom_access"]}));assert.equal(masterRoomNameProposals(shared).size,0);
});

test("confirmed master numbering is stable across floors and does not number ordinary bedrooms as masters",()=>{
  const input=[scene("upstairs",1),scene("ordinary"),scene("downstairs")],observations=input.map(value=>observation(value.id,"bedroom"));
  const result=applyRoomSemantics(input,{observations,relations:[],suiteObservations:[confirmedSuite("upstairs"),confirmedSuite("downstairs")]});
  assert.equal(result.scenes.find(value=>value.id==="downstairs")?.room,"غرفة نوم ماستر 1");
  assert.equal(result.scenes.find(value=>value.id==="upstairs")?.room,"غرفة نوم ماستر 2");
  assert.equal(result.scenes.find(value=>value.id==="ordinary")?.room,"غرفة النوم");
  assert.equal(masterRoomNameProposals(result.rooms).size,0);
});

test("filenames and nearby coordinates cannot name or combine rooms without visual evidence",()=>{
  const input=[{...scene("a"),position:{x:0,y:0,z:0}},{...scene("b"),position:{x:.1,y:0,z:0}}];
  const result=applyRoomSemantics(input,{observations:[],relations:[]});
  assert.deepEqual(result.rooms.map(room=>room.kind),["unknown","unknown"]);
  assert.deepEqual(result.scenes.map(scene=>scene.room),["مساحة 1","مساحة 2"]);
  assert.equal(new Set(result.rooms.map(room=>room.id)).size,2);
  assert.ok(result.rooms.every(room=>room.needsReview&&room.confidence===0));
  assert.ok(result.rooms.every(room=>roomSemanticSchema.safeParse(room).success));
});

test("kitchen, living, guest and dining labels remain distinct, with separate bedrooms numbered",()=>{
  const kinds:RoomKind[]=["kitchen","living","guest","dining","bedroom","bedroom"];
  const input=kinds.map((_,index)=>scene("scene-"+index));
  const result=applyRoomSemantics(input,{observations:input.map((scene,index)=>observation(scene.id,kinds[index])),relations:[]});
  assert.deepEqual(result.scenes.map(scene=>scene.room),["المطبخ","غرفة المعيشة","مجلس الضيوف","غرفة الطعام","غرفة النوم 1","غرفة النوم 2"]);
});

test("room grouping requires explicit verified same-room evidence and current reciprocal adjacency",()=>{
  const input=linked(["a","b","c","d"],[["a","b"],["b","c"],["c","d"]]);
  const result=applyRoomSemantics(input,{observations:input.map(scene=>observation(scene.id,"bedroom")),relations:[relation("a","b"),relation("b","c","visual_overlap"),relation("c","d","same_room",{verified:false})]});
  assert.equal(result.rooms.length,3);
  assert.equal(result.scenes[0].roomSemantic?.groupId,result.scenes[1].roomSemantic?.groupId);
  assert.notEqual(result.scenes[1].roomSemantic?.groupId,result.scenes[2].roomSemantic?.groupId);
  assert.notEqual(result.scenes[2].roomSemantic?.groupId,result.scenes[3].roomSemantic?.groupId);
  const unreciprocal=structuredClone(input);unreciprocal[1].links=[];
  assert.equal(applyRoomSemantics(unreciprocal,{observations:[],relations:[relation("a","b")]}).rooms.length,4);
});

test("cross-floor and explicitly blocked relations cannot establish a shared room",()=>{
  for(const change of [{floor:1},{blockedLinks:["a"]}]){
    const input=linked(["a","b"],[["a","b"]]);input[1]={...input[1],...change};
    const result=applyRoomSemantics(input,{observations:[],relations:[relation("a","b")]});
    assert.equal(result.rooms.length,2);
  }
});

test("explicit provisional geometric membership groups a reviewed room without asserting identity or private suites",()=>{
  const input=linked(["a","b","c","d"],[["a","b"],["b","c"],["c","d"]]),observations=input.map(scene=>observation(scene.id,"bedroom"));
  const result=applyRoomSemantics(input,{observations,relations:[relation("a","b"),relation("b","c","same_room",{verified:false,provisional:true,confidence:.9}),relation("c","d","same_room",{verified:false,confidence:.99})],suiteObservations:[confirmedSuite("a")]});
  assert.equal(result.rooms.length,2);assert.equal(result.scenes[0].roomSemantic?.groupId,result.scenes[2].roomSemantic?.groupId);assert.notEqual(result.scenes[2].roomSemantic?.groupId,result.scenes[3].roomSemantic?.groupId);
  const provisional=result.rooms.find(room=>room.sceneIds.includes("a"))!;assert.equal(provisional.confidence,.79);assert.ok(provisional.reviewFlags.includes("room_identity_provisional"));assert.ok(provisional.needsReview);assert.equal(provisional.suggestedEnsuite?.status,"suggested");assert.ok(!provisional.name.includes("ماستر"));
  for(const extra of [{verified:false,confidence:.99},{verified:false,provisional:true,confidence:.74},{verified:true,provisional:true,confidence:.8}]){
    assert.equal(applyRoomSemantics(input.slice(0,2),{observations:observations.slice(0,2),relations:[relation("a","b","same_room",extra)]}).rooms.length,2);
  }
  for(const changed of [{...input[1],floor:1},{...input[1],blockedLinks:["a"]}])assert.equal(applyRoomSemantics([input[0],changed],{observations:[],relations:[relation("a","b","same_room",{verified:false,provisional:true,confidence:.9})]}).rooms.length,2);
});

test("conflicting visual classifications are flagged instead of becoming a confident room label",()=>{
  const input=linked(["a","b"],[["a","b"]]);
  const result=applyRoomSemantics(input,{observations:[observation("a","bedroom"),observation("b","bathroom")],relations:[relation("a","b")]});
  assert.equal(result.rooms[0].kind,"unknown");
  assert.ok(result.rooms[0].reviewFlags.includes("conflicting_labels"));
  assert.ok(result.rooms[0].needsReview);
});

test("only a verified direct private bathroom relation creates a principal bedroom",()=>{
  const input=linked(["bed","bath"],[["bed","bath"]]),observations=[observation("bed","bedroom"),observation("bath","bathroom")];
  for(const extra of [{},{direct:true},{direct:true,privateToFrom:true,verified:false},{direct:true,privateToFrom:true,confidence:.6}]){
    const result=applyRoomSemantics(input,{observations,relations:[relation("bed","bath","doorway",extra)]});
    assert.equal(result.scenes.find(scene=>scene.id==="bed")?.room,"غرفة النوم");
  }
  const result=applyRoomSemantics(input,{observations,relations:[relation("bed","bath","doorway",{direct:true,privateToFrom:true})]});
  assert.equal(result.scenes.find(scene=>scene.id==="bed")?.room,"غرفة نوم ماستر");
  assert.equal(result.rooms.find(room=>room.kind==="bedroom")?.ensuiteBathroomGroupIds?.length,1);
});

test("a shared hall or second bedroom access prevents the principal-bedroom claim",()=>{
  const input=linked(["bed","bath","hall"],[["bed","bath"],["bath","hall"]]);
  const result=applyRoomSemantics(input,{observations:[observation("bed","bedroom"),observation("bath","bathroom"),observation("hall","corridor")],relations:[relation("bed","bath","doorway",{direct:true,privateToFrom:true}),relation("bath","hall","doorway",{direct:true})]});
  const bedroom=result.rooms.find(room=>room.kind==="bedroom")!;
  assert.equal(bedroom.name,"غرفة النوم");assert.equal(bedroom.ensuiteBathroomGroupIds,undefined);
  assert.ok(bedroom.reviewFlags.includes("shared_bathroom_access"));
});

test("two independently evidenced suites receive stable principal-bedroom numbers",()=>{
  const input=linked(["bed-a","bath-a","bed-b","bath-b"],[["bed-a","bath-a"],["bed-b","bath-b"]]);
  const observations=input.map(scene=>observation(scene.id,scene.id.startsWith("bed")?"bedroom":"bathroom"));
  const relations=[relation("bed-a","bath-a","doorway",{direct:true,privateToFrom:true}),relation("bed-b","bath-b","doorway",{direct:true,privateToFrom:true})];
  const result=applyRoomSemantics(input,{observations,relations});
  assert.deepEqual(result.rooms.filter(room=>room.kind==="bedroom").map(room=>room.name),["غرفة نوم ماستر 1","غرفة نوم ماستر 2"]);
  const again=applyRoomSemantics([...result.scenes].reverse(),{observations:[...observations].reverse(),relations:[...relations].reverse()});
  assert.deepEqual(again.rooms,result.rooms);
});

test("a group rename keeps user ownership through later classification and preserves unrelated rooms",()=>{
  const input=linked(["a","b","c"],[["a","b"]]),relations=[relation("a","b")];
  const first=applyRoomSemantics(input,{observations:input.map(scene=>observation(scene.id,"bedroom")),relations});
  const group=first.scenes[0].roomSemantic!.groupId,renamed=renameSemanticRoom(first.scenes,group,"غرفة العائلة");
  assert.deepEqual(renamed.slice(0,2).map(scene=>[scene.room,scene.roomSemantic?.nameSource]),[["غرفة العائلة","user"],["غرفة العائلة","user"]]);
  assert.deepEqual(renamed[2],first.scenes[2]);
  const second=applyRoomSemantics(renamed,{observations:input.map(scene=>observation(scene.id,"living")),relations});
  assert.deepEqual(second.scenes.slice(0,2).map(scene=>scene.room),["غرفة العائلة","غرفة العائلة"]);
  assert.equal(second.scenes[0].roomSemantic?.kind,"living");
  assert.equal(second.scenes[0].roomSemantic?.groupId,group);
  assert.throws(()=>renameSemanticRoom(renamed,group,"  "));
  assert.throws(()=>renameSemanticRoom(renamed,"missing","اسم"));
});

test("legacy custom labels are preserved but never treated as visual or private-bathroom evidence",()=>{
  const result=applyRoomSemantics([{...scene("a"),room:"غرفة نوم ماستر",name:"اسمي الخاص"}],{observations:[],relations:[]});
  assert.equal(result.scenes[0].room,"غرفة نوم ماستر");assert.equal(result.scenes[0].name,"اسمي الخاص");
  assert.equal(result.rooms[0].kind,"unknown");assert.equal(result.rooms[0].confidence,0);
  assert.equal(result.rooms[0].nameSource,"legacy");assert.ok(result.rooms[0].reviewFlags.includes("legacy_name_unverified"));
});

test("splitting a previous room creates distinct identities while keeping all user names",()=>{
  const input=linked(["a","b","c"],[["a","b"],["b","c"]]);
  const first=applyRoomSemantics(input,{observations:input.map(scene=>observation(scene.id,"living")),relations:[relation("a","b"),relation("b","c")]});
  const named=renameSemanticRoom(first.scenes,first.rooms[0].id,"الغرفة المحفوظة");
  const second=applyRoomSemantics(named,{observations:input.map(scene=>observation(scene.id,"living")),relations:[relation("b","c")]});
  assert.equal(new Set(second.rooms.map(room=>room.id)).size,2);
  assert.equal(second.scenes[1].roomSemantic?.groupId,first.rooms[0].id);
  assert.ok(second.scenes.every(scene=>scene.room==="الغرفة المحفوظة"&&scene.roomSemantic?.nameSource==="user"));
});

test("repeated observations cannot inflate confidence or modify caller data",()=>{
  const input=linked(["a","b","c"],[["a","b"],["b","c"]]);
  const evidence={observations:Array.from({length:20},(_,index)=>({...observation("a","bedroom",.7),id:"same-camera-"+index})),relations:[relation("a","b"),relation("b","c")]};
  const before=structuredClone({input,evidence}),result=applyRoomSemantics(input,evidence);
  const single=applyRoomSemantics(input,{...evidence,observations:[evidence.observations[0]]});
  assert.equal(result.rooms[0].confidence,single.rooms[0].confidence);assert.ok(result.rooms[0].confidence<.7);assert.ok(result.rooms[0].reviewFlags.includes("partial_visual_evidence"));
  assert.deepEqual({input,evidence},before);
});

test("a supported low-confidence function remains an editable proposal without becoming confident",()=>{
  const result=applyRoomSemantics([scene("kitchen")],{observations:[observation("kitchen","kitchen",.55)],relations:[]});
  assert.equal(result.rooms[0].kind,"kitchen");assert.equal(result.rooms[0].name,"المطبخ");assert.equal(result.rooms[0].suggestedName,"المطبخ");
  assert.equal(result.rooms[0].confidence,.55);assert.ok(result.rooms[0].needsReview);assert.ok(result.rooms[0].reviewFlags.includes("low_confidence"));
});

test("blank-wall captures discount support without erasing repeated room evidence",()=>{
  const ids=Array.from({length:8},(_,index)=>"capture-"+index),edges=ids.slice(1).map((id,index)=>[ids[index],id] as [string,string]),input=linked(ids,edges);
  const result=applyRoomSemantics(input,{observations:input.map((scene,index)=>observation(scene.id,index<2?"kitchen":"unknown",index<2?.95:.25)),relations:edges.map(([a,b])=>relation(a,b))});
  assert.equal(result.rooms.length,1);assert.equal(result.rooms[0].kind,"kitchen");assert.equal(result.rooms[0].name,"المطبخ");
  assert.ok(result.rooms[0].confidence>=.5&&result.rooms[0].confidence<.95);assert.ok(result.rooms[0].reviewFlags.includes("partial_visual_evidence"));assert.ok(result.rooms[0].needsReview);
});

test("strongly supported conflicting room functions stay unresolved even when one has more captures",()=>{
  const ids=["a","b","c","d"],edges:[string,string][]=[["a","b"],["b","c"],["c","d"]],input=linked(ids,edges);
  const result=applyRoomSemantics(input,{observations:input.map((scene,index)=>observation(scene.id,index===3?"bedroom":"kitchen",.95)),relations:edges.map(([a,b])=>relation(a,b))});
  assert.equal(result.rooms[0].kind,"unknown");assert.ok(result.rooms[0].reviewFlags.includes("conflicting_labels"));assert.equal(result.rooms[0].confidence,0);
});

test("floor reassignment splits room identities so a rename cannot affect another floor",()=>{
  const input=linked(["a","b"],[["a","b"]]);
  const first=applyRoomSemantics(input,{observations:input.map(scene=>observation(scene.id,"bedroom")),relations:[relation("a","b")]});
  const moved=reconcileRoomMembership(first.scenes.map(scene=>scene.id==="b"?{...scene,floor:1}:scene));
  assert.notEqual(moved[0].roomSemantic?.groupId,moved[1].roomSemantic?.groupId);
  assert.notEqual(moved[0].room,moved[1].room);
  const renamed=renameSemanticRoom(moved,moved[0].roomSemantic!.groupId,"الغرفة الأرضية");
  assert.equal(renamed[0].room,"الغرفة الأرضية");assert.equal(renamed[1].room,moved[1].room);
  assert.ok(moved.every(scene=>scene.roomSemantic?.reviewFlags.includes("room_floor_changed")));
});

test("missing or moved bathroom groups invalidate automatic suite names while keeping explicit user names",()=>{
  const input=linked(["bed","bath"],[["bed","bath"]]),evidence={observations:[observation("bed","bedroom"),observation("bath","bathroom")],relations:[relation("bed","bath","doorway",{direct:true,privateToFrom:true})]};
  const first=applyRoomSemantics(input,evidence);
  assert.equal(first.scenes[0].room,"غرفة نوم ماستر");
  for(const values of [first.scenes.filter(scene=>scene.id!=="bath"),first.scenes.map(scene=>scene.id==="bath"?{...scene,floor:1}:scene)]){
    const updated=reconcileRoomMembership(values),bed=updated.find(scene=>scene.id==="bed")!;
    assert.equal(bed.room,"غرفة النوم");assert.equal(bed.roomSemantic?.ensuiteBathroomGroupIds,undefined);
    assert.ok(bed.roomSemantic?.reviewFlags.includes("private_bathroom_unverified"));
  }
  const manual=renameSemanticRoom(first.scenes,first.scenes[0].roomSemantic!.groupId,"جناح الوالدين");
  assert.equal(reconcileRoomMembership(manual.filter(scene=>scene.id==="bed"))[0].room,"جناح الوالدين");
});

test("visible fixtures without verified private access remain review suggestions even without a bathroom capture",()=>{
  const input=[scene("bed")],proposal=suite("bed"),before=structuredClone({input,proposal});
  const result=applyRoomSemantics(input,{observations:[observation("bed","bedroom")],relations:[],suiteObservations:[proposal]});
  assert.equal(result.scenes.length,1);assert.equal(result.scenes[0].room,"غرفة النوم");
  const metadata=result.rooms[0].suggestedEnsuite!;assert.equal(metadata.status,"suggested");assert.equal(metadata.privacyConfidence,0);assert.equal(metadata.doorwayVerified,false);
  assert.deepEqual(metadata.visibleFixtures,["toilet","shower"]);assert.deepEqual(metadata.sceneIds,["bed"]);
  assert.ok(result.rooms[0].reviewFlags.includes("visible_bathroom_requires_review"));assert.ok(roomSemanticSchema.safeParse(result.scenes[0].roomSemantic).success);
  assert.deepEqual({input,proposal},before);
  assert.equal(roomSuiteObservationSchema.safeParse({...proposal,visibleFixtures:["door"]}).success,false);
});

test("principal naming from a visible ensuite requires every independent acceptance and privacy gate",()=>{
  const input=[scene("bed")],observations=[observation("bed","bedroom")];
  for(const change of [{verified:false},{doorwayVerified:false},{direct:false},{privateToFrom:false},{privacyConfidence:.89},{confidence:.84}]){
    const result=applyRoomSemantics(input,{observations,relations:[],suiteObservations:[confirmedSuite("bed",change)]});
    assert.equal(result.rooms[0].name,"غرفة النوم");assert.equal(result.rooms[0].suggestedEnsuite?.status,"suggested");
  }
  for(const value of [observation("bed","bedroom",.79),observation("bed","living")]){
    const result=applyRoomSemantics(input,{observations:[value],relations:[],suiteObservations:[confirmedSuite("bed")]});assert.notEqual(result.rooms[0].name,"غرفة نوم ماستر");assert.equal(result.rooms[0].suggestedEnsuite?.status,"suggested");
  }
  const accepted=applyRoomSemantics(input,{observations,relations:[],suiteObservations:[confirmedSuite("bed")]});
  assert.equal(accepted.rooms[0].name,"غرفة نوم ماستر");assert.equal(accepted.rooms[0].suggestedEnsuite?.status,"confirmed");
  assert.equal(accepted.rooms[0].ensuiteBathroomGroupIds,undefined);assert.equal(accepted.scenes[0].position,null);assert.deepEqual(accepted.scenes[0].links,[]);
});

test("captured and uncaptured confirmed suites share stable numbering while manual names survive reanalysis",()=>{
  const input=linked(["bed-a","bath-a","bed-b"],[["bed-a","bath-a"]]),evidence={observations:input.map(scene=>observation(scene.id,scene.id.startsWith("bed")?"bedroom":"bathroom")),relations:[relation("bed-a","bath-a","doorway",{direct:true,privateToFrom:true})],suiteObservations:[confirmedSuite("bed-b")]};
  const first=applyRoomSemantics(input,evidence);
  assert.deepEqual(first.rooms.filter(room=>room.kind==="bedroom").map(room=>room.name),["غرفة نوم ماستر 1","غرفة نوم ماستر 2"]);
  const renamed=renameSemanticRoom(first.scenes,first.scenes.find(scene=>scene.id==="bed-b")!.roomSemantic!.groupId,"جناح الوالدين");
  const second=applyRoomSemantics([...renamed].reverse(),evidence),bed=second.scenes.find(scene=>scene.id==="bed-b")!;
  assert.equal(bed.room,"جناح الوالدين");assert.equal(bed.roomSemantic?.nameSource,"user");assert.equal(bed.roomSemantic?.suggestedName,"غرفة نوم ماستر 2");assert.equal(bed.roomSemantic?.suggestedEnsuite?.status,"confirmed");
  const withoutProof=applyRoomSemantics(second.scenes,{...evidence,suiteObservations:[suite("bed-b")]});assert.equal(withoutProof.scenes.find(scene=>scene.id==="bed-b")?.room,"جناح الوالدين");assert.equal(withoutProof.scenes.find(scene=>scene.id==="bed-b")?.roomSemantic?.suggestedEnsuite?.status,"suggested");
});

test("visible-suite suggestions cannot override accepted shared bathroom access or conflicting privacy evidence",()=>{
  const input=linked(["bed","bath","hall"],[["bed","bath"],["bath","hall"]]);
  const result=applyRoomSemantics(input,{observations:[observation("bed","bedroom"),observation("bath","bathroom"),observation("hall","corridor")],relations:[relation("bed","bath","doorway",{direct:true,privateToFrom:true}),relation("bath","hall","doorway",{direct:true})],suiteObservations:[confirmedSuite("bed")]});
  const bed=result.rooms.find(room=>room.kind==="bedroom")!;assert.equal(bed.name,"غرفة النوم");assert.equal(bed.suggestedEnsuite?.status,"suggested");
  const conflict=applyRoomSemantics([scene("bed")],{observations:[observation("bed","bedroom")],relations:[],suiteObservations:[confirmedSuite("bed"),confirmedSuite("bed",{id:"shared-observation",privateToFrom:false})]});
  assert.equal(conflict.rooms[0].name,"غرفة النوم");assert.ok(conflict.rooms[0].reviewFlags.includes("shared_bathroom_access"));
});

test("suite evidence stays with its actual capture and cannot leak across unrelated rooms or deleted sources",()=>{
  const input=linked(["a","b","c"],[["a","b"]]),evidence={observations:input.map(scene=>observation(scene.id,"bedroom")),relations:[relation("a","b")],suiteObservations:[confirmedSuite("a"),confirmedSuite("foreign"),suite("c")]};
  const first=applyRoomSemantics(input,evidence);assert.equal(first.scenes[1].room,"غرفة نوم ماستر");assert.equal(first.scenes[2].roomSemantic?.suggestedEnsuite?.status,"suggested");
  const removed=reconcileRoomMembership(first.scenes.filter(scene=>scene.id!=="a")),other=removed.find(scene=>scene.id==="b")!;
  assert.equal(other.roomSemantic?.suggestedEnsuite,undefined);assert.equal(other.room,"غرفة النوم 1");assert.ok(other.roomSemantic?.reviewFlags.includes("visible_bathroom_evidence_changed"));
  const moved=reconcileRoomMembership(first.scenes.map(scene=>scene.id==="a"?{...scene,floor:1}:scene));assert.equal(moved.find(scene=>scene.id==="b")?.roomSemantic?.suggestedEnsuite,undefined);assert.equal(moved.find(scene=>scene.id==="a")?.roomSemantic?.suggestedEnsuite?.status,"confirmed");
  const named=renameSemanticRoom(first.scenes,first.scenes[0].roomSemantic!.groupId,"غرفة العائلة");assert.equal(reconcileRoomMembership(named.filter(scene=>scene.id!=="a"))[0].room,"غرفة العائلة");
});
