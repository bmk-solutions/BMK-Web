import * as THREE from "three";
import {PanoramaBlobCache} from './PanoramaBlobCache';
import type { Plan, Point, Scene } from "@/lib/imo3d/model";
import type { NavigationBearings } from "@/lib/imo3d/navigation";
import { angleDifference,radians, sampleDepth, worldRay } from "@/lib/imo3d/spatial";
import { displayDepthTriangle,displayViewPosition,motionDuration, motionProgress, motionMode, planWallDistances, proxyRadius, proxyViewPosition, rayWallDistance, smoothstep,usableDisplayDepth, type MotionMode } from "./PanoramaMotion";
import { desiredPanoramaWidth, panoramaArrivalCandidate, panoramaDisplayPolicy, panoramaQualityCandidate, type PanoramaDisplayPolicy, type PanoramaQuality } from "./PanoramaQuality";

type Entry = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  displayMesh?:THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>;geometryBytes:number;
  texture: THREE.Texture; bytes: number; quality: PanoramaQuality; readinessWidth:number; failedUpgrades: Set<string>;
};
type Pending = { promise: Promise<Entry>; abort: AbortController;bytes:number };
type MoveAnimation=boolean|"handover"|"visual";
type MoveRequest = { scene: Scene; animate: MoveAnimation; arrivalYaw?:number; bearings?:NavigationBearings; resolve: (moved: boolean) => void; reject: (error: unknown) => void };
const cancelled = () => new DOMException("Panorama load cancelled", "AbortError");
const isCancelled = (error: unknown) => error instanceof Error && error.name === "AbortError";

