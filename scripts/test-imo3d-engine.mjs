import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three";

const require=createRequire(import.meta.url);
function harness({reduced=false,coarse=false,plans=[],maxTextureSize=8192,deviceMemory,pixelRatio=1,bitmap=false}={}) {
  let now=100, nextFrame=0;
  const frames=new Map(), images=[], renders=[], uploads=[], bitmapRequests=[], bitmaps=[];
  class FakeImage {
    naturalWidth=2048; naturalHeight=1024; _src=""; requestedSrc=""; loaded=false;
    constructor() { images.push(this); }
    set src(value) { this._src=value; this.requestedSrc=value; }
    get src() { return this._src; }
    removeAttribute(name) { if(name==="src")this._src=""; }
  }
  class FakeRenderer {
    capabilities={maxTextureSize};
    setPixelRatio() {} setClearColor() {} setSize() {} initTexture(texture) {uploads.push(texture);} dispose() {}
    getDrawingBufferSize(out) { return out.set(1200,800); }
    setRenderTarget(value) { this.target=value; }
    render(world,camera) { const visible=world.children.filter(child=>child.visible);renders.push({target:this.target,position:camera.position.clone(),direction:camera.getWorldDirection(new THREE.Vector3()),visible,snapshots:visible.map(object=>({object,position:object.position.clone(),texture:object.material?.map}))}); }
  }
  const sandbox={
    console, DOMException, AbortController, Error, Image:FakeImage,
    ...(bitmap?{fetch:async url=>({ok:true,blob:async()=>({url})}),createImageBitmap:(blob,options)=>new Promise(resolve=>bitmapRequests.push({url:blob.url,options,resolve}))}:{}),
    clearTimeout, navigator:{deviceMemory}, window:{devicePixelRatio:pixelRatio,setTimeout,matchMedia:query=>({matches:query.includes("reduced-motion")?reduced:coarse})},
    document:{hidden:false}, performance:{now:()=>now},
    requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
  };
  const modules=new Map();
  function load(file) {
    if(modules.has(file))return modules.get(file);
    const result={exports:{}};
    const code=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const localRequire=name=>name==="three"?{...THREE,WebGLRenderer:FakeRenderer}:
      name==="@/lib/imo3d/photo-edits"?load("src/lib/imo3d/photo-edits.ts"):
      name==="@/lib/imo3d/view-presentation"?load("src/lib/imo3d/view-presentation.ts"):
      name==="./PanoramaMotion"?load("src/components/imo3d/PanoramaMotion.ts"):
      name==="../../lib/imo3d/display-depth.ts"?load("src/lib/imo3d/display-depth.ts"):
      name==="./PanoramaQuality"?load("src/components/imo3d/PanoramaQuality.ts"):
      name==="./PanoramaBlobCache"?load("src/components/imo3d/PanoramaBlobCache.ts"):
      name==="./connection-overrides"?load("src/lib/imo3d/connection-overrides.ts"):
      name==="@/lib/imo3d/spatial"?load("src/lib/imo3d/spatial.ts"):require(name);
    vm.runInNewContext(code,{...sandbox,module:result,exports:result.exports,require:localRequire},{filename:file});
    modules.set(file,result.exports);return result.exports;
  }
  const {PanoramaEngine}=load("src/components/imo3d/PanoramaEngine.ts");
  const canvas={clientWidth:600,clientHeight:400,dataset:{},addEventListener(){},removeEventListener(){}};
  const engine=new PanoramaEngine(canvas,{plans});
  const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
  const success=async(url,width=2048,height=1024)=>{
    if(bitmap){await settle();const request=bitmapRequests.find(r=>r.url===url&&!r.done);assert.ok(request,`expected bitmap decode ${url}`);request.done=true;const decoded={width:request.options.resizeWidth??width,height:request.options.resizeHeight??height,closed:0,close(){this.closed++;}};bitmaps.push(decoded);request.resolve(decoded);await settle();return;}
    let image=images.find(image=>image.src===url&&!image.loaded);
    if(!image&&url.endsWith(".lite")){image=images.find(image=>image.src===url.replace(/\.lite$/,".full")&&!image.loaded);if(image){width=4096;height=2048;}}
    if(image){image.naturalWidth=width;image.naturalHeight=height;}
    assert.ok(image,`expected image request ${url}`);image.loaded=true;image.onload?.();await settle();
  };
  const tick=async(ms=16)=>{
    now+=ms;const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(now);await settle();
  };
  const finish=async()=>{for(let i=0;i<80;i++)await tick();};
  return {engine,canvas,images,renders,uploads,bitmapRequests,bitmaps,success,tick,finish,settle,motion:load("src/components/imo3d/PanoramaMotion.ts"),quality:load("src/components/imo3d/PanoramaQuality.ts"),spatial:load("src/lib/imo3d/spatial.ts")};
}
const scene=(id,x=0,z=0)=>({id,name:id,room:id,floor:0,position:{x,y:1.6,z},yaw:27,image:`/${id}.full`,preview:`/${id}.lite`,thumbnail:`/${id}.thumb`,sourceName:id,links:[]});
const initial=async(h,s)=>{const promise=h.engine.move(s,false);await h.success(s.preview);assert.equal(await promise,true);await h.tick();};
const displayDepth=(overrides={})=>{const values=Array.from({length:32*16},(_,index)=>index<64?0:3);return{width:32,height:16,values,confidence:.6,coverage:.875,source:"monocular-multiview-floor-aligned",units:"camera_height",purpose:"display_only",...overrides};};

test("photographic steps use a gentle bounded handover while direct selections stay immediate",async()=>{
  const h=harness();
  try{
    const a=scene("gentle-a"),b=scene("gentle-b",2),c=scene("direct-c",100);
    await initial(h,a);
    const moving=h.engine.move(b,true);await h.success(b.preview);
    for(let i=0;i<20;i++)await h.tick();
    assert.ok(h.engine.tween,"a step must not finish in the old 280 ms interval");
    assert.ok(Number(h.canvas.dataset.transitionProgress)>0.25&&Number(h.canvas.dataset.transitionProgress)<0.4);
    await h.finish();assert.equal(await moving,true);assert.equal(h.engine.tween,null);
    const direct=h.engine.move(c,false);await h.success(c.preview);
    assert.equal(await direct,true);assert.equal(h.engine.tween,null);assert.equal(h.canvas.dataset.sceneId,c.id);
  }finally{h.engine.dispose();}
});

test("motion easing stays monotonic with gentle acceleration at both endpoints",()=>{
  const h=harness();
  try{
    const ease=h.motion.motionProgress;
    assert.equal(ease(-1),0);assert.equal(ease(2),1);assert.equal(ease(.5),.5);
    for(let i=1;i<=100;i++)assert.ok(ease(i/100)>=ease((i-1)/100));
    assert.ok(ease(.01)<.00002);assert.ok(1-ease(.99)<.00002);
    const a=scene("a"),b=scene("b",1e5);
    for(const mode of ["dissolve","aligned-dissolve","display-depth","depth"]){
      const duration=h.motion.motionDuration(a,b,mode);assert.ok(duration>=950&&duration<=1150);
    }
  }finally{h.engine.dispose();}
});

