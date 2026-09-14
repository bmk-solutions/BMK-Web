import test from "node:test";
import assert from "node:assert/strict";
import { buildEstimatedPlans, preserveAuthoredFloorState, selectLargestConnectedComponents } from "../src/lib/imo3d/reconstruction-layout";
import type { ReconstructionResult, ReconstructionScene } from "../src/lib/imo3d/reconstruction";
import type { Plan, Scene } from "../src/lib/imo3d/model";

const scene = (id: string, floor = 0, x = 0, z = 0): ReconstructionScene => ({
  id, floor, position: { x, y: 0, z }, yaw: 0, links: [], confidence: .8, component: "",
});
const component = (id: string, sceneIds: string[], surfaceX?: number): ReconstructionResult["components"][number] => ({
  id, sceneIds, layout: "relative_reconstruction", bearingErrorDegrees: .2, sparsePoints: [],
  surfaceCandidates: surfaceX === undefined ? [] : [{
    a: { x: surfaceX, z: -6 }, b: { x: surfaceX + 2, z: 8 }, confidence: .8,
    supportPoints: 50, kind: "vertical_surface", classification: "unverified",
  }],
});

test("authored room frames preserve all saved geometry and only rebase existing visual edges", () => {
  const saved: Scene = { id: "a", name: "room", room: "kitchen", floor: 0, image: "/imo3d/example/a.webp", preview: "/imo3d/example/a.webp", thumbnail: "/imo3d/example/a.webp", sourceName: "a.webp", position: { x: 7, y: 2, z: 9 }, yaw: 350, links: ["b"], manualLinks: [{ targetId: "b", yaw: 310 }], blockedLinks: ["c"], depth: { width: 8, height: 4, values: Array(32).fill(3) } };
  const upper = { ...saved, id: "upper", floor: 1 };
  const authored: Plan = { floor: 0, label: "Ground", kind: "estimated", bounds: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 }, walls: [], authoredRooms: [{ id: "room-a", name: "kitchen", outline: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 4 }], finish: "tile", openings: [1] }] };
  const proposed = [{ ...saved, position: { x: -100, y: 0, z: -100 }, yaw: 30, links: ["b", "c"], depth: undefined, manualLinks: [], visualLinks: [{ targetId: "b", yaw: 45 }, { targetId: "c", yaw: 120 }] }, { ...upper, position: { x: 3, y: 0, z: 5 } }];
  const nextPlans = [{ ...authored, authoredRooms: undefined, bounds: { minX: -100, minZ: -100, maxX: 0, maxZ: 0 } }, { ...authored, floor: 1, authoredRooms: undefined }];
  const before = structuredClone({ saved, upper, authored, proposed, nextPlans });
  const result = preserveAuthoredFloorState([saved, upper], [authored], proposed, nextPlans);
  assert.deepEqual(result.scenes[0], { ...saved, visualLinks: [{ targetId: "b", yaw: 5 }] });
  assert.deepEqual(result.scenes[1], proposed[1]);
  assert.deepEqual(result.plans[0], authored);
  assert.deepEqual(result.plans[1], nextPlans[1]);
  assert.deepEqual([...result.protectedFloors], [0]);
  assert.deepEqual({ saved, upper, authored, proposed, nextPlans }, before);
  const displayDepth={width:8,height:4,values:Array(32).fill(2),coverage:1,confidence:.8,source:"monocular-multiview-floor-aligned" as const,units:"camera_height" as const,purpose:"display_only" as const};
  const enriched=preserveAuthoredFloorState([saved],[authored],[{...proposed[0],displayDepth}],nextPlans).scenes[0];
  assert.deepEqual(enriched.displayDepth,displayDepth);assert.deepEqual(enriched.depth,saved.depth);assert.deepEqual(enriched.position,saved.position);
  const otherPhoto=preserveAuthoredFloorState([saved],[authored],[{...proposed[0],image:"/imo3d/example/other.webp",displayDepth}],nextPlans).scenes[0];
  assert.equal(otherPhoto.displayDepth,undefined);
});

