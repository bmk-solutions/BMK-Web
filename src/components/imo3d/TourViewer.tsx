"use client";
import {useEffect,useMemo,useRef,useState,type CSSProperties} from "react";
import type {Point,Scene,Tour} from "@/lib/imo3d/model";
import {layoutMeasurementLabels} from "@/lib/imo3d/measurement-projection";
import {estimatedMeasurementPoint,recordedMeasurementHeight,DEFAULT_CAPTURE_HEIGHT_METERS} from "@/lib/imo3d/estimated-measurement";
import {supportedDisplayDepth} from "@/lib/imo3d/display-depth";
import {distance,monthlyPayment,radians,surfacePoint} from "@/lib/imo3d/spatial";
import {heldHeading,isMovementCode,navigationPrefetch,navigationTransition,pickNavigationDirection,pointerDestination} from "@/lib/imo3d/navigation";
import type {PanoramaEngine} from "./PanoramaEngine";
import {api,number} from "./client";
import {Dialog} from "./Dialog";
import {CompactApartmentMap} from "./CompactApartmentMap";
import {BrandLogo} from "./BrandLogo";
import {roomChoices,roomFunctionCategories} from "./room-labels";
import {InteractiveFloorPlan} from "./InteractiveFloorPlan";
import {createViewerPlanCache} from "./viewer-plan-cache";
import {sceneEntryView} from "@/lib/imo3d/view-presentation";
import {ViewerFloorPlan} from "./ViewerFloorPlan";
import {Icon} from "./Icon";
import {calibratePanoramaHeight,projectPanoramaFloor,projectPanoramaMeasurement,type PanoramaMeasurementRay,type PanoramaMeasurementCalibration} from "@/lib/imo3d/panorama-measurement";
import {formatMeasurement,type MeasurementUnit} from "@/lib/imo3d/measurement-units";
import {MeasurementUnitPicker} from "./MeasurementUnitPicker";
import {useMeasurementNotebook} from './MeasurementNotebook';
import {PanoramaMeasurementControls} from "./PanoramaMeasurementControls";
import "./viewer-mobile.css";
import "./room-functions.css";
import "./liquid-glass.css";
import "./viewer-clean.css";
import "./viewer-presentation.css";
import {hasReviewedArchitecture} from "@/lib/imo3d/architecture-visibility";
type ViewerMedia={expiresAt:number;urls:Record<string,string>};
type ViewerTour=Tour&{media?:ViewerMedia};

