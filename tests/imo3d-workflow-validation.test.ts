import test from "node:test";
import assert from "node:assert/strict";
import { leadPhoneSchema, normalizeLeadPhone } from "../src/lib/imo3d/lead-validation";
import { mergeTourSpatial } from "../src/lib/imo3d/tour-merge";
import type { Depth, Plan, Scene } from "../src/lib/imo3d/model";
import {displayDepthSchema,sceneSchema} from "../src/lib/imo3d/model";

const depth = (value = 8): Depth => ({ width: 8, height: 4, values: Array(32).fill(value) });
const scene = (id: string, floor = 0): Scene => ({
  id, name: id, room: "المطبخ", floor, position: { x: 0, y: 1.6, z: id === "b" ? -2 : 0 }, yaw: 0,
  image: `/imo3d/example/${id}.webp`, preview: `/imo3d/example/${id}.webp`, thumbnail: `/imo3d/example/${id}.webp`,
  sourceName: `${id}.jpg`, links: [],
});
const plan = (floor = 0): Plan => ({
  floor, label: `الدور ${floor}`, kind: "geometry", image: "/imo3d/example/plan-f0.svg", width: 100, height: 100,
  bounds: { minX: -5, minZ: -5, maxX: 5, maxZ: 5 }, walls: [{ a: { x: -5, z: -5 }, b: { x: 5, z: -5 } }],
});

test("display-only depth validates dimensions and actual coverage without creating metric depth",()=>{
  const displayDepth={width:8,height:4,values:Array(32).fill(2),confidence:.8,coverage:1,source:"monocular-multiview-floor-aligned",units:"camera_height",purpose:"display_only"};
  const parsed=sceneSchema.parse({...scene("a"),displayDepth});
  assert.equal(parsed.depth,undefined);assert.equal(parsed.displayDepth?.purpose,"display_only");
  const partial={...displayDepth,values:[0,...Array(31).fill(2)],coverage:31/32};
  assert.equal(displayDepthSchema.safeParse(partial).success,true);
  for(const invalid of [{...partial,coverage:1},{...displayDepth,width:9},{...displayDepth,values:[-1,...Array(31).fill(2)]},{...displayDepth,units:"meters"},{...displayDepth,purpose:"measurement"}])assert.equal(displayDepthSchema.safeParse(invalid).success,false);
});

test("lead phone canonicalization prevents formatting-based rate-limit bypass", () => {
  for (const phone of ["+966501234567", "+966 50 123 4567", "+966 (50) 123-4567", "00966 50 123 4567", "+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧", "+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷"]) {
    assert.equal(normalizeLeadPhone(phone), "+966501234567");
    assert.equal(leadPhoneSchema.parse(phone), "+966501234567");
  }
});

test("phone validation counts digits, rejects garbage, and preserves local numbers", () => {
  assert.equal(normalizeLeadPhone("٠٥٠ ١٢٣ ٤٥٦٧"), "0501234567");
  assert.equal(normalizeLeadPhone("12345678"), "12345678");
  assert.equal(normalizeLeadPhone("+123456789012345"), "+123456789012345");
  for (const invalid of ["        ", "--------", "( ) - ( )", "1234567", "+1234567890123456", "++966501234567", "966+501234567", "50O1234567", "0512345678 ext 1", "<script>12345678</script>"]) {
    assert.equal(normalizeLeadPhone(invalid), null, invalid);
    assert.equal(leadPhoneSchema.safeParse(invalid).success, false, invalid);
  }
  const invalid = leadPhoneSchema.safeParse("--------");
  assert.ok(!invalid.success && invalid.error.issues[0].message.includes("رقم جوال"));
});

test("uploading an unpositioned photograph preserves the calibrated plan and graph", () => {
  const a = { ...scene("a"), links: ["b"] }, b = { ...scene("b"), links: ["a"] };
  const architectural = plan();
  const result = mergeTourSpatial({ scenes: [a, b], plans: [architectural] }, [a, b, { ...scene("new"), position: null }]);
  assert.equal(result.plans[0], architectural);
  assert.deepEqual(result.scenes.map(value => value.links), [["b"], ["a"], []]);
  assert.equal(result.quality.positioned, 2);
  assert.equal(result.quality.components, 2);
  assert.equal(a.links.length, 1);
});