export class PanoramaEngine {
  readonly renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(74, 1, 0.03, 120);
  private world = new THREE.Scene();
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private upgrades = new Map<string, { abort: AbortController; bytes: number }>();
  private preparations = new Set<{sceneId?:string;signal:AbortSignal;ready:()=>void;abort:()=>void}>();
  private current: Scene | null = null;
  private loadingDestination: Scene | null = null;
  private loadingCancelled = false;
  private queued: MoveRequest | null = null;
  private processing = false;
  private frame = 0;
  private destroyed = false;
  private dirty = true;
  private lastView = "";
  private lastFrame = 0;
  private memoryBudget = 96 * 1024 * 1024;
  private displayPolicy: PanoramaDisplayPolicy;
  private pixelRatio = 1;
  private lookRemaining = { yaw: 0, pitch: 0 };
  private tween: {
    from: Scene; to: Scene; a: Entry; b: Entry; mode: MotionMode;
    start: number; duration: number; yawDelta:number; yawProgress:number; bearings?:NavigationBearings; resolve: () => void;
  } | null = null;
  private renderA = new THREE.WebGLRenderTarget(1, 1);
  private renderB = new THREE.WebGLRenderTarget(1, 1);
  private blendWorld = new THREE.Scene();
  private blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blendMaterial = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { first: { value: this.renderA.texture }, second: { value: this.renderB.texture }, amount: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader: "uniform sampler2D first;uniform sampler2D second;uniform float amount;varying vec2 vUv;void main(){gl_FragColor=mix(texture2D(first,vUv),texture2D(second,vUv),amount);\n#include <colorspace_fragment>\n}",
  });
  private blendQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMaterial);
  private cursorWorld = new THREE.Scene();
  private cursorMaterial = new THREE.ShaderMaterial({
    uniforms:{measuring:{value:0}},
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: `varying vec2 vUv;uniform float measuring;
      void main(){
        vec2 p=vUv-.5;
        float radius=length(p)*2.;
        float edge=max(fwidth(radius),.012);
        float disc=1.-smoothstep(.69,.72+edge,radius);
        float ring=1.-smoothstep(.035,.035+edge,abs(radius-.72));
        float crosshair=max((1.-smoothstep(.012,.02,abs(p.x)))*(1.-smoothstep(.2,.23,abs(p.y))),
                            (1.-smoothstep(.012,.02,abs(p.y)))*(1.-smoothstep(.2,.23,abs(p.x))));
        float alpha=mix(disc*.64,max(ring*.95,crosshair*.95),measuring);
        if(alpha<.005)discard;
        gl_FragColor=vec4(mix(vec3(.27,.96,.12),vec3(1.),measuring),alpha);
        #include <colorspace_fragment>
      }`,
  });
  private cursorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1,1),this.cursorMaterial);
  private cursorRay = new THREE.Raycaster();
  private cursorUp = new THREE.Vector3(0,1,0);
  private cursorNormal = new THREE.Vector3(0,0,1);
  private cursorKey = "";
  private cursorInputKey = "";
  yaw = 0;
  pitch = 0;
  fov = 74;
  busy = false;
  onLoading?: (loading: boolean) => void;
  onView?: (yaw: number, pitch: number, position: Point) => void;
  onError?: (message: string) => void;

  private blobs=new PanoramaBlobCache(24*1024*1024);
  constructor(private canvas: HTMLCanvasElement, private options: { plans?: Plan[];resolveAsset?:(url:string)=>string } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.pixelRatio=Math.min(window.devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x11151a);
    const deviceMemory=typeof navigator==="undefined"?undefined:(navigator as Navigator&{deviceMemory?:number}).deviceMemory;
    this.displayPolicy=panoramaDisplayPolicy(window.matchMedia("(pointer: coarse)").matches,this.renderer.capabilities.maxTextureSize,deviceMemory);
    this.memoryBudget=this.displayPolicy.memoryBudget;
    this.blendWorld.add(this.blendQuad);
    this.cursorMesh.visible=false; this.cursorWorld.add(this.cursorMesh);
    this.canvas.addEventListener("webglcontextlost", this.contextLost);
    this.canvas.addEventListener("webglcontextrestored", this.contextRestored);
    this.frame = requestAnimationFrame(this.draw);
  }

  private contextLost = (event: Event) => {
    event.preventDefault(); this.onError?.("توقف عرض الرسوم. أعد تحميل الجولة لاستعادته.");
  };
  private contextRestored = () => this.onError?.("تمت استعادة الرسوم. أعد تحميل الجولة.");

  resize(width: number, height: number) {
    if (!width || !height || this.destroyed) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.renderA.setSize(size.x, size.y); this.renderB.setSize(size.x, size.y);
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  addLook(deltaYaw: number, deltaPitch: number) {
    this.lookRemaining.yaw += deltaYaw;
    this.lookRemaining.pitch = Math.max(-1.4,Math.min(1.4,this.pitch+this.lookRemaining.pitch+deltaPitch))-this.pitch;
    this.dirty = true;
  }

  /** Keep the currently displayed direction when an author confirms a bearing. */
  stopLook() { this.lookRemaining.yaw=0;this.lookRemaining.pitch=0; }

  private geometry(scene: Scene,displayOnly=false) {
    const display=usableDisplayDepth(scene),depth=displayOnly?display:scene.depth;
    const width = depth ? Math.min(depth.width, 256) : 128;
    const height = depth ? Math.min(depth.height, 128) : 64;
    const walls=!scene.depth&&!display ? this.options.plans?.find(plan=>plan.floor===scene.floor&&plan.walls.length&&!plan.authoredRooms?.length&&!plan.generatedRooms?.length&&!plan.generatedFrom)?.walls : undefined;
    const wallDistances=walls ? planWallDistances(scene,walls,width) : [];
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [], depths: number[] = [];
    const gridFaces=new Uint8Array(width*height);
    for (let y=0; y<=height; y++) for (let x=0; x<=width; x++) {
      const u=x/width, v=y/height, localYaw=(u-0.5)*2*Math.PI, pitch=(0.5-v)*Math.PI;
      const d=depth ? sampleDepth(depth,localYaw,pitch) : display?50:proxyRadius(pitch,wallDistances[x]);
      depths.push(d);
      const direction=worldRay(localYaw+radians(scene.yaw),pitch), radius=d>0.02 ? d : 50;
      positions.push(direction.x*radius,direction.y*radius,direction.z*radius); uvs.push(u,1-v);
    }
    const add = (a: number, b: number, c: number) => {
      if(displayOnly){if(!displayDepthTriangle(depths[a],depths[b],depths[c]))return false;}
      else if (scene.depth) {
        const near=Math.min(depths[a],depths[b],depths[c]), far=Math.max(depths[a],depths[b],depths[c]);
        if (near<0.03 || far-near>Math.max(0.5,near*0.22)) return false;
      }
      indices.push(a,b,c);return true;
    };
    for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
      const a=y*(width+1)+x, b=a+width+1;
      gridFaces[y*width+x]=(add(a,b,a+1)?1:0)|(add(a+1,b,b+1)?2:0);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2)); geometry.setIndex(indices);
    geometry.userData.planProxy=wallDistances.some(distance=>distance!==null);
    geometry.userData.displayOnly=displayOnly;
    geometry.userData.displayCoverage=displayOnly?indices.length/(width*height*6):0;
    geometry.userData.panoramaGrid={width,height,faces:gridFaces};
    return geometry;
  }

  /** Background decode completions must not steal a frame from walking or dragging. */
  private preparationAllowed(sceneId?:string) {
    const destination=sceneId!==undefined&&this.loadingDestination?.id===sceneId;
    return !this.tween && (!this.busy || destination) &&
      (destination || Math.abs(this.lookRemaining.yaw)+Math.abs(this.lookRemaining.pitch)<.0001);
  }

  private waitForPreparation(signal:AbortSignal,sceneId?:string):Promise<void> {
    if(signal.aborted||this.destroyed)return Promise.reject(cancelled());
    if(this.preparationAllowed(sceneId))return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const job={sceneId,signal,ready:()=>{this.preparations.delete(job);signal.removeEventListener("abort",job.abort);resolve();},
        abort:()=>{this.preparations.delete(job);signal.removeEventListener("abort",job.abort);reject(cancelled());}};
      this.preparations.add(job);signal.addEventListener("abort",job.abort,{once:true});
    });
  }

  private textureSize(texture:THREE.Texture) {
    const image=texture.image as HTMLImageElement|ImageBitmap;
    return {width:"naturalWidth" in image?image.naturalWidth:image.width,height:"naturalHeight" in image?image.naturalHeight:image.height};
  }

  /** ImageBitmap decodes before WebGL sees the source, avoiding upload-time decode. */
  private async bitmapTexture(url:string,signal:AbortSignal,resizeWidth?:number):Promise<THREE.Texture> {
    const abort=new AbortController(),cancel=()=>abort.abort();signal.addEventListener("abort",cancel,{once:true});
    const timer=window.setTimeout(()=>abort.abort(),20000);
    try {
      if(signal.aborted||this.destroyed)throw cancelled();
      let blob=this.blobs.get(url);
      if(!blob){
        const resolved=this.options.resolveAsset?.(url)??url;
        let response:Response;
        try{response=await fetch(resolved,{signal:abort.signal,credentials:"same-origin"});}
        catch(error){if(resolved===url||abort.signal.aborted)throw error;response=await fetch(url,{signal:abort.signal,credentials:"same-origin"});}
        if(!response.ok&&resolved!==url)response=await fetch(url,{signal:abort.signal,credentials:"same-origin"});
        if(!response.ok)throw new Error("تعذر تحميل صورة الجولة.");
        blob=await response.blob();
        if(!signal.aborted&&!this.destroyed)this.blobs.set(url,blob);
      }
      if(signal.aborted||this.destroyed)throw cancelled();
      // ImageBitmap ignores Texture.flipY; apply the panorama's flip at decode.
      const decoding=createImageBitmap(blob,{imageOrientation:"flipY",premultiplyAlpha:"none",colorSpaceConversion:"none",...(resizeWidth?{resizeWidth,resizeHeight:resizeWidth/2,resizeQuality:"high" as const}:{})});
      const bitmap=await new Promise<ImageBitmap>((resolve,reject)=>{
        const stop=()=>reject(cancelled());abort.signal.addEventListener("abort",stop,{once:true});
        decoding.then(value=>{
          abort.signal.removeEventListener("abort",stop);
          if(abort.signal.aborted||this.destroyed){value.close();reject(cancelled());}else resolve(value);
        },error=>{abort.signal.removeEventListener("abort",stop);reject(error);});
        if(abort.signal.aborted)stop();
      });
      if(signal.aborted||abort.signal.aborted||this.destroyed){bitmap.close();throw cancelled();}
      const texture=new THREE.Texture(bitmap);texture.flipY=false;
      texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
      texture.generateMipmaps=false;texture.needsUpdate=true;return texture;
    } finally {clearTimeout(timer);signal.removeEventListener("abort",cancel);}
  }

  /** Image requests have a real cancellation path and always settle on disposal. */
  private texture(url: string, signal: AbortSignal,resizeWidth?:number): Promise<THREE.Texture> {
    if(typeof createImageBitmap==="function"&&typeof fetch==="function")return this.bitmapTexture(url,signal,resizeWidth);
    return new Promise((resolve,reject) => {
      const image = new Image(); image.decoding = "async";image.crossOrigin="anonymous";
      const cleanup = () => {
        clearTimeout(timer); image.onload=null; image.onerror=null; signal.removeEventListener("abort",abort);
      };
      const abort = () => { cleanup(); image.removeAttribute("src"); reject(cancelled()); };
      const timer = window.setTimeout(() => {
        cleanup(); image.removeAttribute("src"); reject(new Error("استغرق تحميل صورة الجولة وقتًا طويلًا. حاول مجددًا."));
      },20000);
      image.onload = async () => {
        try { if(image.decode)await image.decode(); }
        catch { cleanup();image.removeAttribute("src");reject(signal.aborted?cancelled():new Error("تعذر فك صورة الجولة."));return; }
        cleanup();
        if (signal.aborted || this.destroyed) { image.removeAttribute("src"); reject(cancelled()); return; }
        const texture = new THREE.Texture(image);
        texture.colorSpace=THREE.SRGBColorSpace; texture.minFilter=THREE.LinearFilter;
        texture.magFilter=THREE.LinearFilter; texture.generateMipmaps=false; texture.needsUpdate=true;
        resolve(texture);
      };
      image.onerror = () => { cleanup(); image.removeAttribute("src"); reject(new Error("تعذر تحميل صورة الجولة. تحقق من الاتصال وحاول مجددًا.")); };
      signal.addEventListener("abort",abort,{once:true});
      if (signal.aborted) abort(); else image.src=this.options.resolveAsset?.(url)??url;
    });
  }

  private textureBytes(texture: THREE.Texture) {
    const image = this.textureSize(texture);
    return image.width*image.height*4;
  }

  private releaseTexture(texture: THREE.Texture) {
    texture.dispose(); const image=texture.image as (HTMLImageElement&{close?:()=>void})|undefined;image?.close?.();image?.removeAttribute?.("src");
  }

  private load(scene: Scene): Promise<Entry> {
    const desired=desiredPanoramaWidth(this.canvas.clientWidth,this.canvas.clientHeight,this.fov,this.pixelRatio);
    const arrival=this.current!==null&&scene.id!==this.current.id;
    const pinnedBytes=[...this.cache.entries()].filter(([id])=>this.protectedIds().has(id)).reduce((sum,[,entry])=>sum+entry.bytes+entry.geometryBytes,0);
    const candidate=arrival?panoramaArrivalCandidate(scene,this.displayPolicy,desired,this.memoryBudget-pinnedBytes-this.reservedBytes(),typeof createImageBitmap==="function"):null;
    if (this.destroyed) return Promise.reject(cancelled());
    let cached = this.cache.get(scene.id);
    if(cached&&candidate?.quality==="image"&&cached.quality==="preview"&&cached.readinessWidth<desired){this.cache.delete(scene.id);this.release(cached);cached=undefined;}
    if (cached) { this.cache.delete(scene.id); this.cache.set(scene.id,cached); return Promise.resolve(cached); }
    const existing = this.pending.get(scene.id);
    if (existing && !existing.abort.signal.aborted) return existing.promise;
    const abort = new AbortController();
    if(this.loadingDestination?.id===scene.id)this.onLoading?.(true);
    let arrivalQuality:PanoramaQuality=candidate?.quality??"preview";
    const promise = this.texture(candidate?.url??scene.preview,abort.signal,candidate?.quality==="image"?candidate.width:undefined).catch(error=>{
      if(!candidate||candidate.quality==="preview"||isCancelled(error))throw error;
      arrivalQuality="preview";return this.texture(scene.preview,abort.signal);
    }).then(async texture => {
      try{await this.waitForPreparation(abort.signal,scene.id);}catch(error){this.releaseTexture(texture);throw error;}
      if (this.destroyed || abort.signal.aborted) { this.releaseTexture(texture); throw cancelled(); }
      const display=usableDisplayDepth(scene);
      const material = new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,depthTest:!display,depthWrite:!display});
      const mesh = new THREE.Mesh(this.geometry(scene),material);
      const p = scene.position ?? {x:0,y:0,z:0};
      mesh.position.set(p.x,p.y,p.z); mesh.visible=false;
      const displayGeometry=display?this.geometry(scene,true):undefined;
      const displayMesh=displayGeometry&&displayGeometry.userData.displayCoverage>=.5?new THREE.Mesh(displayGeometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,depthTest:true,depthWrite:true})):undefined;
      if(displayGeometry&&!displayMesh)displayGeometry.dispose();
      if(displayMesh){displayMesh.position.copy(mesh.position);displayMesh.visible=false;mesh.renderOrder=-1;this.world.add(displayMesh);}
      const geometryBytes=[mesh,displayMesh].reduce((sum,item)=>sum+(item?Object.values(item.geometry.attributes).reduce((total,attribute)=>total+attribute.array.byteLength,0)+(item.geometry.index?.array.byteLength??0):0),0);
      const entry:Entry = {mesh,displayMesh,geometryBytes,texture,bytes:this.textureBytes(texture),quality:arrivalQuality,readinessWidth:arrival?desired:0,failedUpgrades:new Set<string>()};
      const reservation=this.pending.get(scene.id);if(reservation?.abort===abort)reservation.bytes=0;
      this.cache.set(scene.id,entry); this.world.add(mesh);
      // Upload before starting a transition, including prefetched neighbours.
      try{this.renderer.initTexture(texture);}catch(error){this.cache.delete(scene.id);this.release(entry);throw error;}
      this.trim(); return entry;
    }).finally(() => {
      if (this.pending.get(scene.id)?.abort===abort) this.pending.delete(scene.id);
    });
    this.pending.set(scene.id,{promise,abort,bytes:candidate?.bytes??2048*1024*4}); return promise;
  }

  private improve(scene: Scene) {
    const entry = this.cache.get(scene.id);
    if (!entry || this.destroyed || this.current?.id!==scene.id || this.tween || this.queued || this.upgrades.has(scene.id)) return;
    const desired=desiredPanoramaWidth(this.canvas.clientWidth,this.canvas.clientHeight,this.fov,this.pixelRatio);
    if(desired<=entry.readinessWidth*1.08)return;
    const candidate=panoramaQualityCandidate(scene,entry.quality,entry.failedUpgrades,this.displayPolicy,desired);
    if(!candidate)return;
    const resizeWidth=candidate.quality==="image"&&typeof createImageBitmap==="function"?this.displayPolicy.arrivalMaxWidth:undefined;
    const abort = new AbortController(),upgrade={abort,bytes:resizeWidth?resizeWidth*resizeWidth*2:candidate.bytes}; this.upgrades.set(scene.id,upgrade);
    // Reserve decoded incoming bytes while the currently visible texture remains
    // resident. Prefetch completions count this reservation in their own trim.
    this.trim();
    if(this.cachedBytes()+this.reservedBytes()>this.memoryBudget){this.upgrades.delete(scene.id);return;}
    void this.texture(candidate.url,abort.signal,resizeWidth).then(async texture => {
      try{await this.waitForPreparation(abort.signal);}catch(error){this.releaseTexture(texture);throw error;}
      if (this.destroyed || abort.signal.aborted || this.cache.get(scene.id)!==entry) { this.releaseTexture(texture); return; }
      const image=this.textureSize(texture);
      upgrade.bytes=this.textureBytes(texture);this.trim();
      if(image.width>this.displayPolicy.maxTextureSize||image.height>this.displayPolicy.maxTextureSize||
        this.cachedBytes()+this.reservedBytes()>this.memoryBudget){
        this.releaseTexture(texture);entry.failedUpgrades.add(candidate.url);return;
      }
      try{this.renderer.initTexture(texture);}catch(error){this.releaseTexture(texture);throw error;}
      const previous=entry.texture;
      entry.texture=texture; entry.bytes=upgrade.bytes; entry.quality=candidate.quality;upgrade.bytes=0;
      entry.mesh.material.map=texture; entry.mesh.material.needsUpdate=true;
      if(entry.displayMesh){entry.displayMesh.material.map=texture;entry.displayMesh.material.needsUpdate=true;}
      this.releaseTexture(previous); this.trim(); this.dirty=true;
      if(this.current?.id===scene.id)this.canvas.dataset.textureWidth=String(image.width);
    }).catch(error => {
      // A failed detail tier falls back to the usable 4K tier, never an error
      // overlay or an endless retry. Navigation cancellation may retry later.
      if(!isCancelled(error))entry.failedUpgrades.add(candidate.url);
    }).finally(() => {
      if (this.upgrades.get(scene.id)===upgrade)this.upgrades.delete(scene.id);
      if(!this.destroyed&&this.current?.id===scene.id&&!this.loadingDestination&&!this.tween&&!abort.signal.aborted)this.improve(scene);
    });
  }

  /** Finish the visible step; retain only the latest subsequent destination. */
  move(to: Scene, animate: MoveAnimation=true,arrivalYaw?:number,bearings?:NavigationBearings): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);
    this.clearNavigationCursor();
    return new Promise((resolve,reject) => {
      this.queued?.resolve(false); this.queued={scene:to,animate,arrivalYaw:Number.isFinite(arrivalYaw)?arrivalYaw:undefined,
        bearings:bearings&&Number.isFinite(bearings.fromYaw)&&Number.isFinite(bearings.toYaw)?{...bearings}:undefined,resolve,reject}; this.busy=true;
      if (this.loadingDestination && !this.tween && this.loadingDestination.id!==to.id) {
        this.pending.get(this.loadingDestination.id)?.abort.abort();
      }
      void this.drainMoves();
    });
  }

  /** Cancel a superseded destination while its frame is still loading. */
  cancelPendingLoad() {
    if (this.destroyed || !this.loadingDestination || this.tween) return false;
    this.loadingCancelled=true;
    this.pending.get(this.loadingDestination.id)?.abort.abort();
    return true;
  }

  private async drainMoves() {
    if (this.processing) return;
    this.processing=true;
    try {
      while (this.queued && !this.destroyed) {
        const request=this.queued; this.queued=null;
        try { request.resolve(await this.performMove(request.scene,request.animate,request.arrivalYaw,request.bearings)); }
        catch (error) { if (isCancelled(error)) request.resolve(false); else request.reject(error); }
      }
    } finally { this.processing=false; this.busy=false; this.onLoading?.(false); }
  }

  private async performMove(to: Scene, animate: MoveAnimation,arrivalYaw?:number,bearings?:NavigationBearings) {
    if (to.id===this.current?.id) return true;
    // Defer large texture uploads until movement ends so they cannot stall a step.
    for (const upgrade of this.upgrades.values()) upgrade.abort.abort(); this.upgrades.clear();
    this.loadingDestination=to; this.loadingCancelled=false; this.onLoading?.(!this.cache.has(to.id));
    try {
      const entry=await this.load(to);
      if (this.destroyed || this.loadingCancelled || (this.queued && this.queued.scene.id!==to.id)) return false;
      this.onLoading?.(false);
      const from=this.current, source=from ? this.cache.get(from.id) : undefined;
      const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const visual=animate==="visual"&&bearings&&from&&from.floor===to.floor&&
        ((from.links.includes(to.id)&&to.links.includes(from.id))||(source?.displayMesh&&entry.displayMesh))&&
        !from.blockedLinks?.includes(to.id)&&!to.blockedLinks?.includes(from.id);
      // Bearings define the calibration change, independent of where the user
      // looked while the next image loaded. Preserve that latest look direction.
      const yawDelta=visual?angleDifference(bearings!.toYaw+Math.PI,bearings!.fromYaw):arrivalYaw===undefined?0:angleDifference(arrivalYaw,this.yaw);
      if (from && source && animate && !reduced) {
        await new Promise<void>(resolve => {
          const mode = visual
            ? (from.depth&&to.depth&&from.position&&to.position ? "depth" : source.displayMesh&&entry.displayMesh ? "display-depth" : "aligned-dissolve")
            : animate==="handover" || animate==="visual" ? "dissolve" : motionMode(from, to);
          this.tween={from,to,a:source,b:entry,mode,start:performance.now(),duration:motionDuration(from,to,mode),yawDelta,yawProgress:0,bearings:visual?bearings:undefined,resolve};
          this.canvas.dataset.motionMode=mode; this.dirty=true;
        });
      } else {
        this.canvas.dataset.motionMode=reduced ? "reduced" : "stationary";
        for (const value of this.cache.values()) this.setEntryVisible(value,false);
        this.setEntryVisible(entry,true);
        const p=to.position ?? {x:0,y:0,z:0}; this.camera.position.set(p.x,p.y,p.z);
        if (!from) this.yaw=radians(to.yaw);
        if(visual)this.yaw+=yawDelta;else if(arrivalYaw!==undefined)this.yaw=arrivalYaw;
      }
      if (this.destroyed) return false;
      this.current=to; this.canvas.dataset.sceneId=to.id; this.canvas.dataset.transitionProgress="1";
      this.canvas.dataset.textureWidth=String(this.textureSize(entry.texture).width);
      this.dirty=true; this.improve(to); return true;
    } finally { this.loadingDestination=null; this.trim(); }
  }

  prefetch(scenes: Scene[]) {
    if (this.destroyed) return;
    const selected=[...new Map(scenes.map(scene=>[scene.id,scene])).values()]
      .filter(scene=>scene.id!==this.current?.id).slice(0,2);
    const wanted=new Set([...this.protectedIds(),...selected.map(scene=>scene.id)]);
    for (const [id,request] of this.pending) if (!wanted.has(id)) request.abort.abort();
    for (const scene of selected) void this.load(scene).then(()=>this.trim()).catch(()=>{});
  }

  private protectedIds() {
    return new Set([this.current?.id,this.loadingDestination?.id,this.queued?.scene.id,this.tween?.from.id,this.tween?.to.id]);
  }

  private release(entry: Entry) {
    if(entry.displayMesh){this.world.remove(entry.displayMesh);entry.displayMesh.geometry.dispose();entry.displayMesh.material.dispose();}
    this.world.remove(entry.mesh); entry.mesh.geometry.dispose(); entry.mesh.material.dispose(); this.releaseTexture(entry.texture);
  }

  private setEntryVisible(entry:Entry,visible:boolean,display=false){entry.mesh.visible=visible;if(entry.displayMesh)entry.displayMesh.visible=visible&&display;}
  private cachedBytes(){return [...this.cache.values()].reduce((sum,entry)=>sum+entry.bytes+entry.geometryBytes,0);}
  private reservedBytes(){return [...this.upgrades.values()].reduce((sum,upgrade)=>sum+upgrade.bytes,0)+[...this.pending.values()].reduce((sum,request)=>sum+request.bytes,0);}

  private trim() {
    const protectedIds=this.protectedIds();
    let bytes=this.cachedBytes()+this.reservedBytes();
    for (const [id,entry] of this.cache) {
      if (this.cache.size<=5 && bytes<=this.memoryBudget) break;
      if (protectedIds.has(id)) continue;
      this.upgrades.get(id)?.abort.abort(); this.upgrades.delete(id);
      bytes-=entry.bytes+entry.geometryBytes; this.release(entry); this.cache.delete(id);
    }
    for (const [id,upgrade] of this.upgrades) if (!protectedIds.has(id)) { upgrade.abort.abort(); this.upgrades.delete(id); }
  }

  rayAt(x: number, y: number): { yaw: number; pitch: number } {
    this.camera.updateMatrixWorld();
    const ray=new THREE.Vector3(x,y,0.5).unproject(this.camera).sub(this.camera.position).normalize();
    return {yaw:Math.atan2(ray.x,-ray.z),pitch:Math.asin(ray.y)};
  }

  /** Transient surface cursor; estimated display surfaces never become metric evidence. */
  setNavigationCursor(x: number, y: number, destination: Scene | null,measuring=false): boolean {
    if(this.destroyed||this.busy||!this.current||(!measuring&&(!destination||destination.floor!==this.current.floor||destination.id===this.current.id||this.current.blockedLinks?.includes(destination.id)||destination.blockedLinks?.includes(this.current.id)))||!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>1||Math.abs(y)>1){this.clearNavigationCursor();return false;}
    const inputKey=`${this.current.id}/${destination?.id??"measure"}/${measuring}/${x}/${y}/${this.yaw}/${this.pitch}/${this.fov}/${this.camera.aspect}`;
    if(this.cursorMesh.visible&&this.cursorInputKey===inputKey)return true;
    this.camera.updateMatrixWorld();
    this.cursorRay.setFromCamera(new THREE.Vector2(x,y),this.camera);
    const ray=this.cursorRay.ray;
    let point:THREE.Vector3|null=null;
    const normal=this.cursorUp.clone(),entry=this.cache.get(this.current.id);
    if(entry&&(this.current.depth||entry.displayMesh)){
      const hit=this.cursorDepthHit(entry,this.current,ray);
      if(!hit){this.clearNavigationCursor();return false;}
      normal.copy(hit.normal);point=hit.point;
      // The marker identifies the pointed surface; destination selection remains separate.
    }else{
      if(measuring||ray.direction.y>-.06){this.clearNavigationCursor();return false;}
      // The same nominal eye height as the render proxy, not recovered floor geometry.
      const floor=(this.current.position?.y??this.camera.position.y)-1.6;
      const travel=(floor-ray.origin.y)/ray.direction.y;
      if(travel<=.15||travel>30){this.clearNavigationCursor();return false;}
      point=ray.at(travel,new THREE.Vector3());
      const walls=this.options.plans?.find(plan=>plan.floor===this.current!.floor&&plan.walls.length&&!plan.authoredRooms?.length&&!plan.generatedRooms?.length&&!plan.generatedFrom)?.walls;
      if(walls){
        const wall=rayWallDistance(ray.origin,Math.atan2(ray.direction.x,-ray.direction.z),walls);
        if(wall!==null&&wall<Math.hypot(point.x-ray.origin.x,point.z-ray.origin.z)-.06){this.clearNavigationCursor();return false;}
      }
    }
    const distance=point.distanceTo(this.camera.position);
    if(distance>30){this.clearNavigationCursor();return false;}
    // Bounded physical size retains perspective while remaining legible on a dense display.
    const size=Math.max(.18,Math.min(.52,distance*.075));
    this.cursorMaterial.uniforms.measuring.value=measuring?1:0;
    const key=`${destination?.id??"measure"}/${measuring}:${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}:${size.toFixed(4)}`;
    if(key!==this.cursorKey||!this.cursorMesh.visible){
      this.cursorKey=key;this.cursorMesh.position.copy(point).addScaledVector(normal,.008);
      this.cursorMesh.quaternion.setFromUnitVectors(this.cursorNormal,normal);
      this.cursorMesh.scale.setScalar(size);this.cursorMesh.visible=true;this.dirty=true;
    }
    this.cursorInputKey=inputKey;
    return true;
  }

  /** Exact mesh hits near the angular cell, avoiding a full depth-mesh scan on mousemove. */
  private cursorDepthHit(entry:Entry,scene:Scene,ray:THREE.Ray) {
    const mesh=scene.depth?entry.mesh:entry.displayMesh;if(!mesh)return null;
    const grid=mesh.geometry.userData.panoramaGrid as {width:number;height:number;faces:Uint8Array};
    const yaw=Math.atan2(ray.direction.x,-ray.direction.z)-radians(scene.yaw),pitch=Math.asin(ray.direction.y);
    const u=((.5+yaw/(2*Math.PI))%1+1)%1,v=Math.max(0,Math.min(1-1e-8,.5-pitch/Math.PI));
    const x=Math.floor(u*grid.width),y=Math.floor(v*grid.height);
    const localRay=new THREE.Ray(ray.origin.clone().sub(mesh.position),ray.direction);
    const positions=mesh.geometry.getAttribute("position");
    let nearest:{point:THREE.Vector3;normal:THREE.Vector3;distance:number}|null=null;
    const check=(i:number,j:number,k:number)=>{
      const p=new THREE.Vector3().fromBufferAttribute(positions,i),q=new THREE.Vector3().fromBufferAttribute(positions,j),r=new THREE.Vector3().fromBufferAttribute(positions,k);
      const hit=localRay.intersectTriangle(p,q,r,false,new THREE.Vector3());if(!hit)return;
      const distance=hit.distanceTo(localRay.origin);if(nearest&&nearest.distance<=distance)return;
      const normal=q.sub(p).cross(r.sub(p)).normalize();if(normal.dot(ray.direction)>0)normal.negate();
      nearest={point:hit.add(mesh.position),normal,distance};
    };
    // Latitude cell edges are tessellated chords, so test adjacent cells at their seams.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const gy=y+dy;if(gy<0||gy>=grid.height)continue;
      const gx=(x+dx+grid.width)%grid.width,flags=grid.faces[gy*grid.width+gx];
      const a=gy*(grid.width+1)+gx,b=a+grid.width+1;
      if(flags&1)check(a,b,a+1);if(flags&2)check(a+1,b,b+1);
    }
    return nearest as {point:THREE.Vector3;normal:THREE.Vector3;distance:number}|null;
  }

  clearNavigationCursor() {
    if(this.cursorMesh.visible){this.cursorMesh.visible=false;this.cursorKey="";this.cursorInputKey="";this.dirty=true;}
  }

  project(point: Point) {
    const v=new THREE.Vector3(point.x,point.y,point.z).project(this.camera);
    return {x:(v.x+1)/2*this.canvas.clientWidth,y:(1-v.y)/2*this.canvas.clientHeight,inFront:v.z<1&&v.z>-1,visible:v.z<1&&v.z>-1&&Math.abs(v.x)<1&&Math.abs(v.y)<1};
  }

  private lookAt(ray: Point) {
    this.camera.lookAt(this.camera.position.x+ray.x,this.camera.position.y+ray.y,this.camera.position.z+ray.z);
  }

  private renderTransitionEntry(entry: Entry, scene: Scene, position: Point, mode: MotionMode, target: THREE.WebGLRenderTarget, ray: Point) {
    const origin=scene.position ?? {x:0,y:0,z:0};
    // A floor proxy never flows into stored depth, measurement, path clearance,
    // or floor-plan construction. Only actual depth meshes use full translation.
    const isProxy=mode==="floor-proxy"||mode==="plan-proxy";
    const p=mode==="dissolve"||mode==="aligned-dissolve" ? origin : isProxy ? proxyViewPosition(origin,position,mode==="plan-proxy") : position;
    this.camera.position.set(p.x,p.y,p.z); this.lookAt(ray);
    // Keep the complete original panorama centered behind the partial estimated
    // mesh. Holes and rejected discontinuities reveal imagery, never empty space.
    if(mode==="display-depth")entry.mesh.position.set(p.x,p.y,p.z);
    this.setEntryVisible(entry,true,mode==="display-depth");
    this.renderer.setRenderTarget(target); this.renderer.render(this.world,this.camera);this.setEntryVisible(entry,false);
    entry.mesh.position.set(origin.x,origin.y,origin.z);
  }

  private draw = (now: number) => {
    if (this.destroyed) return;
    this.frame=requestAnimationFrame(this.draw);
    if (document.hidden) {
      if (this.tween && this.lastFrame) this.tween.start+=now-this.lastFrame;
      this.lastFrame=now; return;
    }
    for(const job of this.preparations){if(this.preparationAllowed(job.sceneId)){job.ready();break;}}
    const delta=this.lastFrame ? now-this.lastFrame : 16;
    if (this.tween && this.lastFrame && delta>100) this.tween.start+=delta-32;
    this.lastFrame=now;
    const lookWeight=1-Math.exp(-Math.min(delta,48)/42);
    if (Math.abs(this.lookRemaining.yaw)+Math.abs(this.lookRemaining.pitch)>0.00001) {
      this.yaw+=this.lookRemaining.yaw*lookWeight; this.pitch+=this.lookRemaining.pitch*lookWeight;
      this.lookRemaining.yaw*=1-lookWeight; this.lookRemaining.pitch*=1-lookWeight;
      this.dirty=true;
    }
    this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch)); this.fov=Math.max(40,Math.min(95,this.fov));
    const view=`${this.yaw},${this.pitch},${this.fov}`;
    if (!this.dirty && !this.tween && view===this.lastView) return;
    this.lastView=view; this.dirty=false;
    if (this.camera.fov!==this.fov) { this.camera.fov=this.fov; this.camera.updateProjectionMatrix(); }
    if(this.current&&!this.busy&&!this.tween)this.improve(this.current);
    const ray=worldRay(this.yaw,this.pitch); this.lookAt(ray);
    const transition=this.tween;
    if (transition) {
      const linear=Math.min(1,Math.max(0,(now-transition.start)/transition.duration)), t=motionProgress(linear);
      this.yaw+=transition.yawDelta*(t-transition.yawProgress);transition.yawProgress=t;
      // Each panorama keeps its own doorway calibration while the visible
      // handover progresses. Mouse look remains additive throughout the move.
      const fromRay=worldRay(this.yaw-transition.yawDelta*t,this.pitch);
      const toRay=worldRay(this.yaw+transition.yawDelta*(1-t),this.pitch);
      const viewRay=worldRay(this.yaw,this.pitch);
      const a=transition.from.position ?? {x:0,y:0,z:0}, b=transition.to.position ?? {x:0,y:0,z:0};
      // An uncalibrated/cross-floor dissolve has no verified spatial route.
      const position=transition.mode==="dissolve"||transition.mode==="aligned-dissolve"||transition.mode==="display-depth"||!transition.from.position||!transition.to.position ? (linear===1 ? b : a) :
        {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};
      for (const value of this.cache.values()) this.setEntryVisible(value,false);
      // Photos without depth stay at their capture centers. Translating a
      // made-up floor shell bends nearby furniture and creates visible wobble.
      const fromPosition=transition.mode==="display-depth"?displayViewPosition(a,transition.bearings!.fromYaw,t):position;
      const toPosition=transition.mode==="display-depth"?displayViewPosition(b,transition.bearings!.toYaw,1-t):position;
      this.renderTransitionEntry(transition.a,transition.from,fromPosition,transition.mode,this.renderA,fromRay);
      this.renderTransitionEntry(transition.b,transition.to,toPosition,transition.mode,this.renderB,toRay);
      // Shorter overlap limits double edges on objects whose depth is unknown.
      this.blendMaterial.uniforms.amount.value=(transition.mode==="floor-proxy"||transition.mode==="plan-proxy") ? smoothstep((t-0.36)/0.28) : transition.mode==="display-depth"?smoothstep((t-.2)/.6):t;
      this.renderer.setRenderTarget(null); this.renderer.render(this.blendWorld,this.blendCamera);
      this.camera.position.set(position.x,position.y,position.z); this.lookAt(viewRay); this.camera.updateMatrixWorld();
      this.canvas.dataset.transitionProgress=linear.toFixed(3);
      if (linear===1) { this.setEntryVisible(transition.b,true); this.tween=null; transition.resolve(); this.dirty=true; }
    } else { this.renderer.setRenderTarget(null); this.renderer.render(this.world,this.camera); }
    if(this.cursorMesh.visible&&!this.busy){
      const autoClear=this.renderer.autoClear;
      this.renderer.autoClear=false;this.renderer.render(this.cursorWorld,this.camera);this.renderer.autoClear=autoClear;
    }
    const p=this.camera.position;
    this.onView?.(this.yaw,this.pitch,{x:p.x,y:p.y,z:p.z});
  };

  dispose() {
    if (this.destroyed) return;
    this.destroyed=true; cancelAnimationFrame(this.frame);
    this.queued?.resolve(false); this.queued=null; this.tween?.resolve(); this.tween=null;
    for (const request of this.pending.values()) request.abort.abort(); this.pending.clear();
    for (const upgrade of this.upgrades.values()) upgrade.abort.abort(); this.upgrades.clear();
    for(const job of this.preparations)job.abort();this.preparations.clear();
    for (const entry of this.cache.values()) this.release(entry); this.cache.clear();
    this.renderA.dispose(); this.renderB.dispose(); this.blendQuad.geometry.dispose(); this.blendMaterial.dispose();
    this.blobs.clear();this.cursorMesh.geometry.dispose();this.cursorMaterial.dispose();this.renderer.dispose();
    this.canvas.removeEventListener("webglcontextlost",this.contextLost);
    this.canvas.removeEventListener("webglcontextrestored",this.contextRestored);
    this.onView=undefined; this.onLoading=undefined; this.onError=undefined;
  }
}