test("8K quality is restricted by GPU capability, memory hints and decoded reservation size",()=>{
  const h=harness();
  try{
    const capable=h.quality.panoramaDisplayPolicy(false,8192,8),small=h.quality.panoramaDisplayPolicy(true,8192,8);
    assert.equal(capable.memoryBudget,192*1024*1024);assert.equal(small.memoryBudget,48*1024*1024);
    for(const policy of [small,h.quality.panoramaDisplayPolicy(false,4096,8),h.quality.panoramaDisplayPolicy(false,8192,2)])assert.equal(policy.detailAllowed,false);
    const input={...scene("detail"),detail:{image:"/detail.8k",width:8192,height:4096}};
    const candidate=h.quality.panoramaQualityCandidate(input,"preview",new Set(),capable,6000);
    assert.equal(candidate.quality,"detail");assert.equal(candidate.bytes,128*1024*1024);
    assert.equal(h.quality.panoramaQualityCandidate({...input,detail:{...input.detail,height:8192}},"preview",new Set(),capable,6000).quality,"image");
  }finally{h.engine.dispose();}
});

test("zoom automatically upgrades a displayed 4K panorama to 8K without changing the camera",async()=>{
  const h=harness();
  try{
    h.canvas.clientWidth=1100;h.canvas.clientHeight=600;
    const a={...scene("zoom"),detail:{image:"/zoom.8k",width:8192,height:4096}};
    await initial(h,a);await h.success(a.image,4096,2048);
    assert.equal(h.engine.cache.get(a.id).quality,"image");assert.ok(!h.images.some(image=>image.src===a.detail.image));
    const yaw=h.engine.yaw,pitch=h.engine.pitch;
    h.engine.fov=40;await h.tick();assert.ok(h.images.some(image=>image.src===a.detail.image));
    await h.success(a.detail.image,8192,4096);
    assert.equal(h.engine.cache.get(a.id).quality,"detail");assert.equal(h.engine.cache.get(a.id).bytes,128*1024*1024);
    assert.equal(h.canvas.dataset.textureWidth,"8192");assert.equal(h.engine.yaw,yaw);assert.equal(h.engine.pitch,pitch);assert.equal(h.engine.fov,40);
  }finally{h.engine.dispose();}
});

test("coarse, low-memory and texture-limited devices retain a bounded 4K fallback",async()=>{
  for(const options of [{coarse:true},{deviceMemory:2},{maxTextureSize:4096}]){
    const h=harness(options);
    try{
      h.canvas.clientWidth=1600;h.canvas.clientHeight=900;
      const a={...scene("limited"),detail:{image:"/limited.8k",width:8192,height:4096}};
      await initial(h,a);assert.ok(!h.images.some(image=>image.src===a.detail.image));
      await h.success(a.image,4096,2048);
      assert.equal(h.engine.cache.get(a.id).quality,"image");
      assert.ok(h.engine.cachedBytes()+h.engine.reservedBytes()<=h.engine.memoryBudget);
    }finally{h.engine.dispose();}
  }
});

test("an 8K failure falls back to 4K once and keeps the usable scene visible",async()=>{
  const h=harness();
  try{
    h.canvas.clientWidth=1600;h.canvas.clientHeight=900;
    const a={...scene("fallback"),detail:{image:"/fallback.8k",width:8192,height:4096}};
    await initial(h,a);const preview=h.engine.cache.get(a.id).texture;
    h.images.find(image=>image.src===a.detail.image).onerror();await h.settle();
    assert.equal(h.engine.cache.get(a.id).texture,preview);assert.ok(h.images.some(image=>image.src===a.image));
    await h.success(a.image,4096,2048);h.engine.fov=41;await h.tick();
    assert.equal(h.engine.cache.get(a.id).quality,"image");
    assert.equal(h.images.filter(image=>image.requestedSrc===a.detail.image).length,1);
    assert.equal(h.engine.cache.get(a.id).mesh.visible,true);
  }finally{h.engine.dispose();}
});

test("8K reservations count preview prefetch and evict the old detail before the next upgrade",async()=>{
  const h=harness();
  try{
    h.canvas.clientWidth=1600;h.canvas.clientHeight=900;
    const a={...scene("large-a"),detail:{image:"/large-a.8k",width:8192,height:4096}};
    const b={...scene("large-b",2),detail:{image:"/large-b.8k",width:8192,height:4096}},c=scene("preview-c",4);
    await initial(h,a);h.engine.prefetch([b,c]);await h.success(b.preview);await h.success(c.preview);
    assert.ok(h.engine.cachedBytes()+h.engine.reservedBytes()<=h.engine.memoryBudget);
    assert.ok(!h.images.some(image=>image.src===b.detail.image));
    await h.success(a.detail.image,8192,4096);
    const moving=h.engine.move(b);await h.finish();assert.equal(await moving,true);
    assert.ok(!h.images.some(image=>image.src===b.detail.image),"arrival does not trigger a late sharpness jump");
    h.engine.fov=40;await h.tick();assert.ok(h.images.some(image=>image.src===b.detail.image));
    assert.equal(h.engine.cache.has(a.id),false);
    assert.ok(h.engine.cachedBytes()+h.engine.reservedBytes()<=h.engine.memoryBudget);
    await h.success(b.detail.image,8192,4096);
    assert.equal([...h.engine.cache.values()].filter(entry=>entry.quality==="detail").length,1);
    assert.ok(h.engine.cachedBytes()<=h.engine.memoryBudget);
  }finally{h.engine.dispose();}
});

test("navigation cancels an in-flight 8K decode reservation and disposal releases it",async()=>{
  const h=harness();
  try{
    h.canvas.clientWidth=1600;h.canvas.clientHeight=900;
    const a={...scene("cancel8k"),detail:{image:"/cancel8k.8k",width:8192,height:4096}},b=scene("destination",1);
    await initial(h,a);assert.equal(h.engine.reservedBytes(),128*1024*1024);
    const moving=h.engine.move(b);await h.settle();
    assert.equal(h.engine.reservedBytes(),4096*2048*4);assert.ok(!h.images.some(image=>image.src===a.detail.image));
    await h.success(b.preview);await h.finish();assert.equal(await moving,true);
  }finally{h.engine.dispose();}
  await h.settle();assert.equal(h.engine.reservedBytes(),0);assert.equal(h.engine.cache.size,0);
});

test("proxy floor is anchored, finite at horizon, and camera shifts preserve direction with bounded magnitude",()=>{
  const h=harness();
  try {
    for(const pitch of [-Math.PI/2,-1,-0.5])assert.ok(Math.abs(h.motion.proxyRadius(pitch)*Math.sin(pitch)+1.6)<1e-8);
    for(const pitch of [-0.001,0,0.001,Math.PI/2])assert.ok(Number.isFinite(h.motion.proxyRadius(pitch)));
    const origin={x:80,y:1.6,z:4}, p=h.motion.proxyViewPosition(origin,{x:100,y:5,z:14});
    assert.ok(Math.hypot(p.x-origin.x,p.z-origin.z)<=1.25+1e-12);
    assert.ok(Math.abs(p.y-origin.y)<=0.2+1e-12);
    assert.ok(Math.abs((p.x-origin.x)/(p.z-origin.z)-2)<1e-8);
    const same=h.motion.proxyViewPosition(origin,origin);assert.equal(same.x,origin.x);assert.equal(same.y,origin.y);assert.equal(same.z,origin.z);
  } finally { h.engine.dispose(); }
});

