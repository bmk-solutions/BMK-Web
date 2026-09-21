import test from "node:test";
import assert from "node:assert/strict";
import { calibratePanoramaHeight, calibratePanoramaReference, calibratePanoramaWall, calibratePanoramaWallHeight, calibratePanoramaCeiling, projectPanoramaCeiling, measurePanoramaFloor, measurePanoramaPlane, parseMeasurementMeters, projectPanoramaFloor, projectPanoramaMeasurement } from "../src/lib/imo3d/panorama-measurement";

const rayTo = (x: number, z: number, height = 1.6) => ({ yaw: Math.atan2(x, -z), pitch: Math.atan2(-height, Math.hypot(x, z)) });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("in-image floor picks reconstruct lens-relative coordinates from a known camera height", () => {
  const calibration = calibratePanoramaHeight("scene-a", 1.6)!;
  const first = rayTo(1, -3), second = rayTo(4, 1);
  const projected = projectPanoramaFloor(first, calibration.heightMeters)!;
  close(projected.x, 1); close(projected.y, -1.6); close(projected.z, -3);
  close(measurePanoramaFloor("scene-a", first, second, calibration)!, 5);
  assert.equal(measurePanoramaFloor("other-scene", first, second, calibration), null);
});

test("a known floor reference calibrates a different pair without using plan coordinates or depth", () => {
  const calibration = calibratePanoramaReference("unpositioned-photo", rayTo(0, -2), rayTo(3, -2), 3)!;
  close(calibration.heightMeters, 1.6);
  assert.equal(calibration.source, "floor_reference");
  close(measurePanoramaFloor("unpositioned-photo", rayTo(-2, -3), rayTo(2, -3), calibration)!, 4);
});

test("floor distances remain invariant across yaw wrapping and panorama orientation", () => {
  const first = rayTo(-.3, 2), second = rayTo(.3, 2), calibration = calibratePanoramaHeight("scene", 1.6)!;
  for (const rotation of [0, Math.PI, -Math.PI * 2, 5.71]) {
    close(measurePanoramaFloor("scene", { ...first, yaw: first.yaw + rotation }, { ...second, yaw: second.yaw + rotation }, calibration)!, .6);
  }
});

test("above-horizon, unstable near-horizon, nonfinite and invalid lens-height picks are rejected", () => {
  for (const pitch of [0, .3, -.04, -Math.PI / 2 - .01, NaN, Infinity]) assert.equal(projectPanoramaFloor({ yaw: 0, pitch }), null);
  assert.equal(projectPanoramaFloor({ yaw: NaN, pitch: -.5 }), null);
  for (const height of [0, -.5, .149, 10.01, NaN, Infinity]) assert.equal(calibratePanoramaHeight("scene", height), null);
  assert.equal(calibratePanoramaHeight(" ", 1.6), null);
  const nadir = projectPanoramaFloor({ yaw: 12, pitch: -Math.PI / 2 }, 1.6)!;
  close(nadir.x, 0); close(nadir.z, 0);
});

test("tiny or inconsistent reference segments cannot silently establish scale", () => {
  const first = rayTo(0, -2), second = rayTo(3, -2);
  assert.equal(calibratePanoramaReference("scene", first, first, 1), null);
  assert.equal(calibratePanoramaReference("scene", first, { ...first, yaw: first.yaw + .001 }, 1), null);
  assert.equal(calibratePanoramaReference("scene", first, { yaw: 0, pitch: .1 }, 1), null);
  for (const reference of [0, -.5, .01, 101, NaN, Infinity]) assert.equal(calibratePanoramaReference("scene", first, second, reference), null);
  assert.equal(calibratePanoramaReference("scene", first, second, 99), null);
});

test("floor calibration accepts Arabic decimal entry and rejects mixed or ambiguous text", () => {
  for (const value of ["١٫٦٠", "۱.۶۰", "1,60", " 1.6 "]) close(parseMeasurementMeters(value), 1.6);
  for (const value of ["", "1m", "1.2.3", "Infinity", "-1", "0x10", "1e2"]) assert.ok(Number.isNaN(parseMeasurementMeters(value)));
});