export default function TourViewer({id,embedded=false,initialSceneId}:{id:string;embedded?:boolean;initialSceneId?:string}) {
  const [tour,setTour]=useState<ViewerTour|null>(null),[error,setError]=useState("");
  useEffect(()=>{let active=true;api<ViewerTour>(`tours/${id}?media=1`).then(value=>{if(active)setTour(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[id]);
  if(error)return <main className="imo-shell imo-load"><Icon name="info" size={32}/><h1>تعذر فتح الجولة</h1><p>{error}</p><a className="imo-button primary" href="/imo3d">العودة إلى الاستوديو</a></main>;
  if(!tour)return <main className="imo-shell imo-load"><span className="imo-spinner"/><p>جارٍ تحضير جولتك…</p></main>;
  if(!tour.scenes.length)return <main className="imo-shell imo-load"><h1>{tour.title}</h1><p>لم تُضف لقطات لهذه الجولة بعد.</p><a href="/imo3d" className="imo-button primary">فتح الاستوديو</a></main>;
  return <Viewer key={tour.id} tour={tour} embedded={embedded} initialSceneId={tour.scenes.some(scene=>scene.id===initialSceneId)?initialSceneId:undefined}/>;
}
function Viewer({tour,embedded,initialSceneId}:{tour:ViewerTour;embedded:boolean;initialSceneId?:string}) {
  const [planCache]=useState(createViewerPlanCache);
  useEffect(()=>()=>planCache.dispose(),[planCache]);
  const [measurementUnit,setMeasurementUnit]=useState<MeasurementUnit>("m");
  const [measurementsVisible,setMeasurementsVisible]=useState(true);
  const [selectedMeasurement,setSelectedMeasurement]=useState<string|null>(null);
  const notebook=useMeasurementNotebook(tour.id,tour.revision,tour.scenes.map(scene=>scene.id),Object.fromEntries(tour.scenes.map(scene=>[scene.id,{heightMeters:recordedMeasurementHeight(tour,scene.id)??DEFAULT_CAPTURE_HEIGHT_METERS,legacyHeightMeters:recordedMeasurementHeight(tour,scene.id)??1.6,origin:scene.position??{x:0,y:0,z:0}}])));
  const saveMeasurement=useRef(notebook.save);
  useEffect(()=>{saveMeasurement.current=notebook.save;},[notebook.save]);
  const [measurementViewport,setMeasurementViewport]=useState({width:0,height:0});
  const savedMeasurements=useRef(notebook.measurements);
  const [savedLines,setSavedLines]=useState<{id:string;meters:number;a:{x:number;y:number;visible:boolean;inFront?:boolean};b:{x:number;y:number;visible:boolean;inFront?:boolean}}[]>([]);
  useEffect(()=>{savedMeasurements.current=notebook.measurements;engine.current?.invalidate();},[notebook.measurements]);
  const media=useRef(tour.media);
  useEffect(()=>{
    if(!tour.media)return;
    let active=true,pending=false;
    const refresh=async()=>{
      if(pending||document.hidden||Date.now()<(media.current?.expiresAt??0)-60_000)return;
      pending=true;
      try{const next=await api<ViewerMedia>(`tours/${tour.id}/media`);if(active)media.current=next;}
      catch{/* Expired grants fall back to the authenticated asset route. */}
      finally{pending=false;}
    };
    const timer=window.setInterval(()=>void refresh(),30_000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[tour.id,tour.media]);
  const initialScene=tour.scenes.find(scene=>scene.id===initialSceneId)||tour.scenes[0];
  const canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null),engine=useRef<PanoramaEngine|null>(null);
  const [current,setCurrent]=useState(initialScene),currentRef=useRef(initialScene);
  const [busy,setBusy]=useState(true),[ready,setReady]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [panel,setPanel]=useState<"rooms"|"map"|"info"|"lead"|"options"|null>(null),panelRef=useRef(panel);
  const panelOpener=useRef<HTMLElement|null>(null);
  const [yaw,setYaw]=useState(0),[floor,setFloor]=useState(initialScene.floor);
  const [mapMode,setMapMode]=useState<"2d"|"3d">("2d");
  const [position,setPosition]=useState(initialScene.position),[mapVisible,setMapVisible]=useState(true);
  const mapViewActive=useRef(false),lastViewSync=useRef(0);
  const [mobile,setMobile]=useState(false),[mobileMapVisible,setMobileMapVisible]=useState(true),[fullscreen,setFullscreen]=useState(false);
  const [controlsHidden,setControlsHidden]=useState(false);
  const [,setRoomFilter]=useState("all");
  const [measure,setMeasure]=useState(false),measureRef=useRef(false),[points,setPoints]=useState<Point[]>([]),pointsRef=useRef<Point[]>([]);
  const [planeMeasure,setPlaneMeasure]=useState(false),planeMeasureRef=useRef(false);
  const [floorRays,setFloorRays]=useState<PanoramaMeasurementRay[]>([]);
  const photoCalibration=useRef<PanoramaMeasurementCalibration|null>(null);
  const measurementCalibrations=useRef(new Map<string,PanoramaMeasurementCalibration>());
  const [measurementSeed,setMeasurementSeed]=useState<PanoramaMeasurementCalibration|null>(null);
  const [markers,setMarkers]=useState<{x:number;y:number;visible:boolean}[]>([]);
  const navigating=useRef(false),mounted=useRef(false),initialized=useRef(false);
  const pendingNavigation=useRef<{target:Scene;walk:boolean;entry:boolean}|null>(null);
  const navigationRef=useRef<(scene:Scene,walk?:boolean)=>Promise<void>>(async()=>{});
  const scenesById=useRef(new Map(tour.scenes.map(s=>[s.id,s])));
  const choices=useMemo(()=>roomChoices(tour.scenes,current.floor),[tour.scenes,current.floor]);
  const categories=useMemo(()=>roomFunctionCategories(tour.scenes,current.floor),[tour.scenes,current.floor]);
  const currentPlan=tour.plans.find(p=>p.floor===current.floor);
  const showMinimap=!measure&&hasReviewedArchitecture(currentPlan)&&(mobile?mobileMapVisible:mapVisible);
  useEffect(()=>{
    mapViewActive.current=(!measure&&(mobile?mobileMapVisible:mapVisible))||panel==="map";
    lastViewSync.current=0;
    engine.current?.invalidate();
  },[showMinimap,panel,measure,mobile,mobileMapVisible,mapVisible]);
  function openPanel(next:typeof panel) {
    const previous=panelRef.current;
    if(next&&!previous)panelOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    panelRef.current=next;setPanel(next);
    if(next)engine.current?.clearNavigationCursor();
    if(!next&&previous)requestAnimationFrame(()=>{
      const opener=panelOpener.current;
      if(opener?.isConnected&&opener.getClientRects().length)opener.focus({preventScroll:true});
      else canvas.current?.focus({preventScroll:true});
    });
  }
  const warmedTarget=useRef("");
  function warmTarget(id:string){
    const target=scenesById.current.get(id),viewer=engine.current;
    if(!target||!viewer||target.id===currentRef.current.id||navigating.current)return;
    const key=currentRef.current.id+":"+id;
    if(warmedTarget.current===key)return;
    warmedTarget.current=key;
    viewer.prefetch([target,...navigationPrefetch(tour.scenes,currentRef.current,viewer.yaw)]);
  }
  function toggleMeasurement(){
    if(navigating.current||engine.current?.busy){setNotice("انتظر اكتمال الانتقال ثم ابدأ القياس.");return;}
    setNotice("");
    setFloor(currentRef.current.floor);
    setPoints([]);setFloorRays([]);photoCalibration.current=measurementCalibrations.current.get(currentRef.current.id)??calibratePanoramaHeight(currentRef.current.id,recordedMeasurementHeight(tour,currentRef.current.id)??DEFAULT_CAPTURE_HEIGHT_METERS);setMeasurementSeed(photoCalibration.current);planeMeasureRef.current=!(currentRef.current.depth&&tour.spatialScale==="metric")&&!supportedDisplayDepth(currentRef.current.displayDepth);setPlaneMeasure(planeMeasureRef.current);openPanel(null);setMeasure(value=>!value);
  }
  function setMinimapVisible(visible:boolean) {if(mobile)setMobileMapVisible(visible);else setMapVisible(visible);}
  function toggleFullscreen() {
    const promise=document.fullscreenElement?document.exitFullscreen?.():container.current?.requestFullscreen?.();
    if(promise)promise.catch(()=>setNotice("ملء الشاشة غير متاح في هذا المتصفح."));
    else setNotice("ملء الشاشة غير متاح في هذا المتصفح.");
  }
  useEffect(()=>{
    const viewport=window.matchMedia("(max-width: 720px)"),updateViewport=()=>setMobile(viewport.matches);
    const updateFullscreen=()=>setFullscreen(Boolean(document.fullscreenElement));
    updateViewport();updateFullscreen();viewport.addEventListener("change",updateViewport);document.addEventListener("fullscreenchange",updateFullscreen);
    return()=>{viewport.removeEventListener("change",updateViewport);document.removeEventListener("fullscreenchange",updateFullscreen);};
  },[]);
  useEffect(()=>{document.title=`${tour.title} — ${tour.branding?.name||"IMO 3D"}`;},[tour]);
  useEffect(()=>{panelRef.current=panel;measureRef.current=measure;pointsRef.current=points;engine.current?.invalidate();},[panel,measure,points]);
  async function navigate(target:Scene,walk=true,entry=false) {
    const viewer=engine.current;if(!viewer||!initialized.current)return;
    if(!navigating.current&&target.id===currentRef.current.id){const view=entry?sceneEntryView(target):undefined;if(view){viewer.stopLook();Object.assign(viewer,view);viewer.invalidate();}return;}
    pendingNavigation.current={target,walk,entry};
    if(navigating.current){viewer.cancelPendingLoad();return;}
    navigating.current=true;setSelectedMeasurement(null);setError("");setMeasure(false);measureRef.current=false;setPoints([]);setFloorRays([]);photoCalibration.current=null;setNotice("");
    try{
      while(pendingNavigation.current&&mounted.current){
        const request=pendingNavigation.current;pendingNavigation.current=null;
        const source=currentRef.current;if(source.id===request.target.id){const view=request.entry?sceneEntryView(request.target):undefined;if(view){viewer.stopLook();Object.assign(viewer,view);viewer.invalidate();}continue;}
        const scene=request.target,transition=navigationTransition(source,scene,viewer.yaw,tour.spatialSource,request.walk?"step":"direct");
          const view=request.entry?sceneEntryView(scene):undefined;
          const moved=await viewer.move(scene,transition.animation,view?.yaw??transition.arrivalYaw,transition.bearings);if(!moved)continue;
          if(view){viewer.stopLook();Object.assign(viewer,view);viewer.invalidate();}
          currentRef.current=scene;setCurrent(scene);setFloor(scene.floor);setPosition(scene.position);
          viewer.prefetch(navigationPrefetch(tour.scenes,scene,viewer.yaw));
      }
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"تعذر الانتقال");}
    finally{navigating.current=false;pendingNavigation.current=null;}
  }
  useEffect(()=>{navigationRef.current=navigate;});
  useEffect(()=>{
    mounted.current=true;let cancelled=false;let resize:ResizeObserver|undefined;let instance:PanoramaEngine|undefined;
    const el=canvas.current!;
    void import("./PanoramaEngine").then(async({PanoramaEngine})=>{
      if(cancelled)return;instance=new PanoramaEngine(el,{plans:tour.plans,resolveAsset:url=>media.current&&Date.now()<media.current.expiresAt?media.current.urls[url]??url:url});engine.current=instance;
      instance.onError=setError;instance.onLoading=loading=>{if(!cancelled)setBusy(loading);};
      instance.onView=(nextYaw,_pitch,nextPosition)=>{
        if(cancelled)return;
        const measuring=pointsRef.current.length>0||savedMeasurements.current.length>0;
        // Keep panorama frames outside React when no overlay consumes the pose.
        if(!mapViewActive.current&&!measuring)return;
        const now=performance.now();
        if(!measuring&&now-lastViewSync.current<66)return;
        lastViewSync.current=now;
        if(mapViewActive.current){setYaw(nextYaw);setPosition(nextPosition);}
        if(measuring){
          setMarkers(pointsRef.current.map(p=>instance!.project(p)));
          setSavedLines(savedMeasurements.current.flatMap(item=>item.sceneId===currentRef.current.id&&item.endpoints?[{id:item.id,meters:item.meters,a:instance!.project(item.endpoints[0]),b:instance!.project(item.endpoints[1])}]:[]));
        }
      };
      resize=new ResizeObserver(([entry])=>{const {width,height}=entry.contentRect;instance?.resize(width,height);setMeasurementViewport({width,height});});resize.observe(el);
      instance.resize(el.clientWidth,el.clientHeight);await instance.move(currentRef.current,false);
      if(!cancelled){const entry=sceneEntryView(currentRef.current);if(entry){Object.assign(instance,entry);instance.invalidate();}else if(tour.initialView&&!initialSceneId){instance.yaw=radians(tour.initialView.yaw);instance.pitch=radians(tour.initialView.pitch);instance.invalidate();}initialized.current=true;setReady(true);setBusy(false);instance.prefetch(navigationPrefetch(tour.scenes,currentRef.current,instance.yaw));}
    }).catch(e=>{if(!cancelled){setError(e instanceof Error?e.message:"الجهاز لا يدعم عرض 360");setBusy(false);}});
    let down:{x:number;y:number;time:number;dragged:boolean}|null=null;
    const pointers=new Map<number,{x:number;y:number}>(),heldKeys=new Set<string>();let lastPinch=0;
    let lastPointer:{x:number;y:number}|null=null;
    let lastPrefetch=0,lastPrefetchKey="";
    const destinationAt=(x:number,y:number)=>{
      if(!instance)return null;const rect=el.getBoundingClientRect();
      const ray=instance.rayAt((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2);
      return pointerDestination(tour.scenes,currentRef.current.id,ray.yaw,ray.pitch,tour.spatialScale==="metric"&&tour.spatialSource==="calibrated",instance.pointedSurface((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2));
    };
    const updateCursor=()=>{
      if(!instance)return;
      if(measureRef.current&&!down?.dragged&&!pointers.size&&!panelRef.current&&!navigating.current&&initialized.current){
        const rect=el.getBoundingClientRect();
        const shown=lastPointer&&instance.setNavigationCursor((lastPointer.x-rect.left)/rect.width*2-1,1-(lastPointer.y-rect.top)/rect.height*2,null,true);
        if(!lastPointer)instance.clearNavigationCursor();
        el.dataset.cursor=shown?"surface-measure":"measure";el.dataset.destinationId="";return;
      }
      if(down?.dragged||pointers.size||panelRef.current||measureRef.current||navigating.current||!initialized.current){instance.clearNavigationCursor();el.dataset.cursor=down?.dragged?"drag":measureRef.current?"measure":"look";el.dataset.destinationId="";return;}
      const target=lastPointer?destinationAt(lastPointer.x,lastPointer.y):null;
      const now=performance.now();
      if(now-lastPrefetch>300){
        const candidates=target?[target,...navigationPrefetch(tour.scenes,currentRef.current,instance.yaw,target.id)]:navigationPrefetch(tour.scenes,currentRef.current,instance.yaw);
        const key=currentRef.current.id+":"+candidates.slice(0,2).map(scene=>scene.id).join(",");
        if(key!==lastPrefetchKey){instance.prefetch(candidates);lastPrefetchKey=key;}
        lastPrefetch=now;
      }
      el.dataset.destinationId=target?.id??"";
      const rect=el.getBoundingClientRect();
      const projected=lastPointer&&instance.setNavigationCursor((lastPointer.x-rect.left)/rect.width*2-1,1-(lastPointer.y-rect.top)/rect.height*2,target);
      if(!lastPointer)instance.clearNavigationCursor();
      el.dataset.cursor=projected?"navigate":target?"navigate-flat":"look";
    };
    const pointerDown=(e:PointerEvent)=>{if(e.button!==0)return;el.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});down={x:e.clientX,y:e.clientY,time:performance.now(),dragged:false};
      if(pointers.size===2){const p=[...pointers.values()];lastPinch=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);down.dragged=true;}};
    const pointerMove=(e:PointerEvent)=>{lastPointer=e.pointerType==="touch"?null:{x:e.clientX,y:e.clientY};updateCursor();const previous=pointers.get(e.pointerId);if(!previous||!instance||!down)return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===2){const p=[...pointers.values()],d=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);instance.fov+=(lastPinch-d)*0.12;lastPinch=d;down.dragged=true;return;}
      if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>6)down.dragged=true;
      if(down.dragged){instance.addLook(-(e.clientX-previous.x)*0.004,(e.clientY-previous.y)*0.003);updateCursor();}
    };
    const pointerUp=(e:PointerEvent)=>{pointers.delete(e.pointerId);if(!down||!instance)return;
      if(pointers.size){const remaining=[...pointers.values()][0];down={x:remaining.x,y:remaining.y,time:performance.now(),dragged:true};return;}
      const click=!down.dragged&&performance.now()-down.time<650;down=null;
      if(!click||panelRef.current)return;
      const rect=el.getBoundingClientRect(),ray=instance.rayAt((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2);
      if(measureRef.current){
        setMeasurementsVisible(true);
        if(navigating.current||instance.busy)return;
        const scene=currentRef.current;
        if(!planeMeasureRef.current&&((scene.depth&&tour.spatialScale==="metric")||supportedDisplayDepth(scene.displayDepth))){
          const point=scene.depth&&tour.spatialScale==="metric"?surfacePoint(scene,ray.yaw,ray.pitch):estimatedMeasurementPoint(scene,ray.yaw,ray.pitch,recordedMeasurementHeight(tour,scene.id)??undefined);if(!point){setNotice("بيانات العمق ناقصة هنا. اختر «تحديد سطح» لقياس الجدار أو الباب من حدوده الظاهرة.");return;}setNotice("");
          const next=pointsRef.current.length===1?[pointsRef.current[0],point]:[point];
          pointsRef.current=next;setPoints(next);setSelectedMeasurement(null);
          if(next.length===2){
            const meters=distance(next[0],next[1]),measurementId=JSON.stringify([scene.id,next]);
            if(meters>0&&Number.isFinite(meters)){
              const estimated=!(scene.depth&&tour.spatialScale==="metric");
              saveMeasurement.current({id:measurementId,sceneId:scene.id,label:scene.room||scene.name,meters,endpoints:next as [Point,Point],estimated,...(estimated?{lensHeightMeters:recordedMeasurementHeight(tour,scene.id)??DEFAULT_CAPTURE_HEIGHT_METERS}:{})});
              setSelectedMeasurement(measurementId);
            }
          }
        }else{
          const calibration=photoCalibration.current?.sceneId===scene.id?photoCalibration.current:calibratePanoramaHeight(scene.id,recordedMeasurementHeight(tour,scene.id)??DEFAULT_CAPTURE_HEIGHT_METERS);
          const local=calibration?projectPanoramaMeasurement(ray,calibration):projectPanoramaFloor(ray);
          if(!local){setNotice(calibration?.source==="ceiling_height"?"اختر نقطة على السقف المحدد فوق الأفق.":calibration?.source==="wall_reference"||calibration?.source==="wall_height"?"اختر نقطة واضحة على الجدار الذي حددته.":"اختر نقطة واضحة على الأرض أسفل الأفق.");return;}
          const origin=scene.position??{x:0,y:0,z:0},point={x:origin.x+local.x,y:origin.y+local.y,z:origin.z+local.z};
          setFloorRays(prev=>prev.length===2?[ray]:[...prev,ray]);setPoints(prev=>prev.length===2?[point]:[...prev,point]);
        }
        return;
      }
      const target=destinationAt(e.clientX,e.clientY);
      if(target)void navigationRef.current(target,false);
    };
    const pointerCancel=(e:PointerEvent)=>{pointers.delete(e.pointerId);down=null;updateCursor();};
    const pointerLeave=()=>{if(!pointers.size){lastPointer=null;updateCursor();}};
    const wheel=(e:WheelEvent)=>{e.preventDefault();if(instance)instance.fov+=e.deltaY*0.025;};
    const moveHeld=()=>{if(panelRef.current||measureRef.current){heldKeys.clear();return;}if(!instance||navigating.current||!initialized.current)return;const heading=heldHeading(heldKeys,instance.yaw);if(heading===null)return;const target=pickNavigationDirection(tour.scenes,currentRef.current.id,heading);if(target)void navigationRef.current(target);};
    const keyDown=(e:KeyboardEvent)=>{
      if(panelRef.current||!instance||e.ctrlKey||e.metaKey||e.altKey||(e.target instanceof HTMLElement&&(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)))return;
      if(!isMovementCode(e.code))return;e.preventDefault();heldKeys.add(e.code);if(!e.repeat)moveHeld();
    };
    const keyUp=(e:KeyboardEvent)=>{heldKeys.delete(e.code);};
    const clearKeys=()=>{heldKeys.clear();pointers.clear();down=null;lastPointer=null;instance?.clearNavigationCursor();};
    let inputFrame=0;const inputTick=()=>{if(cancelled)return;moveHeld();updateCursor();inputFrame=requestAnimationFrame(inputTick);};inputFrame=requestAnimationFrame(inputTick);
    el.addEventListener("pointerdown",pointerDown);el.addEventListener("pointermove",pointerMove);el.addEventListener("pointerup",pointerUp);el.addEventListener("pointercancel",pointerCancel);el.addEventListener("pointerleave",pointerLeave);el.addEventListener("wheel",wheel,{passive:false});window.addEventListener("keydown",keyDown);window.addEventListener("keyup",keyUp);window.addEventListener("blur",clearKeys);document.addEventListener("visibilitychange",clearKeys);
    return()=>{cancelled=true;mounted.current=false;initialized.current=false;pendingNavigation.current=null;cancelAnimationFrame(inputFrame);resize?.disconnect();instance?.dispose();engine.current=null;el.removeEventListener("pointerdown",pointerDown);el.removeEventListener("pointermove",pointerMove);el.removeEventListener("pointerup",pointerUp);el.removeEventListener("pointercancel",pointerCancel);el.removeEventListener("pointerleave",pointerLeave);el.removeEventListener("wheel",wheel);window.removeEventListener("keydown",keyDown);window.removeEventListener("keyup",keyUp);window.removeEventListener("blur",clearKeys);document.removeEventListener("visibilitychange",clearKeys);};
  },[tour,initialSceneId]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(""),5000);return()=>clearTimeout(timer);},[notice]);
  const chooseRoom=(target:Scene)=>{void navigate(target,false,true);openPanel(null);};
  const plan=tour.plans.find(p=>p.floor===floor);
  const branding=tour.branding,accent=branding?.accent||"#24b18b";
  const Wordmark=embedded?"div":"a";
  const channels=[1,3,5].map(i=>parseInt(accent.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  const accentInk=.2126*channels[0]+.7152*channels[1]+.0722*channels[2]>.179?"#10221c":"#ffffff";
  return <div className={`imo-shell imo-viewer${controlsHidden?" imo-viewer--controls-hidden":""}`} ref={container} data-mobile-map={mobileMapVisible?"shown":"hidden"} style={{"--imo-accent":accent,"--imo-accent-ink":accentInk} as CSSProperties}>
    <canvas ref={canvas} className="imo-canvas" tabIndex={0} aria-label="الجولة الداخلية 360؛ اسحب للنظر، واضغط للانتقال، أو استخدم مفاتيح WASD والأسهم"/>
    <div className="imo-vignette"/>
    <button type="button" className="imo-glass imo-controls-toggle" aria-label={controlsHidden?"إظهار أدوات الجولة":"إخفاء أدوات الجولة"} aria-pressed={controlsHidden} onClick={()=>{openPanel(null);setControlsHidden(value=>!value);}}><Icon name={controlsHidden?"settings":"eye"}/><span>{controlsHidden?"إظهار الأدوات":"إخفاء الأدوات"}</span></button>
    <header className="imo-view-header">
      <Wordmark href={embedded?undefined:"/imo3d"} className={`imo-wordmark${branding?.logo||branding?.name!==undefined&&branding.name!=="IMO 3D"?" imo-custom-brand":""}`} aria-label={`${branding?.name||"IMO 3D"}${embedded?"":" — الاستوديو"}`}>{branding?.logo&&<BrandLogo className="imo-brand-logo" src={branding.logo} clean={branding.logoStyle!=="original"} tone="light"/>}{branding?.name&&branding.name!=="IMO 3D"?<span>{branding.name}</span>:!branding?.logo&&<span>IMO<span className="imo-logo-dot"/>3D</span>}{!branding?.logo&&(!branding?.name||branding.name==="IMO 3D")&&<small>BY BMK SOLUTIONS</small>}</Wordmark>
      <div className="imo-view-title"><span>{tour.title}</span></div>
      <button className="imo-glass imo-icon" title={fullscreen?"الخروج من ملء الشاشة":"ملء الشاشة"} aria-label={fullscreen?"الخروج من ملء الشاشة":"ملء الشاشة"} onClick={toggleFullscreen}><Icon name="expand"/></button>
    </header>
    {!measure&&panel!=="map"&&(mobile?mobileMapVisible:mapVisible)&&<aside className="imo-under-logo-map"><ViewerFloorPlan cache={planCache} onIntent={warmTarget} scenes={tour.scenes} yaw={yaw} key={`${tour.id}/${current.floor}`} tourId={tour.id} floor={current.floor} compact current={current.id} sceneIds={tour.scenes.filter(s=>s.floor===current.floor).map(s=>s.id)} onSelect={id=>{const target=scenesById.current.get(id);if(target)void navigate(target,false);}} onExpand={()=>{setFloor(current.floor);openPanel("map");}}/><UnitSummary tour={tour}/></aside>}
    {busy&&<div className={`imo-view-loading ${ready?"delayed":""}`} role="status"><span className="imo-spinner"/> جارٍ تحميل المشهد</div>}
    {error&&<div className="imo-view-error" role="alert"><p>{error}</p><button onClick={()=>window.location.reload()} className="imo-button primary">إعادة المحاولة</button></div>}
    {notice&&<div className="imo-notice" role="status">{notice}</div>}
    {measure&&<><div className="imo-measure-tools" role="toolbar" aria-label="أدوات القياس">
      <button type="button" title="إضافة قياس جديد" aria-label="إضافة قياس جديد" onClick={()=>{setMeasurementsVisible(true);pointsRef.current=[];setPoints([]);setFloorRays([]);setSelectedMeasurement(null);}}><Icon name="plus"/></button>
      <button type="button" title="حذف القياس المحدد" aria-label="حذف القياس المحدد" disabled={!selectedMeasurement&&points.length===0} onClick={()=>{if(selectedMeasurement)notebook.remove(selectedMeasurement);setSelectedMeasurement(null);pointsRef.current=[];setPoints([]);setFloorRays([]);}}><Icon name="trash"/></button>
      <button type="button" className="imo-measure-clear-all" title="حذف كل القياسات" aria-label="حذف كل القياسات" disabled={!notebook.measurements.length&&!points.length} onClick={()=>{if(!window.confirm("حذف جميع قياسات هذه الجولة؟ لا يمكن التراجع عن الحذف."))return;notebook.clear();setSelectedMeasurement(null);pointsRef.current=[];setPoints([]);setFloorRays([]);}}><Icon name="trash"/><small>الكل</small></button>
      <button type="button" title={measurementsVisible?"إخفاء القياسات":"إظهار القياسات"} aria-label={measurementsVisible?"إخفاء القياسات":"إظهار القياسات"} aria-pressed={!measurementsVisible} onClick={()=>{setMeasurementsVisible(value=>!value);setSelectedMeasurement(null);setPoints([]);}}><Icon name={measurementsVisible?"eye":"eye-off"}/></button>
      <button type="button" title={planeMeasure?"العودة إلى عمق الصور":"تحديد سطح جدار أو باب أو سقف"} aria-label="تحديد سطح" disabled={!(current.depth&&tour.spatialScale==="metric")&&!supportedDisplayDepth(current.displayDepth)} aria-pressed={planeMeasure} onClick={()=>{planeMeasureRef.current=!planeMeasureRef.current;setPlaneMeasure(planeMeasureRef.current);photoCalibration.current=measurementCalibrations.current.get(current.id)??calibratePanoramaHeight(current.id,recordedMeasurementHeight(tour,current.id)??DEFAULT_CAPTURE_HEIGHT_METERS);setMeasurementSeed(photoCalibration.current);pointsRef.current=[];setPoints([]);setFloorRays([]);setNotice("");}}><Icon name="map"/><small>سطح</small></button>
      <MeasurementUnitPicker value={measurementUnit} onChange={setMeasurementUnit}/>
      {!(current.depth&&tour.spatialScale==="metric")&&<details className="imo-measure-assumption"><summary title="تفاصيل التقدير">≈ تقديري</summary><p>{recordedMeasurementHeight(tour,current.id)!==null?`المقياس يستخدم ارتفاع العدسة المسجّل ${recordedMeasurementHeight(tour,current.id)!.toFixed(2)} م. العمق مستنتج من الصور؛ الأبعاد تقريبية وليست مسحًا هندسيًا معتمدًا.`:`المقياس يستخدم إعداد التصوير المشترك ${DEFAULT_CAPTURE_HEIGHT_METERS.toFixed(2)} م. يلزم تعديل إعداد المشروع إذا اختلف ارتفاع التصوير. العمق مستنتج من الصور والأبعاد تقديرية.`}</p></details>}
      <button type="button" title="إنهاء القياس" aria-label="إنهاء القياس" onClick={()=>{setMeasure(false);setPoints([]);setSelectedMeasurement(null);}}><Icon name="close"/></button>
      {measurementsVisible&&points.length===2&&<button type="button" className="imo-measure-live-result" aria-label="تحديد القياس الأخير" onClick={()=>setSelectedMeasurement(JSON.stringify([current.id,points]))}>{!(current.depth&&tour.spatialScale==="metric")?"≈ ":""}{formatMeasurement(distance(points[0],points[1]),measurementUnit)}</button>}
      <span className="imo-measure-instruction" role="status">{!measurementsVisible?"القياسات مخفية · اضغط العين لإظهارها":selectedMeasurement?"القياس محدد · اضغط سلة الحذف لإزالته":points.length===0?"حدّد نقطتين على الصورة":points.length===1?"حدّد النقطة الثانية":"اضغط على قيمة القياس لتحديده"}</span>
    </div>{(planeMeasure||(!(current.depth&&tour.spatialScale==="metric")&&!supportedDisplayDepth(current.displayDepth)))&&<PanoramaMeasurementControls fixedHeight unit={measurementUnit} origin={current.position??{x:0,y:0,z:0}} onSave={item=>{notebook.save(item);setSelectedMeasurement(item.id);pointsRef.current=[];setPoints([]);setFloorRays([]);}} key={current.id} sceneId={current.id} initialCalibration={measurementSeed??calibratePanoramaHeight(current.id,recordedMeasurementHeight(tour,current.id)??DEFAULT_CAPTURE_HEIGHT_METERS)} points={floorRays} markers={markers} onCalibrationChange={value=>{photoCalibration.current=value;if(value)measurementCalibrations.current.set(current.id,value);else measurementCalibrations.current.delete(current.id);}} onClear={()=>{setFloorRays([]);setPoints([]);}} onClose={()=>{setMeasure(false);setFloorRays([]);setPoints([]);photoCalibration.current=null;}}/>}</>}
    {measurementsVisible&&!controlsHidden&&!busy&&notebook.measurements.length>0&&<>
      <svg className="imo-photo-ruler-line" aria-hidden="true">{savedLines.filter(line=>line.a.inFront&&line.b.inFront&&notebook.measurements.some(item=>item.id===line.id&&item.sceneId===current.id)).map(line=><g key={line.id}><line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} stroke="#182522" strokeOpacity=".7" strokeWidth="5"/><line x1={line.a.x} y1={line.a.y} x2={line.b.x} y2={line.b.y} stroke={selectedMeasurement===line.id?"#ffcf52":"#ffffff"} strokeWidth="2"/>{[line.a,line.b].map((point,index)=><circle key={index} cx={point.x} cy={point.y} r="4" fill={selectedMeasurement===line.id?"#ffcf52":"white"} stroke="#24312b" strokeWidth="1.5"/>)}</g>)}</svg>
      {layoutMeasurementLabels(savedLines.filter(line=>notebook.measurements.some(item=>item.id===line.id&&item.sceneId===current.id)),measurementViewport.width,measurementViewport.height).map(({line,position:anchor})=>{
       const item=notebook.measurements.find(item=>item.id===line.id)!;
       return <button key={line.id} type="button" className="imo-measure-label" aria-label={`تحديد قياس ${formatMeasurement(line.meters,measurementUnit)}${item.estimated?" تقديري":""}`} aria-pressed={selectedMeasurement===line.id} style={{left:anchor.x,top:anchor.y}} onClick={()=>{setSelectedMeasurement(line.id);setMeasure(true);setPoints([]);}}>{item.estimated?"≈ ":""}{formatMeasurement(line.meters,measurementUnit)}{item.estimated&&<small>تقديري</small>}</button>;
      })}
    </>}
    {measure&&measurementsVisible&&markers.map((p,i)=>i<points.length&&p.visible&&<div key={i} className="imo-measure-point" style={{left:p.x,top:p.y}}>{i+1}</div>)}
    {showMinimap&&panel!=="map"&&currentPlan&&<aside className="imo-minimap" aria-label="المخطط المصغّر"><CompactApartmentMap mode={mapMode} onModeChange={setMapMode} plan={currentPlan} scenes={tour.scenes} current={current.id} yaw={yaw} position={position} spatialScale={tour.spatialScale} onExpand={()=>{setFloor(current.floor);openPanel("map");}} onClose={()=>setMinimapVisible(false)} onSelect={id=>{const scene=scenesById.current.get(id);if(scene)void navigate(scene,false);}}/></aside>}
    <footer className="imo-view-footer">
      <div className="imo-view-toolbar"><button aria-label="مخطط الشقة" aria-pressed={showMinimap} className={`imo-glass ${showMinimap?"active":""}`} onClick={()=>{if(!showMinimap&&hasReviewedArchitecture(currentPlan))setMinimapVisible(true);else{setFloor(current.floor);openPanel("map");}}}><Icon name="map"/><span>المخطط</span></button>
        <button aria-label="تفاصيل الوحدة" className="imo-glass" onClick={()=>openPanel("info")}><Icon name="info"/><span>الوحدة</span></button>
        <button aria-label="قياس بين نقطتين" className={`imo-glass ${measure?"active":""}`} title="قياس بين نقطتين على الصورة" onClick={toggleMeasurement}><Icon name="measure"/><span>قياس</span></button>
      </div>
      <div className="imo-room-switcher"><small>استكشف حسب نوع الغرفة</small><div>{categories.map(category=><button key={category.kind} className={current.roomSemantic?.kind===category.kind?"selected":""} onClick={()=>{const rooms=roomChoices(tour.scenes,current.floor,category.kind);if(rooms.length===1)chooseRoom(rooms[0].scene);else{setRoomFilter(category.kind);openPanel("rooms");}}}>{category.label}</button>)}<button aria-label="جميع الغرف" onClick={()=>{setRoomFilter("all");openPanel("rooms");}}><Icon name="grid"/></button></div></div>
      <button className="imo-interest" onClick={()=>openPanel("lead")}>سجّل اهتمامك <Icon name="arrow" size={19}/></button>
    </footer>
    <nav className="imo-mobile-dock" aria-label="أدوات الجولة">
      <button className="imo-glass" aria-label="اختيار غرفة" aria-haspopup="dialog" aria-expanded={panel==="rooms"} onClick={()=>openPanel("rooms")}><Icon name="rooms"/><span>الغرف</span></button>
      <button className={`imo-glass ${measure?"active":""}`} aria-label="قياس على الصورة" aria-pressed={measure} onClick={toggleMeasurement}><Icon name="measure"/><span>قياس</span></button>
      <button className="imo-glass" aria-label="خيارات الجولة" aria-haspopup="dialog" aria-expanded={panel==="options"} onClick={()=>openPanel("options")}><Icon name="settings"/><span>الخيارات</span></button>
    </nav>
    <div className="imo-view-help">اسحب لاستكشاف المكان <span>·</span> اضغط للانتقال <span>·</span> WASD</div>
    {panel==="options"&&<Dialog title="خيارات الجولة" className="imo-view-options" onClose={()=>openPanel(null)}>
      <div className="imo-option-icons">
        <button title="الغرف" aria-label="اختيار غرفة" onClick={()=>openPanel("rooms")}><Icon name="rooms"/><span>الغرف</span></button>
        <button title="تكبير المخطط" aria-label="تكبير المخطط" onClick={()=>{setFloor(current.floor);openPanel("map");}}><Icon name="map"/><span>المخطط</span></button>
        <button title="إظهار أو إخفاء المخطط" aria-label={(mobile?mobileMapVisible:mapVisible)?"إخفاء المخطط المصغّر":"إظهار المخطط المصغّر"} aria-pressed={mobile?mobileMapVisible:mapVisible} onClick={()=>{setMinimapVisible(!(mobile?mobileMapVisible:mapVisible));openPanel(null);}}><Icon name="eye"/><span>إظهار / إخفاء</span></button>
        <button title="تفاصيل الوحدة" aria-label="تفاصيل الوحدة" onClick={()=>openPanel("info")}><Icon name="info"/><span>الوحدة</span></button>
        <button title={measurementsVisible?"إخفاء القياسات":"إظهار القياسات"} aria-label={measurementsVisible?"إخفاء القياسات":"إظهار القياسات"} aria-pressed={!measurementsVisible} onClick={()=>{setMeasurementsVisible(value=>!value);setSelectedMeasurement(null);setPoints([]);openPanel(null);}}><Icon name={measurementsVisible?"eye":"eye-off"}/><span>{measurementsVisible?"إخفاء القياسات":"إظهار القياسات"}</span></button>
        <button title="القياس" aria-label="القياس على الصورة" onClick={toggleMeasurement}><Icon name="measure"/><span>القياس</span></button>
        <button title="ملء الشاشة" aria-label="ملء الشاشة" onClick={()=>{openPanel(null);toggleFullscreen();}}><Icon name="expand"/><span>ملء الشاشة</span></button>
      </div>
    </Dialog>}
    {panel==="rooms"&&<Dialog title="الغرف" className="imo-rooms-dialog" onClose={()=>openPanel(null)}><div className="imo-room-titles">{choices.map(choice=><button key={choice.id} onPointerEnter={()=>warmTarget(choice.scene.id)} onFocus={()=>warmTarget(choice.scene.id)} onClick={()=>chooseRoom(choice.scene)}>{choice.name}</button>)}</div></Dialog>}
    {panel==="map"&&<Dialog title="مخطط الشقة" wide className="imo-map-dialog" onClose={()=>openPanel(null)}>{tour.plans.length>1&&<div className="imo-floor-tabs">{tour.plans.map(p=><button key={p.floor} className={p.floor===floor?"selected":""} onClick={()=>setFloor(p.floor)}>{p.label}</button>)}</div>}<ViewerFloorPlan cache={planCache} onIntent={warmTarget} scenes={tour.scenes} yaw={yaw} key={`${tour.id}/${floor}`} tourId={tour.id} floor={floor} current={current.id} sceneIds={tour.scenes.filter(s=>s.floor===floor).map(s=>s.id)} onSelect={id=>{const target=scenesById.current.get(id);if(target){void navigate(target,false);openPanel(null);}}} hasInteractivePlan={hasReviewedArchitecture(plan)}>{plan?<InteractiveFloorPlan tourTitle={tour.title} brandingName={branding?.name} mode={mapMode} onModeChange={setMapMode} spatialScale={tour.spatialScale} onMeasure={toggleMeasurement} plan={plan} scenes={tour.scenes} current={current.id} yaw={yaw} position={current.floor===floor?position??undefined:undefined} onSelect={id=>{const next=scenesById.current.get(id);if(next){void navigate(next,false);openPanel(null);}}}/>:<p role="status">لا يوجد مخطط جاهز لهذا الدور بعد.</p>}{hasReviewedArchitecture(plan)&&<p className="imo-muted">اختر موقعًا من المخطط للانتقال إليه.</p>}</ViewerFloorPlan></Dialog>}
    {(panel==="info"||panel==="lead")&&<Dialog title={panel==="lead"?"سجّل اهتمامك":"تفاصيل الوحدة"} onClose={()=>openPanel(null)}><UnitCard tour={tour} lead={panel==="lead"} onLead={()=>openPanel("lead")}/></Dialog>}
  </div>;
}
function UnitSummary({tour}:{tour:Tour}){
 const u=tour.unit;
 return <section className="imo-unit-summary" aria-label="تفاصيل الوحدة">
   <h2 className="imo-unit-summary-title">تفاصيل الوحدة</h2>
   <dl className="imo-unit-summary-stats">
     <div><dt><Icon name="area" size={18}/><span>المساحة م²</span></dt><dd>{u.area===null?"—":number(u.area)}</dd></div>
     <div><dt><Icon name="bed" size={18}/><span>غرف النوم</span></dt><dd>{u.bedrooms??"—"}</dd></div>
     <div><dt><Icon name="bath" size={18}/><span>الحمامات</span></dt><dd>{u.bathrooms??"—"}</dd></div>
   </dl>
   {u.price!==null&&<strong className="imo-unit-summary-price">{number(u.price)} <small>ر.س</small></strong>}
 </section>;
}
function UnitCard({tour,lead,onLead}:{tour:Tour;lead:boolean;onLead:()=>void}) {
  const [down,setDown]=useState(20),[rate,setRate]=useState(6),[years,setYears]=useState(20),[status,setStatus]=useState("");
  const [sending,setSending]=useState(false),[success,setSuccess]=useState(false);
  const u=tour.unit;
  return <div className="imo-unit-card"><span className="imo-eyebrow">{u.code||tour.title}</span>{u.price!==null&&<h3>{number(u.price)} <small>ر.س</small></h3>}
    <div className="imo-unit-stats"><span><b>{u.area===null?"—":number(u.area)}</b> م²</span><span><b>{u.bedrooms??"—"}</b> غرف نوم</span><span><b>{u.bathrooms??"—"}</b> دورات مياه</span></div>
    {lead?(success?<div className="imo-success"><Icon name="check" size={32}/><h3>تم تسجيل اهتمامك</h3><p>حُفظ طلبك لهذه الوحدة لدى إدارة المشروع.</p></div>:<form onSubmit={async e=>{e.preventDefault();setSending(true);setStatus("");const form=new FormData(e.currentTarget);try{await api("leads",{method:"POST",body:JSON.stringify({tourId:tour.id,name:form.get("name"),phone:form.get("phone"),note:form.get("note"),website:form.get("website"),consent:form.get("consent")==="on"})});setSuccess(true);}catch(e){setStatus(e instanceof Error?e.message:"تعذر إرسال الطلب");}finally{setSending(false);}}} className="imo-form">
      <label>الاسم<input name="name" required minLength={2} maxLength={100} autoComplete="name"/></label>
      <label>رقم الجوال<input name="phone" type="tel" required maxLength={80} autoComplete="tel" dir="ltr" placeholder="+966"/></label>
      <label>ملاحظات <small>اختياري</small><textarea name="note" maxLength={2000} rows={3}/></label>
      <input className="imo-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"/>
      <label className="imo-checkbox"><input type="checkbox" name="consent" required/> أوافق على حفظ بياناتي والتواصل معي بخصوص هذه الوحدة.</label>
      {status&&<p role="alert" className="imo-error">{status}</p>}<button disabled={sending} className="imo-button primary">{sending?"جارٍ الإرسال…":"إرسال الطلب"}</button>
    </form>):<>{u.price!==null&&<div className="imo-finance"><h4>احسب القسط التقريبي</h4><label>الدفعة الأولى <strong>{down}%</strong><input type="range" min={0} max={90} step={5} value={down} onChange={e=>setDown(+e.target.value)}/></label><div className="imo-two-cols"><label>المدة بالسنوات<input type="number" min={1} max={40} value={years} onChange={e=>setYears(Math.max(1,Math.min(40,+e.target.value)))}/></label><label>المعدل السنوي %<input type="number" min={0} max={25} step={0.1} value={rate} onChange={e=>setRate(Math.max(0,Math.min(25,+e.target.value)))}/></label></div><div className="imo-payment"><b>{number(monthlyPayment(u.price,down,rate,years))}</b><span>ر.س / شهر</span></div><p className="imo-muted">حساب تقديري بقسط ثابت؛ لا يشمل الرسوم أو التأمين ولا يمثل عرض تمويل.</p></div>}<button className="imo-button primary full" onClick={onLead}>سجّل اهتمامك بهذه الوحدة</button></>}
  </div>;
}