test("linked no-depth moves keep image capture centers stable, preserve look/FOV, and finish exactly on target",async()=>{
  const h=harness();
  try {
    const a=scene("a"),b=scene("b",1.2,0.4);await initial(h,a);
    h.engine.yaw=0.9;h.engine.pitch=-0.2;h.engine.fov=68;
    const poses=[];h.engine.onView=(yaw,pitch,p)=>poses.push({yaw,pitch,p});
    const promise=h.engine.move(b);await h.success(b.preview);await h.tick(16);await h.tick(16);
    assert.equal(h.canvas.dataset.motionMode,"aligned-dissolve");
    assert.ok(+h.canvas.dataset.transitionProgress>0&&+h.canvas.dataset.transitionProgress<1);
    assert.ok(poses.every(({p})=>p.x===a.position.x));
    const renders=h.renders.filter(({target})=>target);
    assert.ok(renders.length>0);
    assert.ok(renders.every(({position})=>position.x===a.position.x||position.x===b.position.x));
    await h.finish();assert.equal(await promise,true);
    assert.equal(h.engine.yaw,0.9);assert.equal(h.engine.pitch,-0.2);assert.equal(h.engine.fov,68);
    assert.equal(h.engine.camera.position.x,b.position.x);assert.equal(h.engine.camera.position.z,b.position.z);
    assert.equal(h.canvas.dataset.sceneId,b.id);
  } finally { h.engine.dispose(); }
});

test("depth remains a separate mode and missing or cross-floor poses only dissolve",()=>{
  const h=harness();
  try {
    const a=scene("a"),b=scene("b",1),depth={width:8,height:4,values:Array(32).fill(4)};
    assert.equal(h.motion.motionMode(a,b),"aligned-dissolve");
    assert.equal(h.motion.motionMode({...a,depth},{...b,depth}),"depth");
    assert.equal(h.motion.motionMode(a,{...b,position:null}),"dissolve");
    assert.equal(h.motion.motionMode(a,{...b,floor:1}),"dissolve");
  } finally { h.engine.dispose(); }
});

test("rapid requests cancel stale loading and retain the latest target after the active step",async()=>{
  const h=harness();
  try {
    await initial(h,scene("a"));
    const b=scene("b",1),c=scene("c",2),d=scene("d",3),e=scene("e",4);
    const stale=h.engine.move(b);const live=h.engine.move(c);
    await h.settle();assert.equal(await stale,false);assert.equal(h.images.find(image=>image._src===b.preview),undefined);
    await h.success(c.preview);await h.tick();
    const discarded=h.engine.move(d),last=h.engine.move(e);
    assert.equal(await discarded,false);
    await h.finish();assert.equal(await live,true);
    await h.success(e.preview);await h.finish();assert.equal(await last,true);assert.equal(h.canvas.dataset.sceneId,e.id);
  } finally { h.engine.dispose(); }
});

test("cache churn pins source and destination; obsolete prefetch and all dispose promises settle",async()=>{
  const h=harness();
  const a=scene("a");await initial(h,a);const source=h.engine.cache.get(a.id);
  for(let i=0;i<9;i++) {
    const neighbour=scene(`n${i}`,i+1);h.engine.prefetch([neighbour]);await h.success(neighbour.preview);
    assert.ok(h.engine.cache.size<=5);assert.equal(h.engine.cache.get(a.id),source);
  }
  const b=scene("b",1),pending=h.engine.move(b);
  h.engine.prefetch([scene("old")]);h.engine.prefetch([scene("new")]);
  await h.settle();assert.equal(h.images.find(image=>image.src==="/old.lite"),undefined);
  await h.success(b.preview);await h.tick();
  assert.equal(h.engine.cache.get(a.id),source);assert.ok(h.engine.cache.has(b.id));
  const queued=h.engine.move(scene("queued",2));
  h.engine.dispose();assert.equal(await pending,false);assert.equal(await queued,false);
  await h.settle();assert.equal(h.engine.pending.size,0);assert.equal(h.engine.cache.size,0);assert.equal(h.engine.busy,false);
  assert.ok(h.images.every(image=>!image.src));
});

test("dispose aborts an initial load and reduced motion skips translation",async()=>{
  const h=harness();const pending=h.engine.move(scene("loading"));h.engine.dispose();
  assert.equal(await pending,false);await h.settle();assert.equal(h.engine.busy,false);
  const reduced=harness({reduced:true});
  try {
    await initial(reduced,scene("a"));const target=scene("b",2),move=reduced.engine.move(target);
    await reduced.success(target.preview);assert.equal(await move,true);assert.equal(reduced.engine.tween,null);
    assert.equal(reduced.engine.camera.position.x,2);
  } finally { reduced.engine.dispose(); }
});

test("a failed destination retains the current frame and clears busy so the user can retry",async()=>{
  const h=harness();
  try {
    const a=scene("a"),b=scene("b",1);await initial(h,a);
    const move=h.engine.move(b),rejection=assert.rejects(move,/تعذر تحميل/);
    h.images.find(image=>image.src===b.preview).onerror();await rejection;await h.settle();
    assert.equal(h.canvas.dataset.sceneId,a.id);assert.equal(h.engine.cache.get(a.id).mesh.visible,true);
    assert.equal(h.engine.busy,false);assert.equal(h.engine.pending.size,0);
    const retry=h.engine.move(b);await h.success(b.preview);await h.finish();assert.equal(await retry,true);
  } finally { h.engine.dispose(); }
});

test("high-resolution requests are cancelled before movement and on disposal without replacing the preview",async()=>{
  const h=harness();
  try {
    h.canvas.clientWidth=1200;
    const a=scene("a"),b=scene("b",1);await initial(h,a);
    assert.ok(h.images.some(image=>image.src===a.image));
    const preview=h.engine.cache.get(a.id).texture;
    const move=h.engine.move(b);await h.settle();
    assert.equal(h.images.find(image=>image.src===a.image),undefined);
    assert.equal(h.engine.cache.get(a.id).texture,preview);
    await h.success(b.preview);await h.finish();assert.equal(await move,true);
    assert.ok(h.images.some(image=>image.src===b.image));
  } finally { h.engine.dispose(); }
  await h.settle();assert.equal(h.engine.upgrades.size,0);assert.ok(h.images.every(image=>!image.src));
});

test("explicit pending-load cancellation keeps the source frame and settles false without interrupting visible movement",async()=>{
  const h=harness();
  try {
    const a=scene("a"),b=scene("b",1);await initial(h,a);
    const pending=h.engine.move(b);
    assert.equal(h.engine.cancelPendingLoad(),true);assert.equal(await pending,false);await h.settle();
    assert.equal(h.engine.busy,false);assert.equal(h.canvas.dataset.sceneId,a.id);
    assert.equal(h.engine.cache.get(a.id).mesh.visible,true);assert.equal(h.engine.pending.size,0);
    assert.equal(h.images.find(image=>image.src===b.preview),undefined);
    const retry=h.engine.move(b);await h.success(b.preview);await h.tick();
    assert.equal(h.engine.cancelPendingLoad(),false);
    await h.finish();assert.equal(await retry,true);assert.equal(h.canvas.dataset.sceneId,b.id);
    // Cancellation also handles a cache-hit promise before its microtask starts a tween.
    const cached=h.engine.move(a);assert.equal(h.engine.cancelPendingLoad(),true);assert.equal(await cached,false);
    assert.equal(h.canvas.dataset.sceneId,b.id);
  } finally { h.engine.dispose(); }
});