test("automatic reconstruction cannot silently approve a rejected floor or reject other floors", () => {
  const rejected: Plan = {floor: 0, label: "Ground", kind: "estimated", reviewStatus: "rejected", bounds: {minX: 0, minZ: 0, maxX: 5, maxZ: 5}, walls: []};
  const replacement: Plan = {...rejected, reviewStatus: undefined, bounds: {minX: 2, minZ: 2, maxX: 8, maxZ: 8}};
  const upper: Plan = {...replacement, floor: 1};
  const before = structuredClone({rejected, replacement, upper});
  const {plans, protectedFloors} = preserveAuthoredFloorState([], [rejected], [], [replacement, upper]);
  assert.equal(plans[0].reviewStatus, "rejected");
  assert.deepEqual(plans[0].bounds, replacement.bounds);
  assert.equal(plans[1].reviewStatus, undefined);
  assert.equal(protectedFloors.size, 0);
  assert.deepEqual({rejected, replacement, upper}, before);
});

test("independent reconstruction origins are not merged into one floor drawing", () => {
  const scenes = [scene("a"), scene("b", 0, 1), scene("c", 0, 2), scene("d"), scene("e", 0, -900)];
  const result = { scenes, components: [component("large", ["a", "b", "c"], 4), component("small", ["d", "e"], -900)] };
  assert.deepEqual([...selectLargestConnectedComponents(scenes, result)], ["a", "b", "c"]);
  const [plan] = buildEstimatedPlans(scenes, result);
  assert.equal(plan.estimatedSurfaces?.length, 1);
  assert.equal(plan.estimatedSurfaces?.[0].a.x, 4);
  assert.equal(plan.bounds.minX, -.5);
  assert.equal(plan.kind, "estimated");
});

test("each actual floor selects its own largest component without cross-floor leakage", () => {
  const scenes = [scene("a"), scene("b", 0, 1), scene("c", 1, 20), scene("d", 1, 21), scene("e", 1, 22), scene("f", 1)];
  const result = { scenes, components: [component("ground", ["a", "b"], -3), component("upper", ["c", "d", "e"], 25), component("isolated", ["f"])] };
  assert.deepEqual([...selectLargestConnectedComponents(scenes, result)], ["a", "b", "c", "d", "e"]);
  const plans = buildEstimatedPlans(scenes, result);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].estimatedSurfaces?.[0].a.x, -3);
  assert.equal(plans[1].estimatedSurfaces?.[0].a.x, 25);
  assert.equal(plans[1].bounds.minX, 19.5);
});

test("unplaced rooms remain in the scene catalogue and input objects are untouched", () => {
  const scenes = [scene("a"), scene("b"), scene("unplaced-room")].map(value => ({ ...value, room: `room-${value.id}` }));
  const result = { scenes, components: [component("main", ["a", "b"]), component("separate", ["unplaced-room"])] };
  const before = structuredClone({ scenes, result });
  const ids = selectLargestConnectedComponents(scenes, result);
  buildEstimatedPlans(scenes, result);
  assert.equal(ids.has("unplaced-room"), false);
  assert.equal(scenes.find(value => value.id === "unplaced-room")?.room, "room-unplaced-room");
  assert.deepEqual({ scenes, result }, before);
});

test("estimated bounds include both surface endpoints with padding", () => {
  const scenes = [scene("a"), scene("b", 0, 1, 1)];
  const result = { scenes, components: [component("main", ["a", "b"], -10)] };
  const [plan] = buildEstimatedPlans(scenes, result);
  assert.deepEqual(plan.bounds, { minX: -10.5, maxX: 1.5, minZ: -6.5, maxZ: 8.5 });
  assert.deepEqual(plan.walls, []);
  assert.equal(plan.estimatedSurfaces?.[0].classification, "unverified");
});

test("component ties are stable and unknown image IDs cannot win placement", () => {
  const scenes = [scene("a"), scene("b"), scene("c"), scene("d")];
  const components = [component("b-group", ["c", "d"]), component("a-group", ["a", "b"]), component("unknown", ["fake-1", "fake-2", "fake-3"])];
  const first = selectLargestConnectedComponents(scenes, { scenes, components });
  const reversed = selectLargestConnectedComponents(scenes, { scenes, components: [...components].reverse() });
  assert.deepEqual([...first], ["a", "b"]);
  assert.deepEqual([...reversed], [...first]);
});

test("a floor without a supported camera pair gets a missing map, never orphan surfaces", () => {
  const scenes = [scene("a")];
  const result = { scenes, components: [component("singleton", ["a"], -10)] };
  const [plan] = buildEstimatedPlans(scenes, result);
  assert.equal(selectLargestConnectedComponents(scenes, result).size, 0);
  assert.equal(plan.kind, "missing");
  assert.deepEqual(plan.estimatedSurfaces, []);
  assert.deepEqual(plan.bounds, { minX: -.5, maxX: 1.5, minZ: -.5, maxZ: 1.5 });
});

