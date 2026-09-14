import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import type {Plan,Scene} from "@/lib/imo3d/model";
import {floorPlanProjection} from "./floorplan-geometry";
import {selectFloorPlanCapture,type PlanSelectionCapture} from "./floorplan-selection";
import {FloorPlanPointerGesture} from "./floorplan-pointer";
import {floorPlanDoorways,type PlanDoorway} from "./floorplan-doorways";
import {roomIdentity} from "./room-labels";
import {currentTexturedMesh} from "../../lib/imo3d/mesh-model";
import {TexturedApartmentModel,type ApartmentModelState} from "./TexturedApartmentModel";
import {floorPlan3DDisplay,floorPlan3DFitDistance,type Plan3DLayout,type Plan3DSegment} from "./floorplan3d-geometry";

export class FloorPlan3DRenderer{
  private renderer:THREE.WebGLRenderer;
  private world=new THREE.Scene();
  private camera:THREE.PerspectiveCamera|THREE.OrthographicCamera=new THREE.PerspectiveCamera(42,1,.01,1000);
  private controls:OrbitControls;
  private frame=0;private destroyed=false;private dirty=true;private last=0;
  private walls=new THREE.Group();private labels=new THREE.Group();
  private diagram=new THREE.Group();private photographic:TexturedApartmentModel|null=null;
  private photoRequest:AbortController|null=null;private photoDesired=true;private photoActive=false;
  private currentMarker=new THREE.Group();private markerMesh:THREE.InstancedMesh;
  private hitMesh:THREE.InstancedMesh;private picking=new THREE.Raycaster();
  private sourceTexture:THREE.Texture|null=null;private size={width:1,height:1};
  private lowWalls=false;private labelsBuilt=false;private current="";
  private pointer=new FloorPlanPointerGesture();
  private doorways:PlanDoorway[]=[];
  private selectionCaptures:PlanSelectionCapture[]=[];
  private resources:{dispose:()=>void}[]=[];
  private wallResources:{dispose:()=>void}[]=[];
  private labelResources:{dispose:()=>void}[]=[];
  private labelEntries:{sprite:THREE.Sprite;roomId:string;width:number;height:number}[]=[];
  private floorTextures=new Map<string,THREE.Texture>();
  private track<T extends {dispose:()=>void}>(resource:T):T{this.resources.push(resource);return resource;}
  private trackWall<T extends {dispose:()=>void}>(resource:T):T{this.wallResources.push(resource);return resource;}
  private finishTexture(finish:"wood"|"tile"|"stone"){
    const existing=this.floorTextures.get(finish);if(existing)return existing;
    const canvas=document.createElement("canvas");canvas.width=256;canvas.height=256;const ctx=canvas.getContext("2d");if(!ctx)return null;
    ctx.fillStyle=finish==="wood"?"#dac9ad":finish==="tile"?"#e5e9e4":"#deded5";ctx.fillRect(0,0,256,256);
    if(finish==="wood"){
      for(let line=0;line<95;line++){const y=line*2.8;ctx.strokeStyle=`rgba(145,113,76,${.03+(line%5)*.012})`;ctx.lineWidth=.65;ctx.beginPath();for(let x=0;x<=256;x+=8){const pointY=y+Math.sin(x*.024+line)*.9;if(x===0)ctx.moveTo(x,pointY);else ctx.lineTo(x,pointY);}ctx.stroke();}
      ctx.strokeStyle="rgba(128,108,79,.2)";ctx.lineWidth=1;for(let row=0;row<4;row++){ctx.beginPath();ctx.moveTo(0,row*64);ctx.lineTo(256,row*64);ctx.moveTo(row%2?78:185,row*64);ctx.lineTo(row%2?78:185,(row+1)*64);ctx.stroke();}
    }else if(finish==="tile"){
      ctx.strokeStyle="rgba(163,177,167,.45)";ctx.lineWidth=1.5;for(let p=0;p<256;p+=128){ctx.beginPath();ctx.moveTo(p,0);ctx.lineTo(p,256);ctx.moveTo(0,p);ctx.lineTo(256,p);ctx.stroke();}
    }else{for(let p=0;p<900;p++){ctx.fillStyle=`rgba(131,139,124,${.025+(p%4)*.012})`;ctx.fillRect((p*73)%256,(p*117)%256,1.2,1.2);}}
    const texture=this.track(new THREE.CanvasTexture(canvas));texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());this.floorTextures.set(finish,texture);return texture;
  }

  constructor(private canvas:HTMLCanvasElement,private layout:Plan3DLayout,plan:Plan,scenes:Scene[],private onSelect:(id:string)=>void,private onError:(message:string)=>void,private onPhotographicState:(state:ApartmentModelState)=>void=()=>{},private flat=false){
    if(flat)this.camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,1000);
    this.doorways=floorPlanDoorways(plan);
    this.selectionCaptures=scenes.filter(scene=>scene.floor===plan.floor).map(scene=>({id:scene.id,roomId:scene.roomSemantic?.groupId,point:scene.position?{x:scene.position.x-layout.origin.x,z:scene.position.z-layout.origin.z}:null}));
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled=true;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=.95;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0xf2f5f3,0);
    this.renderer.debug.onShaderError=()=>{throw new Error("تعذر تجهيز عرض الصور على هذا الجهاز.");};
    this.world.add(this.diagram);
    this.controls=new OrbitControls(this.camera,canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.1;
    this.controls.enableRotate=!flat;
    this.controls.minPolarAngle=.02;this.controls.maxPolarAngle=Math.PI*.47;this.controls.minDistance=layout.span*.18;this.controls.maxDistance=layout.span*8;
    this.controls.maxTargetRadius=layout.span*1.4;this.controls.screenSpacePanning=false;this.controls.zoomSpeed=.8;this.controls.rotateSpeed=.7;this.controls.panSpeed=.65;
    this.controls.mouseButtons={LEFT:flat?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};this.controls.touches={ONE:flat?THREE.TOUCH.PAN:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener("change",this.invalidate);
    this.world.add(new THREE.HemisphereLight(0xf9fbff,0x8f9889,1.3));
    const sun=new THREE.DirectionalLight(0xfff5e6,2.2);sun.position.set(-layout.span*.45,layout.span*1.4,layout.span*.55);sun.castShadow=true;
    const shadowSpan=layout.span*.85;sun.shadow.camera.left=-shadowSpan;sun.shadow.camera.right=shadowSpan;sun.shadow.camera.top=shadowSpan;sun.shadow.camera.bottom=-shadowSpan;sun.shadow.camera.near=.01;sun.shadow.camera.far=layout.span*4;
    sun.shadow.mapSize.set(1024,1024);sun.shadow.bias=-.0002;sun.shadow.normalBias=Math.max(.002,layout.span*.001);this.world.add(sun);this.resources.push({dispose:()=>sun.shadow.dispose()});
    const display=floorPlan3DDisplay(layout),baseWidth=layout.width+display.padding*2,baseDepth=layout.depth+display.padding*2;
    const baseGeometry=this.track(new THREE.PlaneGeometry(baseWidth,baseDepth));baseGeometry.rotateX(-Math.PI/2);
    const baseMaterial=this.track(new THREE.MeshStandardMaterial({color:0xfaf9f5,roughness:1,side:THREE.DoubleSide,transparent:true,opacity:.88}));
    const base=new THREE.Mesh(baseGeometry,baseMaterial);base.receiveShadow=true;base.position.y=-.015;this.diagram.add(base);
    if(layout.floorRooms?.length){
      base.visible=false;
      const slabThickness=layout.span*.008,period=Math.max(.05,layout.span*.17);
      const shadowMaterial=this.track(new THREE.ShadowMaterial({color:0x293b30,opacity:.16,depthWrite:false}));
      const shadow=new THREE.Mesh(baseGeometry,shadowMaterial);shadow.position.y=-slabThickness-.01;shadow.receiveShadow=true;this.diagram.add(shadow);
      for(const room of layout.floorRooms){
        const shape=new THREE.Shape();room.outline.forEach((point,index)=>{if(!index)shape.moveTo(point.x,-point.z);else shape.lineTo(point.x,-point.z);});shape.closePath();
        const geometry=this.track(new THREE.ExtrudeGeometry(shape,{depth:slabThickness,bevelEnabled:false,steps:1}));geometry.rotateX(-Math.PI/2);
        const positions=geometry.getAttribute("position"),uv=geometry.getAttribute("uv");for(let index=0;index<positions.count;index++)uv.setXY(index,positions.getX(index)/period,positions.getZ(index)/period);uv.needsUpdate=true;
        const material=this.track(new THREE.MeshStandardMaterial({color:room.finish==="wood"?0xd7c4a5:room.finish==="tile"?0xc6d1c7:0xcdcfc2,map:this.finishTexture(room.finish),roughness:.9}));
        const edge=this.track(new THREE.MeshStandardMaterial({color:0xc2c6ba,roughness:1}));
        const floor=new THREE.Mesh(geometry,[material,edge]);floor.receiveShadow=true;floor.castShadow=true;floor.position.y=-slabThickness;this.diagram.add(floor);
      }
    }
    if(plan.image&&/^\/(?:imo3d\/example\/|api\/imo3d\/assets\/)[\w/.-]+$/.test(plan.image)&&!plan.image.includes("..")){
      const projection=floorPlanProjection(plan,scenes),width=plan.width,height=plan.height;
      if(projection&&width&&height){
        const positions=baseGeometry.getAttribute("position"),uv=baseGeometry.getAttribute("uv");
        for(let index=0;index<positions.count;index++){const point=projection.project({x:positions.getX(index)+layout.origin.x,y:0,z:positions.getZ(index)+layout.origin.z});uv.setXY(index,point.x/width,1-point.y/height);}uv.needsUpdate=true;
        // SVG backgrounds are often transparent black. Keep the solid light
        // base independent and blend only the registered drawing's visible ink.
        const drawingMaterial=this.track(new THREE.MeshBasicMaterial({transparent:true,opacity:.6,depthWrite:false,side:THREE.DoubleSide,alphaTest:.005}));
        const drawing=new THREE.Mesh(baseGeometry,drawingMaterial);drawing.position.y=-.009;drawing.visible=false;this.diagram.add(drawing);
        new THREE.TextureLoader().load(plan.image,texture=>{if(this.destroyed){texture.dispose();return;}texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());this.sourceTexture=texture;drawingMaterial.map=texture;drawingMaterial.needsUpdate=true;drawing.visible=true;this.invalidate();},undefined,()=>{/* Geometry remains available if the optional drawing cannot load. */});
      }
    }
    this.diagram.add(this.walls);this.world.add(this.labels);this.buildWalls();this.labels.visible=false;
    const markerGeometry=this.track(new THREE.CylinderGeometry(1,1,.055,24));
    const markerMaterial=this.track(new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false,depthWrite:false}));
    this.markerMesh=this.track(new THREE.InstancedMesh(markerGeometry,markerMaterial,layout.cameras.length));this.markerMesh.renderOrder=8;
    this.markerMesh.visible=!layout.floorRooms?.length;
    const hitGeometry=this.track(new THREE.SphereGeometry(1,12,8));this.hitMesh=this.track(new THREE.InstancedMesh(hitGeometry,markerMaterial,layout.cameras.length));
    const matrix=new THREE.Matrix4();
    for(const [index,camera]of layout.cameras.entries()){
      matrix.makeScale(display.markerRadius,1,display.markerRadius).setPosition(camera.point.x,.08,camera.point.z);this.markerMesh.setMatrixAt(index,matrix);this.markerMesh.setColorAt(index,new THREE.Color(0x709188));
      matrix.makeScale(display.markerRadius*2.3,display.markerRadius*2.3,display.markerRadius*2.3).setPosition(camera.point.x,.08,camera.point.z);this.hitMesh.setMatrixAt(index,matrix);
    }
    this.markerMesh.instanceMatrix.needsUpdate=true;this.hitMesh.instanceMatrix.needsUpdate=true;this.hitMesh.computeBoundingSphere();this.hitMesh.updateMatrixWorld();this.world.add(this.markerMesh);
    const ringGeometry=this.track(new THREE.RingGeometry(display.markerRadius*1.25,display.markerRadius*1.8,40));ringGeometry.rotateX(-Math.PI/2);
    const activeMaterial=this.track(new THREE.MeshBasicMaterial({color:0x20a77a,transparent:true,opacity:.72,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));
    this.currentMarker.add(new THREE.Mesh(ringGeometry,activeMaterial));
    const centerGeometry=this.track(new THREE.CircleGeometry(display.markerRadius,24));centerGeometry.rotateX(-Math.PI/2);
    this.currentMarker.add(new THREE.Mesh(centerGeometry,this.track(new THREE.MeshBasicMaterial({color:0x20a77a,depthTest:false,depthWrite:false,side:THREE.DoubleSide}))));
    const wedgeShape=new THREE.Shape();wedgeShape.moveTo(0,0);wedgeShape.lineTo(-display.markerRadius*2.3,display.markerRadius*5.2);wedgeShape.quadraticCurveTo(0,display.markerRadius*6.2,display.markerRadius*2.3,display.markerRadius*5.2);wedgeShape.closePath();
    const wedgeGeometry=this.track(new THREE.ShapeGeometry(wedgeShape));wedgeGeometry.rotateX(-Math.PI/2);
    const wedgeMaterial=this.track(new THREE.MeshBasicMaterial({color:0x2bae82,transparent:true,opacity:.2,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));this.currentMarker.add(new THREE.Mesh(wedgeGeometry,wedgeMaterial));this.currentMarker.renderOrder=12;this.currentMarker.traverse(object=>object.renderOrder=12);this.world.add(this.currentMarker);
    canvas.addEventListener("pointerdown",this.pointerDown);canvas.addEventListener("pointermove",this.pointerMove);canvas.addEventListener("pointerup",this.pointerUp);canvas.addEventListener("pointercancel",this.pointerCancel);canvas.addEventListener("webglcontextlost",this.contextLost);
    this.reset();this.frame=requestAnimationFrame(this.draw);void this.loadPhotographic(plan,scenes);
  }

  private async loadPhotographic(plan:Plan,scenes:Scene[]){
    const model=currentTexturedMesh(plan,scenes);if(!model){this.onPhotographicState({status:"unavailable",active:false});return;}
    const request=new AbortController();this.photoRequest=request;this.onPhotographicState({status:"loading",active:false});let created:TexturedApartmentModel|null=null;
    try{created=await TexturedApartmentModel.load(model,this.layout.origin,request.signal);if(this.destroyed||request.signal.aborted){created.dispose();return;}
      created.setLowWalls(this.lowWalls);if(created.visibleBounds().isEmpty())throw new Error("لا توجد أسطح صالحة للعرض.");
      this.photographic=created;this.world.add(created.mesh);this.setPhotographic(this.photoDesired);
    }catch{created?.dispose();if(this.destroyed||request.signal.aborted)return;this.photographicFailed();}
    finally{if(this.photoRequest===request)this.photoRequest=null;}
  }
  private photographicFailed(){
    this.photographic?.dispose();this.photographic=null;this.photoActive=false;this.diagram.visible=true;this.markerMesh.visible=!this.layout.floorRooms?.length;
    this.renderer.setClearColor(0xf2f5f3,0);this.canvas.dataset.surface="diagram";this.onPhotographicState({status:"error",active:false});this.reset();this.invalidate();
  }
  setPhotographic(show:boolean){
    if(this.destroyed)return;this.photoDesired=show;this.photoActive=show&&!!this.photographic;
    if(this.photographic)this.photographic.mesh.visible=this.photoActive;this.diagram.visible=!this.photoActive;
    this.renderer.setClearColor(this.photoActive?(this.flat?0xf3f2ee:0x343840):0xf2f5f3,this.photoActive?1:0);
    this.canvas.dataset.surface=this.photoActive?"textured-mesh":"diagram";
    this.canvas.dataset.projection=this.flat?"orthographic":"perspective";
    this.markerMesh.visible=!this.photoActive&&!this.layout.floorRooms?.length;
    if(this.photographic)this.onPhotographicState({status:"ready",active:this.photoActive});
    this.reset();this.invalidate();
  }

  private invalidate=()=>{this.dirty=true;};
  private contextLost=(event:Event)=>{event.preventDefault();this.onError("توقف العرض ثلاثي الأبعاد. بدّل إلى المخطط ثنائي الأبعاد ثم أعد المحاولة.");};
  private buildWalls(){
    this.walls.clear();for(const resource of this.wallResources)resource.dispose();this.wallResources=[];const display=floorPlan3DDisplay(this.layout,this.lowWalls);
    const make=(segments:Plan3DSegment[],estimated:boolean)=>{
      if(!segments.length)return;
      const geometry=this.trackWall(new THREE.BoxGeometry(1,1,1));
      const material=this.trackWall(new THREE.MeshStandardMaterial({color:estimated?0xc4a574:0xf0eee5,roughness:.9,transparent:estimated,opacity:estimated?.26:1,depthWrite:!estimated}));
      const cap=estimated?material:this.trackWall(new THREE.MeshStandardMaterial({color:0xa6ac9f,roughness:1}));
      const mesh=this.trackWall(new THREE.InstancedMesh(geometry,[material,material,cap,material,material,material],segments.length)),matrix=new THREE.Matrix4(),rotation=new THREE.Quaternion();
      const height=estimated?display.height*.72:display.height;
      for(const [index,segment]of segments.entries()){rotation.setFromAxisAngle(new THREE.Vector3(0,1,0),segment.angle);matrix.compose(new THREE.Vector3((segment.a.x+segment.b.x)/2,height/2,(segment.a.z+segment.b.z)/2),rotation,new THREE.Vector3(segment.length,height,estimated?display.thickness:Math.max(display.thickness,this.layout.span*.0055)));mesh.setMatrixAt(index,matrix);}
      mesh.instanceMatrix.needsUpdate=true;mesh.castShadow=!estimated;mesh.receiveShadow=true;this.walls.add(mesh);
      const top=segments.flatMap(segment=>[segment.a.x,height+.003,segment.a.z,segment.b.x,height+.003,segment.b.z]);
      const lineGeometry=this.trackWall(new THREE.BufferGeometry());lineGeometry.setAttribute("position",new THREE.Float32BufferAttribute(top,3));
      const lineMaterial=this.trackWall(new THREE.LineBasicMaterial({color:estimated?0x9a804f:0x6e7b6f,transparent:true,opacity:estimated?.5:.22}));this.walls.add(new THREE.LineSegments(lineGeometry,lineMaterial));
    };
    make(this.layout.walls,false);make(this.layout.estimatedSurfaces,true);this.buildDoorways();this.invalidate();
  }
  private buildDoorways(){
    if(!this.doorways.length)return;
    const display=floorPlan3DDisplay(this.layout,this.lowWalls),portalHeight=floorPlan3DDisplay(this.layout,false).height*.82,depth=Math.max(display.thickness,this.layout.span*.0055)*1.22;
    const batches=new Map<string,THREE.Matrix4[]>();
    for(const door of this.doorways){
      const dx=(door.b.x-door.a.x)/door.length,dz=(door.b.z-door.a.z)/door.length,trim=Math.min(depth*.34,door.length*.065),height=Math.min(display.height,portalHeight),rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),door.angle);
      const center={x:(door.a.x+door.b.x)/2-this.layout.origin.x,z:(door.a.z+door.b.z)/2-this.layout.origin.z};
      const box=(key:string,x:number,y:number,z:number,width:number,tall:number,deep:number)=>{const values=batches.get(key)??[];values.push(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),rotation,new THREE.Vector3(width,tall,deep)));batches.set(key,values);};
      // Jambs sit beside the saved interval so its navigable opening is not narrowed.
      for(const sign of [-1,1])box(door.source,center.x+dx*(door.length+trim)/2*sign,height/2,center.z+dz*(door.length+trim)/2*sign,trim,height,depth);
      box(door.source,center.x,trim*.15,center.z,door.length,trim*.2,depth);
      if(display.height>portalHeight){
        // Vertical proportions are illustrative. Low cutaway walls intentionally
        // omit the header so a doorway remains visibly open from above.
        box(door.source,center.x,portalHeight,center.z,door.length+trim*2,trim,depth);
        box(door.source+"-header",center.x,(display.height+portalHeight)/2,center.z,door.length,display.height-portalHeight,depth/1.22);
      }
    }
    const geometry=this.trackWall(new THREE.BoxGeometry(1,1,1));
    for(const [key,matrices] of batches){
      const estimated=key.startsWith("estimated"),header=key.endsWith("header"),material=this.trackWall(new THREE.MeshStandardMaterial({color:estimated?0xb99458:header?0xf0eee5:0x6f8173,roughness:.9,transparent:estimated,opacity:estimated?(header?.25:.68):1,depthWrite:!estimated}));
      const mesh=this.trackWall(new THREE.InstancedMesh(geometry,material,matrices.length));matrices.forEach((matrix,index)=>mesh.setMatrixAt(index,matrix));mesh.instanceMatrix.needsUpdate=true;mesh.castShadow=!estimated;mesh.receiveShadow=true;this.walls.add(mesh);
    }
  }
  private buildLabels(){
    // The accessible room list retains every room; bounded canvas labels avoid
    // hundreds of textures and overlapping captions on large tours.
    this.labels.clear();for(const resource of this.labelResources)resource.dispose();this.labelResources=[];this.labelEntries=[];
    const active=this.layout.cameras.find(camera=>camera.id===this.current),activeRoom=active?roomIdentity(active.scene):"";
    for(const room of this.layout.rooms.filter(room=>room.positioned).sort((a,b)=>Number(b.id===activeRoom||b.sceneId===this.current)-Number(a.id===activeRoom||a.sceneId===this.current)).slice(0,36)){
      const camera=this.layout.cameras.find(camera=>camera.id===room.sceneId);if(!camera)continue;
      const label=document.createElement("canvas");
      const context=label.getContext("2d");if(!context)continue;
      const font="600 14px Arial, sans-serif";context.font=font;
      let text=room.name;if(context.measureText(text).width>172){while(text.length&&context.measureText(text+"…").width>172)text=text.slice(0,-1);text+="…";}
      const width=Math.max(64,Math.ceil(context.measureText(text).width)+24),height=30,density=3;
      label.width=width*density;label.height=height*density;context.scale(density,density);
      context.fillStyle="rgba(255,255,255,.97)";context.beginPath();context.roundRect(.75,.75,width-1.5,height-1.5,9);context.fill();context.strokeStyle="rgba(92,124,108,.35)";context.lineWidth=1;context.stroke();
      context.direction="rtl";context.textAlign="center";context.textBaseline="middle";context.font=font;context.fillStyle="#244d3c";context.fillText(text,width/2,height/2+.5);
      const texture=new THREE.CanvasTexture(label);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
      const material=new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false,sizeAttenuation:false,toneMapped:false});this.labelResources.push(texture,material);const sprite=new THREE.Sprite(material);
      sprite.position.set(camera.point.x,this.layout.span*.075,camera.point.z);sprite.renderOrder=20;sprite.userData.sceneId=room.sceneId;this.labels.add(sprite);this.labelEntries.push({sprite,roomId:room.id,width,height});
    }
  }
  private updateLabels(){
    if(!this.labels.visible)return;
    this.camera.updateMatrixWorld();
    const active=this.layout.cameras.find(camera=>camera.id===this.current),activeRoom=active?roomIdentity(active.scene):"";
    const isCurrent=(entry:typeof this.labelEntries[number])=>entry.roomId===activeRoom||entry.sprite.userData.sceneId===this.current;
    const occupied:{left:number;right:number;top:number;bottom:number}[]=[],canvasRect=this.canvas.getBoundingClientRect();
    for(const control of this.canvas.parentElement?.querySelectorAll<HTMLElement>(".imo-plan3d-location,.imo-plan3d-tools,.imo-plan3d-hint")??[]){const rect=control.getBoundingClientRect();if(rect.width&&rect.height)occupied.push({left:rect.left-canvasRect.left,right:rect.right-canvasRect.left,top:rect.top-canvasRect.top,bottom:rect.bottom-canvasRect.top});}
    // Non-attenuated sprites use angular world units. Convert CSS pixels through
    // the camera projection so names stay legible at every zoom and viewport.
    const pixelScale=2/(this.size.height*this.camera.projectionMatrix.elements[5]),point=new THREE.Vector3();
    for(const entry of [...this.labelEntries].sort((a,b)=>Number(isCurrent(b))-Number(isCurrent(a)))){
      const {sprite,width,height}=entry;sprite.visible=false;sprite.scale.set(width*pixelScale,height*pixelScale,1);
      point.copy(sprite.position).project(this.camera);if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.z<=-1||point.z>=1)continue;
      const x=(point.x+1)*this.size.width/2,y=(1-point.y)*this.size.height/2,rect={left:x-width/2,right:x+width/2,top:y-height/2,bottom:y+height/2};
      if(rect.left<8||rect.right>this.size.width-8||rect.top<8||rect.bottom>this.size.height-8||occupied.some(other=>rect.left<other.right+6&&rect.right>other.left-6&&rect.top<other.bottom+6&&rect.bottom>other.top-6))continue;
      sprite.visible=true;sprite.material.color.setHex(isCurrent(entry)?0xe2fff0:0xffffff);sprite.renderOrder=isCurrent(entry)?21:20;occupied.push(rect);
    }
  }
  resize(width:number,height:number){if(this.destroyed||width<=0||height<=0)return;const initial=this.size.width===1;this.size={width,height};this.renderer.setSize(width,height,false);if(this.camera instanceof THREE.PerspectiveCamera)this.camera.aspect=width/height;this.camera.updateProjectionMatrix();if(initial||this.flat)this.reset();this.invalidate();}
  setCurrent(id:string,yaw:number){if(this.destroyed)return;const current=this.layout.cameras.find(camera=>camera.id===id);this.currentMarker.visible=!!current;if(current){this.currentMarker.position.set(current.point.x,.1,current.point.z);this.currentMarker.rotation.y=-yaw;}
    if(this.current!==id){this.current=id;if(this.labelsBuilt&&current&&!this.labelEntries.some(entry=>entry.roomId===roomIdentity(current.scene)||entry.sprite.userData.sceneId===id))this.buildLabels();for(const [index,camera]of this.layout.cameras.entries())this.markerMesh.setColorAt(index,new THREE.Color(camera.id===id?0x13a878:0x709188));if(this.markerMesh.instanceColor)this.markerMesh.instanceColor.needsUpdate=true;}this.invalidate();}
  setPan(pan:boolean){pan=pan||this.flat;this.controls.mouseButtons.LEFT=pan?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;this.controls.touches.ONE=pan?THREE.TOUCH.PAN:THREE.TOUCH.ROTATE;this.canvas.dataset.mode=pan?"pan":"rotate";}
  setLowWalls(low:boolean){if(this.lowWalls===low)return;this.lowWalls=low;this.buildWalls();this.photographic?.setLowWalls(low);this.invalidate();}
  setLabels(show:boolean){if(show&&!this.labelsBuilt){this.buildLabels();this.labelsBuilt=true;}this.labels.visible=show;this.invalidate();}
  zoom(factor:number){if(this.camera instanceof THREE.OrthographicCamera){this.camera.zoom=Math.max(.5,Math.min(8,this.camera.zoom/factor));this.camera.updateProjectionMatrix();}else{const offset=this.camera.position.clone().sub(this.controls.target);offset.setLength(Math.max(this.controls.minDistance,Math.min(this.controls.maxDistance,offset.length()*factor)));this.camera.position.copy(this.controls.target).add(offset);}this.controls.update();this.invalidate();}
  reset(top=false){const display=floorPlan3DDisplay(this.layout,this.lowWalls),vertices=this.layout.floorRooms?.flatMap(room=>room.outline)??[];
    if(this.camera instanceof THREE.OrthographicCamera){
      const bounds=this.photoActive&&this.photographic?this.photographic.visibleBounds():new THREE.Box3().setFromPoints(vertices.map(point=>new THREE.Vector3(point.x,0,point.z)));
      if(bounds.isEmpty())bounds.set(new THREE.Vector3(-this.layout.width/2,0,-this.layout.depth/2),new THREE.Vector3(this.layout.width/2,display.height,this.layout.depth/2));
      const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),aspect=this.size.width/this.size.height,halfHeight=Math.max(size.z,size.x/aspect,.1)*.57;
      this.camera.left=-halfHeight*aspect;this.camera.right=halfHeight*aspect;this.camera.top=halfHeight;this.camera.bottom=-halfHeight;this.camera.zoom=1;
      this.camera.up.set(0,0,-1);this.camera.position.set(center.x,Math.max(10,this.layout.span*2),center.z+.0001);this.controls.target.set(center.x,0,center.z);this.camera.updateProjectionMatrix();this.controls.update();this.invalidate();return;
    }
    const direction=(top?new THREE.Vector3(0,1,.001):new THREE.Vector3(.85,1.1,1.05)).normalize(),target=new THREE.Vector3(0,display.height*.12,0);
    let distance=floorPlan3DFitDistance(this.layout.width+display.padding*2,this.layout.depth+display.padding*2,display.height,this.camera.aspect,42,top);
    if(this.photoActive&&this.photographic){
      const bounds=this.photographic.visibleBounds(),center=bounds.getCenter(new THREE.Vector3());target.copy(center);target.y=Math.max(0,center.y*.4);
      const right=new THREE.Vector3(direction.z,0,-direction.x).normalize(),up=new THREE.Vector3().crossVectors(direction,right),vertical=Math.tan(this.camera.fov*Math.PI/360),horizontal=vertical*this.camera.aspect;distance=this.controls.minDistance;
      for(const x of[bounds.min.x,bounds.max.x])for(const y of[bounds.min.y,bounds.max.y])for(const z of[bounds.min.z,bounds.max.z]){const point=new THREE.Vector3(x,y,z).sub(target),near=point.dot(direction);distance=Math.max(distance,near+Math.abs(point.dot(right))/horizontal*1.08,near+Math.abs(point.dot(up))/vertical*1.08);}
    }else if(vertices.length){
      // Fit the available apartment itself, not empty corners of the capture
      // bounds. Outlying cameras remain reachable by panning and the room list.
      const xs=vertices.map(point=>point.x),zs=vertices.map(point=>point.z);target.x=(Math.min(...xs)+Math.max(...xs))/2;target.z=(Math.min(...zs)+Math.max(...zs))/2;
      const right=new THREE.Vector3(direction.z,0,-direction.x).normalize(),up=new THREE.Vector3().crossVectors(direction,right),vertical=Math.tan(this.camera.fov*Math.PI/360),horizontal=vertical*this.camera.aspect;
      distance=this.controls.minDistance;
      for(const vertex of vertices)for(const y of [0,display.height]){const point=new THREE.Vector3(vertex.x,y,vertex.z).sub(target),near=point.dot(direction);distance=Math.max(distance,near+Math.abs(point.dot(right))/horizontal*1.18,near+Math.abs(point.dot(up))/vertical*1.18);}
    }
    this.controls.enableDamping=false;this.controls.update();this.controls.target.copy(target);this.camera.position.copy(target).addScaledVector(direction,distance);this.controls.update();this.controls.enableDamping=true;this.invalidate();}
  private pointerDown=(event:PointerEvent)=>{this.pointer.down(event);};
  private pointerMove=(event:PointerEvent)=>{this.pointer.move(event);};
  private pointerCancel=()=>{this.pointer.cancel();};
  private pointerUp=(event:PointerEvent)=>{if(!this.pointer.up(event))return;
    const rect=this.canvas.getBoundingClientRect();this.picking.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2),this.camera);
    if(this.labels.visible){this.updateLabels();this.labels.updateMatrixWorld(true);const label=this.picking.intersectObjects(this.labels.children.filter(label=>label.visible),false)[0],id=label?.object.userData.sceneId;if(typeof id==="string"&&this.layout.cameras.some(camera=>camera.id===id)){this.onSelect(id);return;}}
    const hit=this.picking.intersectObject(this.hitMesh,false)[0],hitCaptureId=hit?.instanceId!==undefined?this.layout.cameras[hit.instanceId]?.id:undefined;
    const point=(this.photoActive?this.photographic?.pick(this.picking.ray):null)??this.picking.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3());if(!point){if(hitCaptureId)this.onSelect(hitCaptureId);return;}
    const id=selectFloorPlanCapture(this.selectionCaptures,this.layout.floorRooms??[],{x:point.x,z:point.z},{hitCaptureId});if(id)this.onSelect(id);
  };
  private draw=(now:number)=>{if(this.destroyed)return;this.frame=requestAnimationFrame(this.draw);if(document.hidden){this.last=now;return;}const delta=this.last?Math.min(.05,(now-this.last)/1000):.016;this.last=now;const changed=this.controls.update(delta);if(!changed&&!this.dirty)return;this.updateLabels();try{this.renderer.render(this.world,this.camera);this.dirty=false;}catch{if(this.photographic)this.photographicFailed();else{this.onError("تعذر عرض المخطط ثلاثي الأبعاد على هذا الجهاز.");this.dirty=false;}}};
  dispose(){if(this.destroyed)return;this.destroyed=true;this.photoRequest?.abort();this.photoRequest=null;this.photographic?.dispose();this.photographic=null;cancelAnimationFrame(this.frame);this.controls.removeEventListener("change",this.invalidate);this.controls.dispose();this.sourceTexture?.dispose();for(const resource of [...this.wallResources,...this.labelResources,...this.resources])resource.dispose();this.resources=[];this.wallResources=[];this.labelResources=[];this.labelEntries=[];this.renderer.dispose();this.canvas.removeEventListener("pointerdown",this.pointerDown);this.canvas.removeEventListener("pointermove",this.pointerMove);this.canvas.removeEventListener("pointerup",this.pointerUp);this.canvas.removeEventListener("pointercancel",this.pointerCancel);this.canvas.removeEventListener("webglcontextlost",this.contextLost);}
}