const boxWalls=[
  {a:{x:-3,z:-2},b:{x:3,z:-2}}, {a:{x:3,z:-2},b:{x:3,z:4}},
  {a:{x:3,z:4},b:{x:-3,z:4}}, {a:{x:-3,z:4},b:{x:-3,z:-2}},
];

test("plan ray intersections choose forward segments, retain openings, handle parallel rays and panorama yaw",()=>{
  const h=harness();
  try {
    const origin={x:0,z:0}, ray=h.motion.rayWallDistance;
    assert.equal(ray(origin,0,boxWalls),2);
    assert.equal(ray(origin,Math.PI/2,boxWalls),3);
    assert.equal(ray(origin,Math.PI,boxWalls),4);
    assert.equal(ray(origin,-Math.PI/2,boxWalls),3);
    assert.equal(ray(origin,0,[boxWalls[1]]),null);
    assert.equal(ray(origin,0,[boxWalls[2]]),null);
    assert.equal(ray(origin,0,[{a:{x:1,z:-2},b:{x:2,z:-2}}]),null);
    assert.equal(ray(origin,0,[boxWalls[0],{a:{x:-1,z:-1},b:{x:1,z:-1}}]),1);
    const s={...scene("a"),yaw:90},distances=h.motion.planWallDistances(s,boxWalls);
    assert.equal(distances.length,129);assert.equal(distances[64],3);assert.equal(distances[0],distances[128]);
    assert.equal(h.motion.planWallDistances({...s,position:null},boxWalls).length,0);
  } finally { h.engine.dispose(); }
});

test("plan proxy projects known wall distance and nominal ceiling while unknown rays keep the existing fallback",()=>{
  const h=harness();
  try {
    assert.equal(h.motion.proxyRadius(0,2),2);
    assert.equal(h.motion.proxyRadius(Math.PI/2,2),1.2);
    assert.equal(h.motion.proxyRadius(-Math.PI/2,2),1.6);
    assert.equal(h.motion.proxyRadius(0,null),12);
    assert.equal(h.motion.proxyRadius(Math.PI/2,null),12);
    const origin={x:0,y:1.6,z:0},near={x:0.5,y:1.6,z:0.3};
    const p=h.motion.proxyViewPosition(origin,near,true);
    assert.equal(p.x,near.x);assert.equal(p.z,near.z);
    const far=h.motion.proxyViewPosition(origin,{x:100,y:1.6,z:0},true);
    assert.ok(far.x<=1.25+1e-12);
  } finally { h.engine.dispose(); }
});

test("constructor plan walls may shape a proxy but cannot enable unsupported camera translation",async()=>{
  const plans=[{floor:0,label:"Plan",kind:"geometry",bounds:{minX:-3,maxX:3,minZ:-2,maxZ:4},walls:boxWalls}];
  const h=harness({plans});
  try {
    const a={...scene("a"),yaw:0},b={...scene("b",1),yaw:0};await initial(h,a);
    const geometry=h.engine.cache.get(a.id).mesh.geometry,positions=geometry.getAttribute("position");
    assert.equal(geometry.userData.planProxy,true);
    assert.ok(Math.abs(positions.getZ(32*129+64)+2)<1e-6);
    assert.ok(Math.abs(positions.getY(0)-1.2)<1e-6);
    assert.ok(Math.abs(positions.getY(64*129)+1.6)<1e-6);
    assert.equal(a.depth,undefined);
    const move=h.engine.move(b);await h.success(b.preview);await h.tick();
    assert.equal(h.canvas.dataset.motionMode,"aligned-dissolve");
    await h.finish();assert.equal(await move,true);
    const depth={width:8,height:4,values:Array(32).fill(6)};
    assert.equal(h.motion.motionMode({...a,depth},{...b,depth},true),"depth");
    const measured=h.engine.geometry({...a,depth});
    assert.equal(measured.userData.planProxy,false);
    assert.ok(Math.abs(measured.getAttribute("position").getZ(2*9+4)+6)<1e-6);measured.dispose();
  } finally { h.engine.dispose(); }
});

test("explicit image handovers retain capture-centered renders and look direction without inferred translation",async()=>{
  const h=harness();
  try {
    const a=scene("a"),b=scene("b",6,3);await initial(h,a);
    h.engine.yaw=1.15;h.engine.pitch=-.14;h.engine.fov=69;
    const before=h.renders.length,move=h.engine.move(b,"handover");await h.success(b.preview);
    await h.tick();await h.tick();
    assert.equal(h.canvas.dataset.motionMode,"dissolve");
    const transitionRenders=h.renders.slice(before).filter(render=>render.target);
    assert.ok(transitionRenders.length>=4);
    assert.ok(transitionRenders.every(({position})=>position.equals(new THREE.Vector3(0,1.6,0))||position.equals(new THREE.Vector3(6,1.6,3))));
    assert.equal(h.engine.camera.position.x,0);
    await h.finish();assert.equal(await move,true);
    assert.equal(h.engine.camera.position.x,6);assert.equal(h.engine.yaw,1.15);assert.equal(h.engine.pitch,-.14);assert.equal(h.engine.fov,69);
  } finally {h.engine.dispose();}
});

test("navigation cursor follows a pointed floor, is destination aware, and hides during movement or invalid rays",async()=>{
  const h=harness();
  try {
    const a={...scene("a"),yaw:0,links:["b"]},b=scene("b",0,-2);await initial(h,a);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,b),true);
    const first=h.engine.cursorMesh.position.clone();
    assert.equal(h.engine.cursorMesh.visible,true);
    assert.ok(Math.abs(first.y-.008)<1e-6);
    assert.ok(new THREE.Vector3(0,0,1).applyQuaternion(h.engine.cursorMesh.quaternion).distanceTo(new THREE.Vector3(0,1,0))<1e-6);
    assert.equal(h.engine.setNavigationCursor(-.2,-.7,b),true);
    assert.notEqual(h.engine.cursorMesh.position.x,first.x);
    assert.equal(h.engine.setNavigationCursor(.2,.2,b),false);assert.equal(h.engine.cursorMesh.visible,false);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,scene("unlinked")),true);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,{...b,blockedLinks:[a.id]}),false);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,{...b,floor:1}),false);
    assert.equal(h.engine.setNavigationCursor(NaN,-.7,b),false);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,b),true);
    const move=h.engine.move(b);assert.equal(h.engine.cursorMesh.visible,false);
    assert.equal(h.engine.setNavigationCursor(.2,-.7,b),false);
    await h.success(b.preview);await h.finish();assert.equal(await move,true);
  } finally {h.engine.dispose();}
});

test("navigation cursor does not fall back to a fabricated floor when supplied depth has no valid hit",async()=>{
  const h=harness();
  try {
    const a={...scene("a"),yaw:0,links:["b"],depth:{width:8,height:4,values:Array(32).fill(0)}},b=scene("b",0,-2);await initial(h,a);
    assert.equal(h.engine.setNavigationCursor(0,-.7,b),false);
    assert.equal(h.engine.cursorMesh.visible,false);
  }finally{h.engine.dispose();}
});