test("learned room boundaries become separate apartment plans in the selected camera frame",()=>{
  const scenes=[scene("a"),scene("b",0,1),scene("c",1,20),scene("d",1,21)];
  const region=(id:string,componentId:string,floor:number,x:number,sceneIds:string[])=>({id:"room-"+id,floor,component:componentId,frame:"component" as const,scale:"camera_height" as const,sceneIds,representativeSceneId:sceneIds[0],outline:[{x:x-1,z:-1},{x:x+3,z:-1},{x:x+3,z:2},{x:x-1,z:2}],ceilingHeight:2.2,ceilingAboveCamera:1.2,confidence:.75,openings:[],classification:"estimated_room_envelope" as const,evidence:{method:"multiview"}});
  const result={scenes,components:[{...component("ground",["a","b"]),scaleBasis:"camera_height" as const,rooms:[region("a","ground",0,0,["a","b"])]},{...component("upper",["c","d"]),scaleBasis:"camera_height" as const,rooms:[region("c","upper",1,20,["c","d"])]}]};
  const before=structuredClone(result),plans=buildEstimatedPlans(scenes,result);
  assert.equal(plans[0].generatedRooms?.length,1);assert.equal(plans[1].generatedRooms?.length,1);
  assert.equal(plans[0].walls.length,4);assert.equal(plans[1].walls[0].a.x,19);
  assert.equal(plans[0].generatedFrom?.scale,"camera_height");assert.equal(plans[0].generatedFrom?.ceilingHeight,2.2);
  assert.equal(plans[0].kind,"estimated");assert.equal(plans[0].authoredRooms,undefined);
  assert.deepEqual(result,before);
  const other=buildEstimatedPlans(scenes.slice(0,2),{scenes:scenes.slice(0,2),components:[{...component("other",["a","b"]),scaleBasis:"camera_height",rooms:[region("a","other",0,7,["a","b"])]}]});
  assert.notDeepEqual(other[0].generatedRooms?.[0].outline,plans[0].generatedRooms?.[0].outline);
});

test("malformed, wrong-floor and unscaled room contours cannot become apartment walls",()=>{
  const scenes=[scene("a"),scene("b",0,1)];
  const room={id:"room-a",floor:0,component:"main",frame:"component" as const,scale:"camera_height" as const,sceneIds:["a","b"],representativeSceneId:"a",outline:[{x:-1,z:-1},{x:2,z:-1},{x:2,z:2},{x:-1,z:2}],ceilingHeight:2,ceilingAboveCamera:1,confidence:.7,openings:[],classification:"estimated_room_envelope" as const,evidence:{}};
  const frame={...component("main",["a","b"]),rooms:[room]};
  assert.equal(buildEstimatedPlans(scenes,{scenes,components:[frame]})[0].walls.length,0);
  for(const invalid of [{...room,floor:1},{...room,sceneIds:["foreign"]},{...room,outline:[{x:0,z:0},{x:2,z:2},{x:0,z:2},{x:2,z:0}]},{...room,confidence:NaN}])assert.equal(buildEstimatedPlans(scenes,{scenes,components:[{...frame,scaleBasis:"camera_height",rooms:[invalid]}]})[0].walls.length,0);
});

test("automatic boundaries can improve on reanalysis without freezing the camera frame",()=>{
  const saved:Scene={...scene("a"),name:"المطبخ",room:"المطبخ",image:"/imo3d/example/a.webp",preview:"/imo3d/example/a.webp",thumbnail:"/imo3d/example/a.webp",sourceName:"a.webp"},proposed={...saved,position:{x:5,y:0,z:7}};
  const plan:Plan={floor:0,label:"Ground",kind:"estimated",bounds:{minX:0,maxX:2,minZ:0,maxZ:2},walls:[],generatedRooms:[{id:"room-a",name:"المطبخ",outline:[{x:0,z:0},{x:2,z:0},{x:2,z:2}],finish:"tile",openings:[]}],generatedFrom:{method:"model",confidence:.7,sceneIds:["a"],scale:"camera_height"}};
  const result=preserveAuthoredFloorState([saved],[plan],[proposed],[{...plan,bounds:{minX:3,maxX:8,minZ:3,maxZ:8}}]);
  assert.equal(result.protectedFloors.size,0);assert.deepEqual(result.scenes[0].position,proposed.position);assert.equal(result.plans[0].bounds.minX,3);
});
