import test from "node:test";
import assert from "node:assert/strict";
import { calibratePlanReference, horizontalPlanDistance, inversePlanProjection, planHasMetricScale } from "../src/lib/imo3d/measurement";
import { floorPlanProjection } from "../src/components/imo3d/floorplan-geometry";
import type { Plan, Scene } from "../src/lib/imo3d/model";
import {buildFloorPlan3D} from "../src/components/imo3d/floorplan3d-geometry";
import {planFromRooms} from "../src/lib/imo3d/boundary-shapes";

const plan: Plan = { floor: 0, label: "المخطط", kind: "geometry", walls: [], bounds: { minX: -5, minZ: -5, maxX: 10, maxZ: 10 } };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("registered drawing measurement inverts rotation, reflection and unequal axis scales", () => {
  const project = ({ x, z }: { x: number; z: number }) => ({ x: 200 + 4 * x + 3 * z, y: 150 + 2 * x - 8 * z });
  const inverse = inversePlanProjection(project)!;
  const first = inverse(project({ x: 10, z: -4 })), second = inverse(project({ x: 13, z: 0 }));
  close(first.x, 10); close(first.y, -4);
  close(horizontalPlanDistance(first, second)!, 5);
  // Pixel length is deliberately different from actual horizontal length.
  assert.notEqual(horizontalPlanDistance(project({ x: 10, z: -4 }), project({ x: 13, z: 0 })), 5);
});

test("degenerate or invalid map transforms cannot grant a usable measurement projection", () => {
  assert.equal(inversePlanProjection(() => ({ x: 1, y: 1 })), null);
  assert.equal(inversePlanProjection(({ x, z }) => ({ x: x + z, y: 2 * (x + z) })), null);
  assert.equal(inversePlanProjection(() => ({ x: Infinity, y: 0 })), null);
});

test("only registered geometry or depth with a metric coordinate frame enables native meters", () => {
  assert.equal(planHasMetricScale(plan, "metric", true), true);
  assert.equal(planHasMetricScale(plan, undefined, true), true); // Legacy calibrated sample.
  assert.equal(planHasMetricScale({ ...plan, kind: "depth" }, "metric", true), true);
  for (const kind of ["estimated", "path", "missing"] as const) assert.equal(planHasMetricScale({ ...plan, kind }, "metric", true), false);
  assert.equal(planHasMetricScale(plan, "relative", true), false);
  assert.equal(planHasMetricScale(plan, "metric", false), false);
});

test("camera-height generated rooms cannot grant native meters or calibrated 3D heights",()=>{
  const generated:Plan={...plan,generatedRooms:[{id:"room-a",name:"الغرفة",outline:[{x:0,z:0},{x:4,z:0},{x:4,z:3},{x:0,z:3}],finish:"wood",openings:[]}],generatedFrom:{method:"visual-layout",confidence:.9,sceneIds:["a"],scale:"camera_height"}};
  for(const candidate of [generated,{...generated,generatedRooms:undefined},{...generated,generatedFrom:undefined}]){
    assert.equal(planHasMetricScale(candidate,"metric",true),false);
    assert.equal(buildFloorPlan3D(candidate,[],"metric").metric,false);
  }
  const reviewed=planFromRooms(generated,generated.generatedRooms!,0);
  assert.equal(reviewed.authoredScale,"relative");assert.equal(planHasMetricScale(reviewed,"metric",true),false);
  const reference=calibratePlanReference({x:0,y:0},{x:4,y:0},3)!;
  assert.equal(horizontalPlanDistance({x:0,y:0},{x:4,y:0},reference.metersPerUnit),3);
});

test("a known reference converts relative planar distances without changing scene geometry", () => {
  const first = { x: 10, y: 10 }, second = { x: 13, y: 14 };
  const calibration = calibratePlanReference(first, second, 2.5)!;
  assert.deepEqual(calibration, { metersPerUnit: .5, referenceMeters: 2.5, referenceUnits: 5 });
  close(horizontalPlanDistance({ x: 0, y: 0 }, { x: 0, y: 12 }, calibration.metersPerUnit)!, 6);
  assert.deepEqual(first, { x: 10, y: 10 });
  for (const value of [0, -1, Infinity, NaN, 100001]) assert.equal(calibratePlanReference(first, second, value), null);
  assert.equal(calibratePlanReference(first, first, 5), null);
  assert.equal(horizontalPlanDistance(first, { x: NaN, y: 0 }), null);
  assert.equal(horizontalPlanDistance(first, second, -1), null);
});

test("real floor-plan registration round-trips camera points and rejects inconsistent drawings", () => {
  const positions = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 3 }, { x: 4, z: 3 }];
  const scenes = positions.map((point, index): Scene => ({ id: `s${index}`, floor: 0, name: `s${index}`, room: "غرفة", yaw: 0,
    position: { ...point, y: 1.6 }, image: "/imo3d/example/scene.webp", preview: "/imo3d/example/scene.webp", thumbnail: "/imo3d/example/scene.webp", sourceName: "scene.webp", links: [] }));
  const drawing: Plan = { ...plan, image: "/imo3d/example/plan.svg", width: 300, height: 200,
    scenePoints: Object.fromEntries(scenes.map(scene => [scene.id, { x: 250 - scene.position!.x * 40, y: 180 - scene.position!.z * 50 }])) };
  const projection = floorPlanProjection(drawing, scenes)!;
  const inverse = inversePlanProjection(projection.project)!;
  const first = inverse(drawing.scenePoints!.s0), second = inverse(drawing.scenePoints!.s3);
  close(horizontalPlanDistance(first, second)!, 5);
  assert.equal(floorPlanProjection({ ...drawing, scenePoints: { ...drawing.scenePoints, s3: { x: 160, y: 100 } } }, scenes), null);
});