test("nominal floor cursor respects existing plan walls and does not draw through them",async()=>{
  const h=harness({plans:[{floor:0,walls:[{a:{x:-4,z:-2},b:{x:4,z:-2}}]}]});
  try{
    const a={...scene("a"),yaw:0,links:["b"]},b=scene("b",0,-1);await initial(h,a);
    assert.equal(h.engine.setNavigationCursor(0,-.6,b),false);
    assert.equal(h.engine.cursorMesh.visible,false);
    h.engine.pitch=-.5;h.engine.invalidate();await h.tick();
    assert.equal(h.engine.setNavigationCursor(0,-.7,b),true);
    assert.ok(h.engine.cursorMesh.position.z>-2);
  }finally{h.engine.dispose();}
});

test("authored room outlines cannot become panorama depth or suppress directional navigation",async()=>{
  const walls=[{a:{x:-4,z:-2},b:{x:4,z:-2}}];
  const plan={floor:0,label:"Hand-drawn",kind:"geometry",bounds:{minX:-4,maxX:4,minZ:-2,maxZ:2},walls,
    authoredScale:"relative",authoredRooms:[{id:"drawn",name:"Room",outline:[{x:-4,z:-2},{x:4,z:-2},{x:4,z:2}],finish:"wood",openings:[]}]};
  const h=harness({plans:[plan]});
  try{
    const a={...scene("a"),yaw:0,links:["b"]},b={...scene("b",0,-1),links:["a"]};await initial(h,a);
    const geometry=h.engine.cache.get(a.id).mesh.geometry;
    assert.equal(geometry.userData.planProxy,false);
    assert.ok(Math.abs(geometry.getAttribute("position").getZ(32*129+64)+12)<1e-6);
    assert.equal(h.engine.setNavigationCursor(0,-.6,b),true);
    assert.ok(h.engine.cursorMesh.position.z<-2);
    assert.equal(a.depth,undefined);
    assert.deepEqual(a.links,["b"]);
    assert.deepEqual(plan.walls,walls);
  }finally{h.engine.dispose();}
});

test("generated camera-height plan walls remain a map overlay without becoming panorama depth",async()=>{
  const plan={floor:0,label:"Generated",kind:"geometry",bounds:{minX:-3,maxX:3,minZ:-2,maxZ:4},walls:boxWalls,generatedFrom:{method:"visual-layout",confidence:.99,sceneIds:["a"],scale:"camera_height"}};
  const h=harness({plans:[plan]});
  try{
    const a={...scene("a"),yaw:0,links:["b"]},b={...scene("b",0,-1),links:["a"]};await initial(h,a);
    assert.equal(h.engine.cache.get(a.id).mesh.geometry.userData.planProxy,false);
    assert.equal(h.engine.setNavigationCursor(0,-.6,b),true);
    assert.equal(a.depth,undefined);
  }finally{h.engine.dispose();}
});

test("bounded depth cursor intersection agrees with the full mesh near grid edges and panorama seams",async()=>{
  const h=harness();
  try{
    const width=64,height=32,values=Array.from({length:width*height},(_,i)=>h.motion.proxyRadius((.5-Math.floor(i/width)/height)*Math.PI));
    const a={...scene("a"),depth:{width,height,values}};await initial(h,a);
    const entry=h.engine.cache.get(a.id);entry.mesh.updateMatrixWorld();
    let hits=0;
    for(const yaw of [-Math.PI,-2.95,-1.6,-.5,0,.46,1.5,2.9,Math.PI])for(const pitch of [-.2,-.4,-.55,-.7,-.9,-1.2]){
      const ray=new THREE.Ray(new THREE.Vector3(0,1.6,0),new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)));
      const full=new THREE.Raycaster(ray.origin,ray.direction).intersectObject(entry.mesh,false)[0];
      const bounded=h.engine.cursorDepthHit(entry,a,ray);
      assert.equal(Boolean(bounded),Boolean(full));
      if(full){hits++;assert.ok(full.point.distanceTo(bounded.point)<1e-6);}
    }
    assert.ok(hits>20);
  }finally{h.engine.dispose();}
});

test("photo transitions keep both image capture centers fixed without wobble or using diagram distance as depth",async()=>{
  for(const positioned of [false,true]){
    const h=harness();
    try{
      const a={...scene("visual-a",100,500),position:positioned?{x:100,y:0,z:500}:null,links:["visual-b"]};
      const b={...scene("visual-b",-200,-300),position:positioned?{x:-200,y:0,z:-300}:null,links:["visual-a"]};
      const before=JSON.stringify([a,b]);await initial(h,a);
      h.engine.yaw=.6;h.engine.pitch=-.15;h.engine.fov=66;
      const mark=h.renders.length,moving=h.engine.move(b,"visual",.6,{fromYaw:Math.PI/2,toYaw:-Math.PI/2});
      await h.success(b.preview);await h.tick();await h.tick();
      assert.equal(h.canvas.dataset.motionMode,"aligned-dissolve");
      const first=new THREE.Vector3(a.position?.x??0,a.position?.y??0,a.position?.z??0),second=new THREE.Vector3(b.position?.x??0,b.position?.y??0,b.position?.z??0);
      const frames=h.renders.slice(mark).filter(render=>render.target),fromFrames=frames.filter(render=>render.target===h.engine.renderA),toFrames=frames.filter(render=>render.target===h.engine.renderB);
      assert.ok(fromFrames.length>0&&toFrames.length>0);
      assert.ok(fromFrames.every(render=>render.position.distanceTo(first)<1e-8));
      assert.ok(toFrames.every(render=>render.position.distanceTo(second)<1e-8));
      await h.finish();assert.equal(await moving,true);
      assert.ok(h.engine.camera.position.distanceTo(second)<1e-8);
      assert.equal(h.engine.yaw,.6);assert.equal(h.engine.pitch,-.15);assert.equal(h.engine.fov,66);
      assert.equal(JSON.stringify([a,b]),before);
    }finally{h.engine.dispose();}
  }
});

test("visual pair arrival stays continuous across north and respects reduced motion",async()=>{
  for(const reduced of [false,true]){
    const h=harness({reduced});
    try{
      const a={...scene("visual-a"),links:["visual-b"]},b={...scene("visual-b"),links:["visual-a"]};
      await initial(h,a);h.engine.yaw=170*Math.PI/180;const views=[];h.engine.onView=yaw=>views.push(yaw);
      const moving=h.engine.move(b,"visual",-170*Math.PI/180,{fromYaw:170*Math.PI/180,toYaw:10*Math.PI/180});
      await h.success(b.preview);await h.finish();assert.equal(await moving,true);
      assert.ok(Math.abs(Math.atan2(Math.sin(h.engine.yaw+170*Math.PI/180),Math.cos(h.engine.yaw+170*Math.PI/180)))<1e-8);
      for(let i=1;i<views.length;i++)assert.ok(Math.abs(views[i]-views[i-1])<.08);
      assert.equal(h.canvas.dataset.motionMode,reduced?"reduced":"aligned-dissolve");
    }finally{h.engine.dispose();}
  }
});