test("two measured wall-base picks support height, width and diagonal measurements on that wall", () => {
  const calibration = calibratePanoramaWall("photo", rayTo(-2, -3), rayTo(2, -3), 4)!;
  close(calibration.heightMeters, 1.6); close(calibration.wall.distance, 3);
  const wallRay = (x: number, heightAboveFloor: number) => ({ yaw: Math.atan2(x, 3), pitch: Math.atan2(heightAboveFloor - 1.6, Math.hypot(x, 3)) });
  close(measurePanoramaPlane("photo", wallRay(0, 0), wallRay(0, 2.8), calibration)!, 2.8);
  close(measurePanoramaPlane("photo", wallRay(-1, 2.8), wallRay(1, 2.8), calibration)!, 2);
  close(measurePanoramaPlane("photo", wallRay(-2, 0), wallRay(2, 3), calibration)!, 5);
  assert.equal(measurePanoramaPlane("other-photo", wallRay(0, 0), wallRay(0, 2.8), calibration), null);
});

test("wall calibration preserves reversed base picks and rotated panorama orientation", () => {
  for (const rotation of [0, Math.PI * .65, Math.PI * 2]) {
    const first = { ...rayTo(-2, -3), yaw: rayTo(-2, -3).yaw + rotation };
    const second = { ...rayTo(2, -3), yaw: rayTo(2, -3).yaw + rotation };
    for (const [a, b] of [[first, second], [second, first]]) {
      const calibration = calibratePanoramaWall("photo", a, b, 4)!;
      close(measurePanoramaPlane("photo", { yaw: rotation, pitch: Math.atan2(-1.6, 3) }, { yaw: rotation, pitch: Math.atan2(1.2, 3) }, calibration)!, 2.8);
    }
  }
});

test("wall measurement rejects behind-camera, nearly parallel and degenerate reference planes", () => {
  const calibration = calibratePanoramaWall("photo", rayTo(-2, -3), rayTo(2, -3), 4)!;
  for (const ray of [{ yaw: Math.PI, pitch: 0 }, { yaw: Math.PI / 2, pitch: 0 }, { yaw: 0, pitch: Math.PI / 2 }, { yaw: NaN, pitch: 0 }]) {
    assert.equal(projectPanoramaMeasurement(ray, calibration), null);
  }
  assert.equal(calibratePanoramaWall("photo", rayTo(0, -1), rayTo(0, -3), 2), null);
  assert.equal(projectPanoramaMeasurement({ yaw: 0, pitch: 0 }, { ...calibration, wall: { normal: { x: 0, z: -2 }, distance: 3 } }), null);
  assert.equal(projectPanoramaMeasurement({ yaw: 0, pitch: 0 }, { ...calibration, wall: { ...calibration.wall, distance: Infinity } }), null);
});

const ray3d = (x: number, y: number, z: number) => ({ yaw: Math.atan2(x, -z), pitch: Math.atan2(y, Math.hypot(x, z)) });

test("lens height alone calibrates a wall and measures a door diagonal in metres", () => {
  const wall = calibratePanoramaWallHeight("photo", ray3d(-2, -1.6, -3), ray3d(2, -1.6, -3), 1.6)!;
  assert.equal(wall.source, "wall_height");
  assert.equal("referenceMeters" in wall, false);
  close(wall.wall.distance, 3);
  close(measurePanoramaPlane("photo", ray3d(-.5, -1.6, -3), ray3d(.5, .4, -3), wall)!, Math.sqrt(5));
  assert.equal(measurePanoramaPlane("elsewhere", ray3d(-.5, -1.6, -3), ray3d(.5, .4, -3), wall), null);
});

test("height-calibrated wall plus ceiling junction permits horizontal ceiling measurements", () => {
  const wall = calibratePanoramaWallHeight("photo", ray3d(-2, -1.6, -3), ray3d(2, -1.6, -3), 1.6)!;
  const ceiling = calibratePanoramaCeiling("photo", ray3d(0, 1.2, -3), wall)!;
  assert.equal(ceiling.source, "ceiling_height");
  close(ceiling.ceilingOffsetMeters, 1.2);
  close(ceiling.heightMeters + ceiling.ceilingOffsetMeters, 2.8);
  const a = ray3d(-2, 1.2, -2), b = ray3d(1, 1.2, 2);
  close(measurePanoramaPlane("photo", a, b, ceiling)!, 5);
  const projected = projectPanoramaMeasurement(b, ceiling)!;
  close(projected.x, 1); close(projected.y, 1.2); close(projected.z, 2);
  assert.equal(calibratePanoramaCeiling("other", ray3d(0, 1.2, -3), wall), null);
  assert.equal(measurePanoramaPlane("other", a, b, ceiling), null);
});