test("changed calibration cannot clear rejection of a floor drawing", () => {
  const a = scene("a"), b = scene("b"), rejected: Plan = {...plan(), reviewStatus: "rejected"};
  const result = mergeTourSpatial({scenes: [a, b], plans: [rejected]}, [a, {...b, position: {x: 1, y: 1.6, z: -2}}]);
  assert.notEqual(result.plans[0], rejected);
  assert.equal(result.plans[0].reviewStatus, "rejected");
  assert.equal(rejected.kind, "geometry");
});

test("partial camera update changes only affected floors and connections", () => {
  const a = { ...scene("a"), links: ["b"] }, b = { ...scene("b"), links: ["a"] };
  const upstairs = { ...scene("upstairs", 1), depth: depth() };
  const groundPlan = plan(), upperPlan = plan(1);
  const result = mergeTourSpatial({ scenes: [a, b, upstairs], plans: [groundPlan, upperPlan] }, [a, b, { ...upstairs, position: { x: 3, y: 4.6, z: 2 } }]);
  assert.equal(result.plans.find(value => value.floor === 0), groundPlan);
  assert.equal(result.plans.find(value => value.floor === 1)?.kind, "depth");
  assert.deepEqual(result.scenes[0].links, ["b"]);
  assert.ok(result.quality.warnings.some(value => value.includes("معايرة")));
});

test("changed camera calibration removes stale links without inventing replacements", () => {
  const a = { ...scene("a"), links: ["b"] }, b = { ...scene("b"), links: ["a"] };
  const result = mergeTourSpatial({ scenes: [a, b], plans: [plan()] }, [a, { ...b, position: { x: 50, y: 1.6, z: 0 } }]);
  assert.deepEqual(result.scenes.map(value => value.links), [[], []]);
  assert.equal(result.plans[0].kind, "path");
});

test("new depth is tested for clearance while architectural registration is preserved", () => {
  const a = { ...scene("a"), links: ["b"] }, b = { ...scene("b"), links: ["a"] }, architectural = plan();
  const blocked = mergeTourSpatial({ scenes: [a, b], plans: [architectural] }, [{ ...a, depth: depth(1) }, { ...b, depth: depth() }]);
  assert.deepEqual(blocked.scenes.map(value => value.links), [[], []]);
  assert.equal(blocked.plans[0], architectural);
  const clear = mergeTourSpatial({ scenes: [a, b], plans: [architectural] }, [{ ...a, depth: depth() }, { ...b, depth: depth() }]);
  assert.deepEqual(clear.scenes.map(value => value.links), [["b"], ["a"]]);
});

test("renaming and equivalent yaw do not discard a source graph", () => {
  const a = { ...scene("a"), links: ["b"], depth: depth() }, b = { ...scene("b"), links: ["a"] };
  const architectural = plan();
  const result = mergeTourSpatial({ scenes: [a, b], plans: [architectural] }, [{ ...a, yaw: 360, name: "اسم جديد", depth: structuredClone(a.depth) }, b]);
  assert.deepEqual(result.scenes[0].links, ["b"]);
  assert.equal(result.plans[0], architectural);
});

test("invalid previous edges are never promoted to verified reciprocal connections", () => {
  const a = { ...scene("a"), links: ["a", "b", "missing", "upstairs"] }, b = scene("b");
  const upstairs = { ...scene("upstairs", 1), links: ["a"] };
  const result = mergeTourSpatial({ scenes: [a, b, upstairs], plans: [plan(), plan(1)] }, [a, b, upstairs]);
  assert.deepEqual(result.scenes.map(value => value.links), [[], [], []]);
});

test("a legacy edge cannot override current depth that proves an obstruction", () => {
  const a = { ...scene("a"), depth: depth(1), links: ["b"] }, b = { ...scene("b"), depth: depth(), links: ["a"] };
  const result = mergeTourSpatial({ scenes: [a, b], plans: [] }, [a, b]);
  assert.deepEqual(result.scenes.map(value => value.links), [[], []]);
});