test("looking around while a visual destination loads is retained after normal and reduced transitions",async()=>{
  for(const reduced of [false,true])for(const estimated of [false,true]){
    const h=harness({reduced});
    try{
      const a={...scene("look-a"),yaw:0,links:["look-b"],displayDepth:estimated?displayDepth():undefined},b={...scene("look-b"),links:["look-a"],displayDepth:estimated?displayDepth():undefined};
      await initial(h,a);h.engine.yaw=.2;
      const move=h.engine.move(b,"visual",.5,{fromYaw:0,toYaw:-Math.PI+.3});
      h.engine.addLook(.8,-.1);await h.finish();h.engine.stopLook();
      const latest=h.engine.yaw,pitch=h.engine.pitch;assert.ok(latest>.95);
      await h.success(b.preview);await h.finish();assert.equal(await move,true);
      assert.ok(Math.abs(h.engine.yaw-latest-.3)<1e-8);
      assert.equal(h.engine.pitch,pitch);
    }finally{h.engine.dispose();}
  }
});

test("visual movement cannot promote an unsupported, blocked or cross-floor target into an approach",async()=>{
  for(const target of [{...scene("visual-b"),links:[]},{...scene("visual-b"),links:["visual-a"],blockedLinks:["visual-a"]},{...scene("visual-b"),links:["visual-a"],floor:1}]){
    const h=harness();
    try{
      await initial(h,{...scene("visual-a"),links:["visual-b"]});
      const moving=h.engine.move(target,"visual",0,{fromYaw:0,toYaw:Math.PI});await h.success(target.preview);await h.tick();
      assert.equal(h.canvas.dataset.motionMode,"dissolve");await h.finish();assert.equal(await moving,true);
    }finally{h.engine.dispose();}
  }
});

test("manual doorway handovers align each panorama and settle arrival yaw continuously across north",async()=>{
  const h=harness();
  try{
    const a=scene("a"),b=scene("b",0,0);await initial(h,a);
    h.engine.yaw=170*Math.PI/180;h.engine.pitch=-.1;h.engine.invalidate();await h.tick();
    const before=h.renders.length,views=[];h.engine.onView=yaw=>views.push(yaw);
    const move=h.engine.move(b,"handover",-170*Math.PI/180);await h.success(b.preview);
    await h.tick();await h.tick();
    const frames=h.renders.slice(before).filter(render=>render.target);
    const bearing=ray=>Math.atan2(ray.x,-ray.z),diff=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
    assert.ok(Math.abs(diff(bearing(frames[0].direction),170*Math.PI/180))<1e-7);
    assert.ok(Math.abs(diff(bearing(frames[1].direction),-170*Math.PI/180))<1e-7);
    assert.ok(h.engine.yaw>170*Math.PI/180&&h.engine.yaw<190*Math.PI/180);
    await h.finish();assert.equal(await move,true);
    assert.ok(Math.abs(diff(h.engine.yaw,-170*Math.PI/180))<1e-7);
    for(let i=1;i<views.length;i++)assert.ok(Math.abs(views[i]-views[i-1])<.08,"arrival must not snap on the final frame");
    assert.equal(h.engine.pitch,-.1);
  }finally{h.engine.dispose();}
});

test("manual arrival respects reduced motion and confirmed aiming stops residual drag",async()=>{
  const h=harness({reduced:true});
  try{
    await initial(h,scene("a"));
    const move=h.engine.move(scene("b"),"handover",1.2);await h.success("/b.lite");assert.equal(await move,true);
    assert.equal(h.engine.yaw,1.2);
    h.engine.addLook(.4,.2);h.engine.stopLook();await h.tick();assert.equal(h.engine.yaw,1.2);assert.equal(h.engine.pitch,0);
  }finally{h.engine.dispose();}
});
test("display depth requires supported coverage and rejects discontinuities without becoming trusted depth",()=>{
  const h=harness();try{
    const a={...scene("display"),displayDepth:displayDepth()};assert.ok(h.motion.usableDisplayDepth(a));
    for(const overrides of [{confidence:.44},{coverage:.74},{purpose:"measurement"},{units:"meters"},{values:Array(512).fill(0)},{values:Array(512).fill(.1)},{width:256,height:128},{width:16,height:32}])assert.equal(h.motion.usableDisplayDepth({...a,displayDepth:displayDepth(overrides)}),undefined);
    assert.equal(h.motion.usableDisplayDepth({...a,depth:{width:8,height:4,values:Array(32).fill(3)}}),undefined);
    assert.equal(h.motion.displayDepthTriangle(3,3.1,3.2),true);assert.equal(h.motion.displayDepthTriangle(0,3,3),false);assert.equal(h.motion.displayDepthTriangle(3,3,9),false);
    assert.equal(h.spatial.surfacePoint(a,0,-.6),null);
  }finally{h.engine.dispose();}
});

test("display-only optical steps stay bounded and keep a complete panorama behind unsupported pixels",async()=>{
  for(const positioned of [false,true]){const h=harness();try{
    const a={...scene("display-a",100,500),position:positioned?{x:100,y:1.6,z:500}:null,links:["display-b"],displayDepth:displayDepth()};
    const b={...scene("display-b",-200,-300),position:positioned?{x:-200,y:1.6,z:-300}:null,links:["display-a"],displayDepth:displayDepth()};
    const before=JSON.stringify([a,b]);await initial(h,a);h.engine.yaw=.7;h.engine.pitch=-.2;h.engine.fov=66;
    const source=h.engine.cache.get(a.id);assert.ok(source.displayMesh);assert.equal(source.mesh.geometry.index.count,128*64*6);
    assert.ok(source.displayMesh.geometry.index.count<32*16*6);assert.ok(source.displayMesh.geometry.index.count>=32*16*3);
    assert.equal(source.displayMesh.visible,false);assert.equal(source.mesh.geometry.userData.planProxy,false);
    const mark=h.renders.length,moving=h.engine.move(b,"visual",.7,{fromYaw:Math.PI/2,toYaw:-Math.PI/2});await h.success(b.preview);await h.finish();assert.equal(await moving,true);
    assert.equal(h.canvas.dataset.motionMode,"display-depth");
    const destination=h.engine.cache.get(b.id),frames=h.renders.slice(mark).filter(render=>render.target),origins=[new THREE.Vector3(a.position?.x??0,a.position?.y??0,a.position?.z??0),new THREE.Vector3(b.position?.x??0,b.position?.y??0,b.position?.z??0)];
    for(const [index,entry] of [source,destination].entries()){
      const relevant=frames.filter(render=>render.target===(index===0?h.engine.renderA:h.engine.renderB));assert.ok(relevant.some(render=>render.position.distanceTo(origins[index])>.02));
      for(const render of relevant){assert.ok(render.position.distanceTo(origins[index])<=.120001);assert.equal(render.position.y,origins[index].y);assert.equal(render.visible.length,2);assert.ok(render.visible.includes(entry.mesh)&&render.visible.includes(entry.displayMesh));
        assert.ok(render.snapshots.find(item=>item.object===entry.mesh).position.distanceTo(render.position)<1e-8);assert.ok(render.snapshots.find(item=>item.object===entry.displayMesh).position.distanceTo(origins[index])<1e-8);
      }
      assert.ok(entry.mesh.position.distanceTo(origins[index])<1e-8);assert.equal(entry.displayMesh.visible,false);
    }
    assert.equal(source.mesh.visible,false);assert.equal(destination.mesh.visible,true);assert.ok(h.engine.camera.position.distanceTo(origins[1])<1e-8);
    assert.equal(h.engine.yaw,.7);assert.equal(h.engine.pitch,-.2);assert.equal(h.engine.fov,66);assert.equal(JSON.stringify([a,b]),before);
  }finally{h.engine.dispose();}}
});