test("height wall and ceiling calibration preserve yaw rotation and reversed base picks", () => {
  for (const rotation of [0, .61, Math.PI, 2 * Math.PI]) {
    const rotate = (ray: {yaw:number;pitch:number}) => ({...ray,yaw:ray.yaw+rotation});
    const a=rotate(ray3d(-2,-1.6,-3)), b=rotate(ray3d(2,-1.6,-3));
    for (const [first,second] of [[a,b],[b,a]]) {
      const wall=calibratePanoramaWallHeight("photo",first,second,1.6)!;
      const ceiling=calibratePanoramaCeiling("photo",rotate(ray3d(0,1.2,-3)),wall)!;
      close(measurePanoramaPlane("photo",rotate(ray3d(0,1.2,-2)),rotate(ray3d(3,1.2,2)),ceiling)!,5);
    }
  }
});

test("height-based calibration rejects degenerate bases and unstable or negative ceiling picks", () => {
  const a=ray3d(-2,-1.6,-3),b=ray3d(2,-1.6,-3);
  for (const height of [-1,0,NaN,Infinity,11]) assert.equal(calibratePanoramaWallHeight("photo",a,b,height),null);
  assert.equal(calibratePanoramaWallHeight("photo",a,a,1.6),null);
  assert.equal(calibratePanoramaWallHeight("photo",ray3d(0,-1.6,-1),ray3d(0,-1.6,-3),1.6),null);
  assert.equal(calibratePanoramaWallHeight("photo",{yaw:0,pitch:-.001},b,1.6),null);
  const wall=calibratePanoramaWallHeight("photo",a,b,1.6)!;
  for (const ray of [{yaw:0,pitch:0},{yaw:0,pitch:.01},{yaw:0,pitch:-.3},{yaw:Math.PI,pitch:.3},{yaw:NaN,pitch:.3}]) assert.equal(calibratePanoramaCeiling("photo",ray,wall),null);
  for (const offset of [0,-1,NaN,Infinity]) assert.equal(projectPanoramaCeiling({yaw:0,pitch:.5},offset),null);
  assert.equal(projectPanoramaCeiling({yaw:0,pitch:.09},20),null);
  close(projectPanoramaCeiling({yaw:0,pitch:Math.PI/2},1.2)!.y,1.2);
});

test("existing known-reference wall calibration also supports ceiling plane derivation", () => {
  const wall=calibratePanoramaWall("photo",rayTo(-2,-3),rayTo(2,-3),4)!;
  const ceiling=calibratePanoramaCeiling("photo",ray3d(0,1.4,-3),wall)!;
  close(ceiling.ceilingOffsetMeters,1.4);
  close(measurePanoramaPlane("photo",ray3d(-1,1.4,-3),ray3d(1,1.4,-3),ceiling)!,2);
});


test("vertical door height spans the horizon using the floor base, with no depth map",()=>{
 for(const yaw of [0,1.2,Math.PI-.01,-Math.PI+.01]){
  const base={yaw,pitch:Math.atan2(-1.27,2.4)},top={yaw:yaw+Math.PI*2,pitch:Math.atan2(2.1-1.27,2.4)};
  const calibration={sceneId:"door",source:"vertical_height" as const,heightMeters:1.27,base};
  close(measurePanoramaPlane("door",base,top,calibration)!,2.1);
  assert.equal(measurePanoramaPlane("other",base,top,calibration),null);
  assert.equal(projectPanoramaMeasurement({...top,yaw:yaw+.2},calibration),null);
  assert.equal(projectPanoramaMeasurement({...base,pitch:base.pitch-.1},calibration),null);
  assert.equal(projectPanoramaMeasurement({yaw,pitch:Math.PI/2},calibration),null);
 }
});
test("vertical measurement requires a valid floor base and can measure below-horizon tops",()=>{
 const base={yaw:0,pitch:Math.atan2(-1.27,3)};
 close(measurePanoramaPlane("s",base,{yaw:0,pitch:Math.atan2(.8-1.27,3)},{sceneId:"s",heightMeters:1.27,source:"vertical_height",base})!,.8);
 assert.equal(projectPanoramaMeasurement({yaw:0,pitch:.2},{sceneId:"s",heightMeters:1.27,source:"vertical_height"}),null);
 assert.equal(projectPanoramaMeasurement({yaw:0,pitch:.2},{sceneId:"s",heightMeters:1.27,source:"vertical_height",base:{yaw:0,pitch:0}}),null);
});
