import test from "node:test";
import assert from "node:assert/strict";
import {FloorPlanPointerGesture} from "../src/components/imo3d/floorplan-pointer";
const point=(pointerId:number,clientX=658,clientY=545,button=0)=>({pointerId,clientX,clientY,button});

test("a 3D plan drag cannot select a room when pointermove events were lost",()=>{
  const input=new FloorPlanPointerGesture();input.down(point(1));
  assert.equal(input.up(point(1,764,563)),false);
  input.down(point(2));assert.equal(input.up(point(2,661,546)),true);
});
test("a drag returning to its origin remains a drag and right clicks never select",()=>{
  const input=new FloorPlanPointerGesture();input.down(point(1));input.move(point(1,700,545));
  assert.equal(input.up(point(1)),false);
  input.down(point(2,658,545,2));assert.equal(input.up(point(2,658,545,2)),false);
});
test("pinch contacts cannot select in either release order or when a third finger joins",()=>{
  for(const order of [[1,2],[2,1]]){const input=new FloorPlanPointerGesture();input.down(point(1));input.down(point(2,760));for(const id of order)assert.equal(input.up(point(id)),false);input.down(point(4));assert.equal(input.up(point(4)),true);}
  const input=new FloorPlanPointerGesture();input.down(point(1));input.down(point(2));assert.equal(input.up(point(2)),false);input.down(point(3));assert.equal(input.up(point(3)),false);assert.equal(input.up(point(1)),false);
});
test("pointercancel and unmatched releases cannot select, and a fresh click still works",()=>{
  const input=new FloorPlanPointerGesture();input.down(point(1));input.cancel();assert.equal(input.up(point(1)),false);
  input.down(point(2));assert.equal(input.up(point(3)),false);assert.equal(input.up(point(2)),false);
  input.down(point(4));assert.equal(input.up(point(4)),true);
});