test("direct selection, reduced motion and unsupported display depth remain capture-centered",async()=>{
  for(const options of [{animate:"handover"},{animate:"visual",reduced:true},{animate:"visual",badCoverage:true},{animate:"visual",discontinuous:true}]){
    const h=harness({reduced:options.reduced});try{
      const a={...scene("display-a"),links:["display-b"],displayDepth:displayDepth()},b={...scene("display-b",40,80),links:["display-a"],displayDepth:options.badCoverage?displayDepth({coverage:.5}):options.discontinuous?displayDepth({values:Array.from({length:512},(_,i)=>(i+Math.floor(i/32))%2?12:2),coverage:1}):displayDepth()};
      await initial(h,a);const mark=h.renders.length,moving=h.engine.move(b,options.animate,undefined,{fromYaw:0,toYaw:Math.PI});await h.success(b.preview);await h.finish();assert.equal(await moving,true);
      assert.notEqual(h.canvas.dataset.motionMode,"display-depth");
      for(const render of h.renders.slice(mark).filter(render=>render.target)){const origin=render.target===h.engine.renderA?a.position:b.position;assert.ok(render.position.distanceTo(new THREE.Vector3(origin.x,origin.y,origin.z))<1e-8);assert.equal(render.visible.length,1);}
      if(options.discontinuous)assert.equal(h.engine.cache.get(b.id).displayMesh,undefined);
    }finally{h.engine.dispose();}
  }
});

test("display meshes share texture upgrades, remain hidden on cancellation and release every resource once",async()=>{
  const h=harness();try{
    h.canvas.clientWidth=1600;h.canvas.clientHeight=900;
    const a={...scene("display-quality"),links:["next"],displayDepth:displayDepth(),detail:{image:"/display.8k",width:8192,height:4096}};
    await initial(h,a);const entry=h.engine.cache.get(a.id);assert.equal(entry.mesh.material.map,entry.displayMesh.material.map);
    await h.success(a.detail.image,8192,4096);assert.equal(entry.mesh.material.map,entry.displayMesh.material.map);assert.equal(entry.mesh.material.map,entry.texture);assert.ok(h.engine.cachedBytes()>entry.bytes);assert.ok(h.engine.cachedBytes()<=h.engine.memoryBudget);
    const moving=h.engine.move({...scene("next"),links:[a.id],displayDepth:displayDepth()},"visual",undefined,{fromYaw:0,toYaw:Math.PI});assert.equal(h.engine.cancelPendingLoad(),true);await h.settle();assert.equal(await moving,false);assert.equal(entry.mesh.visible,true);assert.equal(entry.displayMesh.visible,false);
    const resources=[entry.mesh.geometry,entry.mesh.material,entry.displayMesh.geometry,entry.displayMesh.material,entry.texture],counts=resources.map(()=>0);resources.forEach((resource,index)=>resource.addEventListener("dispose",()=>counts[index]++));
    h.engine.dispose();h.engine.dispose();assert.deepEqual(counts,[1,1,1,1,1]);assert.ok(!h.engine.world.children.includes(entry.mesh)&&!h.engine.world.children.includes(entry.displayMesh));
  }finally{h.engine.dispose();}
});

test("surface cursor uses display depth without promoting it to metric measurement",async()=>{
  const h=harness();try{
    const a={...scene("estimated"),links:["next"],displayDepth:displayDepth({values:Array(512).fill(2),coverage:1})};await initial(h,a);
    assert.equal(h.engine.setNavigationCursor(0,-.5,{...scene("next"),links:[a.id]}),true);assert.ok(h.engine.cursorMesh.position.distanceTo(h.engine.camera.position)>1.7);assert.equal(h.spatial.surfacePoint(a,0,-.5),null);
    assert.equal(h.engine.setNavigationCursor(0,.2,null,true),true);
    assert.equal(h.engine.cursorMaterial.uniforms.measuring.value,1);
    const normal=new THREE.Vector3(0,0,1).applyQuaternion(h.engine.cursorMesh.quaternion);
    assert.ok(normal.dot(h.engine.cursorMesh.position.clone().sub(h.engine.camera.position))<0);
    assert.equal(a.depth,undefined);
    const measured={...scene("measured",2),links:["measured-next"],displayDepth:displayDepth(),depth:{width:8,height:4,values:Array(32).fill(4)}};
    const load=h.engine.move(measured,false);await h.success(measured.preview);assert.equal(await load,true);assert.equal(h.engine.cache.get(measured.id).displayMesh,undefined);
    const next={...measured,id:"measured-next",preview:"/measured-next.lite",image:"/measured-next.full",position:{x:3,y:1.6,z:0},links:[measured.id]};
    const moving=h.engine.move(next,"visual",undefined,{fromYaw:Math.PI/2,toYaw:-Math.PI/2});await h.success(next.preview);await h.tick();assert.equal(h.canvas.dataset.motionMode,"depth");await h.finish();assert.equal(await moving,true);
    assert.ok(h.spatial.surfacePoint(measured,0,-.5));
  }finally{h.engine.dispose();}
});

test("disposing an active display transition removes both backgrounds and depth meshes",async()=>{
  const h=harness();try{
    const a={...scene("dispose-a"),links:["dispose-b"],displayDepth:displayDepth()},b={...scene("dispose-b",2),links:[a.id],displayDepth:displayDepth()};
    await initial(h,a);const moving=h.engine.move(b,"visual",undefined,{fromYaw:Math.PI/2,toYaw:-Math.PI/2});await h.success(b.preview);await h.tick();assert.equal(h.canvas.dataset.motionMode,"display-depth");
    const entries=[h.engine.cache.get(a.id),h.engine.cache.get(b.id)],resources=entries.flatMap(entry=>[entry.mesh.geometry,entry.mesh.material,entry.displayMesh.geometry,entry.displayMesh.material,entry.texture]),counts=resources.map(()=>0);
    resources.forEach((resource,index)=>resource.addEventListener("dispose",()=>counts[index]++));h.engine.dispose();assert.equal(await moving,false);assert.ok(counts.every(count=>count===1));assert.equal(h.engine.world.children.length,0);assert.equal(h.engine.cache.size,0);
  }finally{h.engine.dispose();}
});

test("a failed initial GPU upload releases display resources instead of leaving a cached partial scene",async()=>{
  const h=harness();try{
    h.engine.renderer.initTexture=()=>{throw new Error("GPU upload failed");};
    const moving=h.engine.move({...scene("gpu-error"),displayDepth:displayDepth()},false),rejected=assert.rejects(moving,/GPU upload failed/);
    await h.success("/gpu-error.lite");await rejected;assert.equal(h.engine.world.children.length,0);assert.equal(h.engine.cache.size,0);assert.equal(h.engine.busy,false);assert.equal(h.images[0].src,"");
  }finally{h.engine.dispose();}
});


