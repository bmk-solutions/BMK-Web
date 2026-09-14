import test from "node:test";
import assert from "node:assert/strict";
import { prepareLogoPixels } from "../src/components/imo3d/logo-pixels";

function raster(width:number,height:number,color:readonly number[]) {
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4)data.set(color,i);
  return data;
}
function rectangle(data:Uint8ClampedArray,width:number,x:number,y:number,w:number,h:number,color:readonly number[]) {
  for(let row=y;row<y+h;row++)for(let column=x;column<x+w;column++)data.set(color,(row*width+column)*4);
}

test("white exterior is cropped while enclosed white details and foreground colors survive",()=>{
  const data=raster(20,16,[255,255,255,255]);
  rectangle(data,20,5,5,10,6,[10,10,10,255]);
  rectangle(data,20,9,7,2,2,[255,255,255,255]);
  const crop=prepareLogoPixels(data,20,16);
  assert.deepEqual(crop,{x:4,y:4,width:12,height:8,removedBackground:true,monochrome:true,hasTransparentBorder:true});
  assert.equal(data[3],0);
  assert.deepEqual([...data.slice((7*20+9)*4,(7*20+9)*4+4)],[255,255,255,255]);
  assert.deepEqual([...data.slice((5*20+5)*4,(5*20+5)*4+4)],[10,10,10,255]);
});

test("transparent white artwork keeps every alpha value and its white foreground",()=>{
  const data=raster(12,12,[0,0,0,0]);
  rectangle(data,12,4,4,4,4,[255,255,255,255]);
  data[(4*12+4)*4+3]=128;
  const original=data.slice();
  assert.deepEqual(prepareLogoPixels(data,12,12),{x:3,y:3,width:6,height:6,removedBackground:false,monochrome:true,hasTransparentBorder:true});
  assert.deepEqual(data,original);
});

test("a partially transparent border prevents guessing a white background",()=>{
  const data=raster(10,10,[255,255,255,255]);
  rectangle(data,10,4,4,2,2,[0,0,0,255]);
  data[3]=120;
  const original=data.slice(),crop=prepareLogoPixels(data,10,10);
  assert.equal(crop.removedBackground,false);
  assert.deepEqual(data,original);
});

test("an all-white opaque logo cannot be erased as background",()=>{
  const data=raster(12,8,[255,255,255,255]),original=data.slice();
  assert.deepEqual(prepareLogoPixels(data,12,8),{x:0,y:0,width:12,height:8,removedBackground:false,monochrome:true,hasTransparentBorder:false});
  assert.deepEqual(data,original);
});

test("small saturated and muted brand accents both prevent monochrome recoloring",()=>{
  for(const color of [[180,10,35,255],[82,70,70,255]]){
    const data=raster(20,20,[20,20,20,255]);
    data.set(color,(10*20+10)*4);
    const original=data.slice();
    assert.equal(prepareLogoPixels(data,20,20).monochrome,false);
    assert.deepEqual(data,original);
  }
});

test("original presentation preserves the opaque white background and colored content",()=>{
  const data=raster(20,16,[255,255,255,255]);
  rectangle(data,20,7,5,6,6,[25,110,160,255]);
  const original=data.slice();
  assert.deepEqual(prepareLogoPixels(data,20,16,false),{x:0,y:0,width:20,height:16,removedBackground:false,monochrome:false,hasTransparentBorder:false});
  assert.deepEqual(data,original);
});

test("empty transparent raster remains intact without claiming a monochrome logo",()=>{
  const data=raster(8,8,[255,255,255,0]),original=data.slice();
  assert.deepEqual(prepareLogoPixels(data,8,8),{x:0,y:0,width:8,height:8,removedBackground:false,monochrome:false,hasTransparentBorder:true});
  assert.deepEqual(data,original);
});

test("invalid raster dimensions and truncated pixels are rejected before modification",()=>{
  const data=raster(2,2,[1,2,3,255]),original=data.slice();
  for(const [width,height] of [[0,2],[1.5,2],[NaN,2],[Infinity,2],[2,3],[1025,1024]])assert.throws(()=>prepareLogoPixels(data,width,height),/Invalid logo raster/);
  assert.deepEqual(data,original);
});

test("an opaque grayscale plate remains distinct from transparent monochrome artwork",()=>{
  const data=raster(12,8,[20,20,20,255]);
  rectangle(data,12,4,2,4,4,[255,255,255,255]);
  const original=data.slice(),crop=prepareLogoPixels(data,12,8);
  assert.equal(crop.monochrome,true);
  assert.equal(crop.hasTransparentBorder,false);
  assert.equal(crop.removedBackground,false);
  assert.deepEqual(data,original);
});