test("prefetched decode completion cannot build or upload a neighbour during a visible step",async()=>{
  const h=harness();
  try{
    const a=scene("schedule-a"),b=scene("schedule-b",1),c=scene("schedule-c",2);await initial(h,a);
    const moving=h.engine.move(b);await h.success(b.preview);assert.ok(h.engine.tween);
    h.engine.prefetch([c]);const before=h.uploads.length;await h.success(c.preview);
    assert.equal(h.uploads.length,before);assert.equal(h.engine.cache.has(c.id),false);assert.equal(h.engine.preparations.size,1);
    await h.tick(32);assert.equal(h.uploads.length,before);assert.ok(h.engine.tween);
    await h.finish();assert.equal(await moving,true);assert.equal(h.engine.cache.has(c.id),true);assert.equal(h.engine.preparations.size,0);
  }finally{h.engine.dispose();}
});

test("deferred prefetch can become the next destination without waiting for unrelated idle work",async()=>{
  const h=harness();
  try{
    const a=scene("priority-a"),b=scene("priority-b",1);await initial(h,a);
    h.engine.addLook(.8,.1);h.engine.prefetch([b]);await h.success(b.preview);assert.equal(h.engine.cache.has(b.id),false);
    const move=h.engine.move(b);await h.tick();assert.ok(h.engine.tween);await h.finish();assert.equal(await move,true);
  }finally{h.engine.dispose();}
});

test("large quality upload waits until camera dragging settles and cancels cleanly on disposal",async()=>{
  const h=harness();
  try{
    h.canvas.clientWidth=1200;const a=scene("upgrade-drag");await initial(h,a);
    h.engine.addLook(.9,.1);const before=h.uploads.length;await h.success(a.image,4096,2048);
    assert.equal(h.uploads.length,before);assert.equal(h.engine.cache.get(a.id).quality,"preview");assert.equal(h.engine.preparations.size,1);
    h.engine.dispose();await h.settle();assert.equal(h.engine.preparations.size,0);assert.ok(h.images.every(image=>!image.src));
  }finally{h.engine.dispose();}
});

test("bitmap decode keeps panorama orientation, counts pixel memory and closes decoded resources",async()=>{
  const h=harness({bitmap:true});
  try{
    const a=scene("bitmap-a");const moving=h.engine.move(a,false);await h.settle();
    assert.equal(h.uploads.length,0,"upload waits for decoded pixels");assert.equal(h.bitmapRequests[0].options.imageOrientation,"flipY");
    await h.success(a.preview);assert.equal(await moving,true);const entry=h.engine.cache.get(a.id);
    assert.equal(entry.texture.flipY,false);assert.equal(entry.bytes,2048*1024*4);assert.equal(h.canvas.dataset.textureWidth,"2048");
    h.engine.dispose();assert.equal(h.bitmaps[0].closed,1);
  }finally{h.engine.dispose();}
});

test("bitmap that completes after cancellation is closed and cannot replace the current frame",async()=>{
  const h=harness({bitmap:true});
  try{
    const a=scene("bitmap-cancel-a"),b=scene("bitmap-cancel-b",1);await initial(h,a);
    const moving=h.engine.move(b);await h.settle();h.engine.cancelPendingLoad();await h.success(b.preview);
    assert.equal(await moving,false);assert.equal(h.bitmaps.at(-1).closed,1);assert.equal(h.canvas.dataset.sceneId,a.id);
  }finally{h.engine.dispose();}
});



test("arrival waits for uploaded 4K destination while source stays visible and look remains responsive",async()=>{
 const h=harness();try{h.canvas.clientWidth=1200;h.canvas.clientHeight=800;const a=scene("ready-a"),b=scene("ready-b",2);await initial(h,a);const moving=h.engine.move(b);await h.settle();
 assert.ok(h.images.some(i=>i.src===b.image));assert.ok(!h.images.some(i=>i.src===b.preview));assert.equal(h.engine.tween,null);assert.equal(h.canvas.dataset.sceneId,a.id);assert.ok(h.engine.cache.get(a.id).mesh.visible);
 const oldYaw=h.engine.yaw;h.engine.addLook(.2,0);await h.tick();assert.ok(h.engine.yaw>oldYaw);
 await h.success(b.image,4096,2048);assert.ok(h.engine.tween);assert.equal(h.engine.tween.b.quality,"image");await h.finish();assert.equal(await moving,true);assert.equal(h.canvas.dataset.textureWidth,"4096");assert.equal(h.engine.upgrades.has(b.id),false);
 }finally{h.engine.dispose();}
});

test("ready neighbour is reused without network or late automatic tier replacement",async()=>{
 const h=harness();try{h.canvas.clientWidth=1200;h.canvas.clientHeight=800;const a=scene("prefetch-ready-a"),b=scene("prefetch-ready-b",2);await initial(h,a);h.engine.prefetch([b]);await h.success(b.image,4096,2048);const requests=h.images.length;
 const moving=h.engine.move(b);await h.settle();assert.ok(h.engine.tween);await h.finish();assert.equal(await moving,true);assert.equal(h.images.length,requests);assert.equal(h.engine.cache.get(b.id).quality,"image");
 }finally{h.engine.dispose();}
});

test("failed arrival quality falls back once without exposing a blank frame or retry loop",async()=>{
 const h=harness();try{h.canvas.clientWidth=1200;const a=scene("ready-fail-a"),b=scene("ready-fail-b",2);await initial(h,a);const moving=h.engine.move(b);h.images.find(i=>i.src===b.image).onerror();await h.settle();assert.equal(h.canvas.dataset.sceneId,a.id);await h.success(b.preview);await h.finish();assert.equal(await moving,true);assert.equal(h.engine.cache.get(b.id).quality,"preview");assert.equal(h.images.filter(i=>i.requestedSrc===b.image).length,1);
 }finally{h.engine.dispose();}
});

test("mobile bitmap arrival uses bounded 3K decode and counts in-flight neighbour reservations",async()=>{
 const h=harness({bitmap:true,coarse:true});try{h.canvas.clientWidth=390;h.canvas.clientHeight=844;const a=scene("mobile-ready-a"),b=scene("mobile-ready-b",2);await initial(h,a);await h.success(a.image,4096,2048);assert.equal(h.engine.cache.get(a.id).bytes,3072*1536*4);
 const moving=h.engine.move(b);await h.settle();const decode=h.bitmapRequests.find(r=>r.url===b.image);assert.equal(decode.options.resizeWidth,3072);assert.ok(h.engine.cachedBytes()+h.engine.reservedBytes()<=h.engine.memoryBudget);assert.equal(h.engine.tween,null);await h.success(b.image,4096,2048);await h.finish();assert.equal(await moving,true);assert.equal(h.canvas.dataset.textureWidth,"3072");assert.ok(h.engine.cachedBytes()<=h.engine.memoryBudget);
 }finally{h.engine.dispose();}
});


test('panorama viewport cannot reveal the tripod when dragging or zooming out',async()=>{
 const h=harness();
 try{for(const fov of [40,74,95]){h.engine.fov=fov;h.engine.pitch=-Math.PI/2;h.engine.addLook(0,-10);await h.finish();assert.ok(h.engine.pitch*180/Math.PI-h.engine.fov/2>=-65-1e-8);}}
 finally{h.engine.dispose();}
});
