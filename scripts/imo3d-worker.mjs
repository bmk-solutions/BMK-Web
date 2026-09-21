import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {claimJob,ensureProcessingTables,heartbeatJob,imageFingerprint} from '../src/lib/imo3d/processing-jobs.ts';
import {runPanoramaReconstruction} from '../src/lib/imo3d/reconstruction.ts';
import {buildEstimatedPlans,preserveAuthoredFloorState,selectLargestConnectedComponents} from '../src/lib/imo3d/reconstruction-layout.ts';
import {cleanupProcessingArtifacts,unreferencedInputAssetFiles} from '../src/lib/imo3d/processing-cleanup.ts';
import {cleanupPrivateAssetFiles} from '../src/lib/imo3d/private-asset-cleanup.ts';
import {applyConnectionOverrides,rebaseManualLinkYaws} from '../src/lib/imo3d/connection-overrides.ts';
import {runRoomAnalysis} from '../src/lib/imo3d/room-analysis.ts';
import {runJointDepth} from '../src/lib/imo3d/joint-depth.ts';
import {currentSurfaceModel,encodeSurfaceModel,surfaceModelFloorHeight,surfaceModelMime} from '../src/lib/imo3d/surface-model.ts';
import {applyDepthArchitecture,runDepthArchitecture} from '../src/lib/imo3d/depth-architecture.ts';
import {supportedDisplayDepth,fillMissingDisplayDepth} from '../src/lib/imo3d/display-depth.ts';
import {applyRoomSemantics} from '../src/lib/imo3d/room-semantics.ts';

const directory=path.resolve(process.env.IMO3D_DATA_DIR||'.imo3d-data');
await mkdir(directory,{recursive:true});
const db=new DatabaseSync(path.join(directory,'imo3d.sqlite'));db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
ensureProcessingTables(db);const owner=randomUUID();
const lock=db.prepare("INSERT INTO processing_worker_lock(name,owner,lease_until) VALUES('reconstruction',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE processing_worker_lock.lease_until<? RETURNING owner").get(owner,Date.now()+30_000,Date.now());
if(!lock){db.close();process.exit(0);}
const loadTour=id=>{const row=db.prepare('SELECT payload FROM tours WHERE id=?').get(id);return row?JSON.parse(row.payload):null;};
let stopped=false,activeController=null;
const renew=setInterval(()=>{try{const now=Date.now();const result=db.prepare("UPDATE processing_worker_lock SET lease_until=? WHERE name='reconstruction' AND owner=? AND lease_until>=?").run(now+30_000,owner,now);if(result.changes)return;}catch(error){console.error('Worker lease renewal failed',error.message);}stopped=true;activeController?.abort();},4000);
process.on('SIGTERM',()=>{stopped=true;activeController?.abort();});process.on('SIGINT',()=>{stopped=true;activeController?.abort();});

function assetPath(scene,tourId,useOriginal=true){
  const original=useOriginal&&db.prepare('SELECT file FROM scene_originals WHERE scene_id=? AND tour_id=?').get(scene.id,tourId);
  if(original)return path.join(directory,'assets',String(original.file));
  const match=/^\/api\/imo3d\/assets\/([\w-]+)$/.exec(scene.image);
  if(match){const asset=db.prepare('SELECT file FROM assets WHERE id=? AND tour_id=?').get(match[1],tourId);if(!asset)throw Error('صورة من الجولة غير متوفرة.');return path.join(directory,'assets',String(asset.file));}
  if(/^\/imo3d\/example\/[\w.-]+$/.test(scene.image))return path.join(process.cwd(),'public',scene.image);
  throw Error('مسار صورة غير صالح للمعالجة.');
}
function validResult(result,scenes){
  const ids=new Set(scenes.map(s=>s.id));
  if(result.scenes.length!==ids.size||new Set(result.scenes.map(s=>s.id)).size!==ids.size)throw Error('قائمة نتائج الصور غير مكتملة.');
  for(const scene of result.scenes){if(!ids.has(scene.id)||!Array.isArray(scene.links)||!Number.isFinite(scene.yaw)||scene.links.some(id=>!ids.has(id)))throw Error('بيانات الربط الناتجة غير صالحة.');
    if(scene.visualLinks&&(!Array.isArray(scene.visualLinks)||scene.visualLinks.length>200||new Set(scene.visualLinks.map(link=>link.targetId)).size!==scene.visualLinks.length||scene.visualLinks.some(link=>!scene.links.includes(link.targetId)||!Number.isFinite(link.yaw))))throw Error('اتجاه رابط بصري غير صالح.');
    if(scene.position&&(!['x','y','z'].every(k=>Number.isFinite(scene.position[k])&&Math.abs(scene.position[k])<1e6)))throw Error('موضع صورة غير صالح.');}
}
function proposedScenes(current,result,placedIds,displayDepths){
  const byId=new Map(result.scenes.map(scene=>[scene.id,scene]));
  return current.scenes.map(scene=>{const value=byId.get(scene.id);return {...scene,position:placedIds.has(scene.id)?value.position:null,yaw:value.yaw,manualLinks:rebaseManualLinkYaws(scene,value.yaw),visualLinks:value.visualLinks??[],depth:undefined,displayDepth:displayDepths[scene.id],links:value.links.filter(id=>byId.get(id)?.links.includes(scene.id))};});
}
async function processJob(job){
  const tour=loadTour(job.tour_id);if(!tour)throw Error('الجولة لم تعد موجودة.');
  if(imageFingerprint(tour.scenes)!==job.input_hash){finish(job,'stale','تغيّرت صور الجولة؛ ابدأ معالجة جديدة.');return;}
  const controller=new AbortController();activeController=controller;
  let inputPaths=[];const preparedModels=[],surfaceCleanup=[];
  let progress=1,stage='تجهيز الصور',leaseLost=false;
  const heartbeat=setInterval(()=>{try{if(heartbeatJob(db,job.id,owner,progress,stage))return;}catch(error){console.error('Job lease renewal failed',error.message);}leaseLost=true;controller.abort();},2000);
  try{
    const inputScenes=tour.scenes.map(scene=>({id:scene.id,floor:scene.floor,path:assetPath(scene,tour.id)}));
    inputPaths=inputScenes.map(scene=>scene.path);
    const outputDir=path.join(directory,'processing',job.id),assetRoots=[directory,path.join(process.cwd(),'public/imo3d/example')];
    const analysisProgress={boundaries:0,room_recognition:0,photo_depth:0};
    const previewScenes=tour.scenes.map(scene=>({id:scene.id,path:assetPath({...scene,image:scene.preview},tour.id,false)}));
    const analysis=await runRoomAnalysis({scenes:previewScenes,outputDir,assetRoots,signal:controller.signal,onProgress:p=>{
      analysisProgress[p.stage]=p.total?p.completed/p.total:0;progress=2+8*analysisProgress.boundaries+12*analysisProgress.room_recognition+16*analysisProgress.photo_depth;
      stage=`${p.stage==='boundaries'?'استخراج حدود الغرف':p.stage==='photo_depth'?'تحسين عمق الانتقال':'التعرف على الغرف'} · ${p.completed} / ${p.total}`;
      if(!heartbeatJob(db,job.id,owner,progress,stage)){leaseLost=true;controller.abort();}
    }});
    if(leaseLost||controller.signal.aborted)return;
    const result=await runPanoramaReconstruction({scenes:inputScenes,outputDir,assetRoots,roomProfiles:analysis.profiles,roomObservations:analysis.observations,signal:controller.signal,onProgress:p=>{
      const ratio=p.total?Math.min(1,p.completed/p.total):0;
      progress=p.stage==='features'?38+ratio*12:p.stage==='matching'?50+ratio*26:76+ratio*4;
      stage=`${p.stage==='features'?'تحليل الصور':p.stage==='matching'?'مطابقة اللقطات':'تقدير مواقع التصوير'} · ${p.completed} / ${p.total}`;
      if(!heartbeatJob(db,job.id,owner,progress,stage)){leaseLost=true;controller.abort();}
    }});
    if(leaseLost||controller.signal.aborted)return;
    validResult(result,tour.scenes);
    // Independent components do not share an origin or scale. Only the largest
    // component on each real floor belongs on that floor's coordinate drawing.
    const placedIds=selectLargestConnectedComponents(tour.scenes,result);
    const registered=placedIds.size;
    const previewById=new Map(previewScenes.map(scene=>[scene.id,scene.path]));
    const cameraHeightComponents=new Set(result.components.filter(component=>component.scaleBasis==='camera_height').map(component=>component.id));
    const jointScenes=result.scenes.filter(scene=>placedIds.has(scene.id)&&scene.position&&cameraHeightComponents.has(scene.component)).map(scene=>({id:scene.id,path:previewById.get(scene.id),position:scene.position,yaw:scene.yaw,componentId:scene.component,floor:scene.floor}));
    let joint={displayDepths:{},pointSamples:[],warnings:[]};
    if(jointScenes.length>=2&&(tour.spatialSource==='images'||!tour.scenes.some(scene=>scene.position))){
      try{joint=await runJointDepth({scenes:jointScenes,links:result.pairs.map(pair=>({from:pair.a,to:pair.b})),roomProfiles:analysis.profiles,retainGeometryEvidence:true,outputDir,assetRoots,signal:controller.signal,onProgress:p=>{
        progress=80+16*p.completed/p.total;stage=`دمج الأسطح بين الصور · ${p.completed} / ${p.total}`;
        if(!heartbeatJob(db,job.id,owner,progress,stage)){leaseLost=true;controller.abort();}
      }});}catch(error){if(leaseLost||controller.signal.aborted)return;joint.warnings.push(error?.message||'تعذّر دمج الأسطح محليًا؛ حُفظت نتائج التحليل المتاحة.');}
    }
    if(leaseLost||controller.signal.aborted)return;
    // A sparse verified fragment is useful architectural evidence, but must not
    // replace a panorama's broader rendering fallback and introduce new holes.
    const displayDepths={...analysis.displayDepths};for(const [id,depth] of Object.entries(joint.displayDepths))if(supportedDisplayDepth(depth))displayDepths[id]=depth;
    for(const floor of new Set(jointScenes.map(scene=>scene.floor))){
      const members=jointScenes.filter(scene=>scene.floor===floor),ids=new Set(members.map(scene=>scene.id));
      const points=joint.pointSamples.filter(point=>point.sceneIds.every(id=>ids.has(id)));
      if(points.length<2000)continue;
      const floorHeight=surfaceModelFloorHeight(points,members),id=randomUUID(),file=`${id}.surface.bin`;
      await mkdir(path.join(directory,'assets'),{recursive:true});
      const handle=await open(path.join(directory,'assets',file),'wx');surfaceCleanup.push(file);
      try{await handle.writeFile(encodeSurfaceModel(points,floorHeight));}finally{await handle.close();}
      const sources=new Map(tour.scenes.map(scene=>[scene.id,scene]));
      preparedModels.push({floor,id,file,model:{url:`/api/imo3d/assets/${id}`,pointCount:points.length,floorHeight,source:'da3-base-pose-conditioned-multiview',units:'camera_height',cameras:members.map(scene=>({id:scene.id,image:sources.get(scene.id).image,position:scene.position,yaw:scene.yaw}))}});
    }
    let architecture;
    if(joint.pointSamples.length){
      progress=97;stage='تدقيق الجدران المعمارية';
      const initialSemantics=applyRoomSemantics(applyConnectionOverrides(proposedScenes(tour,result,placedIds,displayDepths)),{observations:[...analysis.observations,...(result.roomObservations??[])],relations:result.roomRelations??[],suiteObservations:analysis.suiteObservations});
      const initialPlans=preserveAuthoredFloorState(tour.scenes,tour.plans,initialSemantics.scenes,buildEstimatedPlans(initialSemantics.scenes,result)).plans.filter(plan=>plan.reviewStatus!=='rejected');
      try{if(initialPlans.length)architecture=await runDepthArchitecture({points:joint.pointSamples,scenes:jointScenes,plans:initialPlans,outputDir,signal:controller.signal});}
      catch(error){if(leaseLost||controller.signal.aborted)return;joint.warnings.push(error?.message||'تعذر تدقيق بعض الجدران؛ بقيت الحدود السابقة محفوظة.');}
    }
    if(leaseLost||controller.signal.aborted)return;
    const summary={registered,total:tour.scenes.length,links:result.pairs.length,components:result.components.length,scale:'relative',boundaryPhotos:Object.keys(analysis.profiles).length,recognizedPhotos:analysis.observations.filter(observation=>observation.kind!=='unknown').length,jointDepthPhotos:Object.keys(joint.displayDepths).length,jointPoints:joint.pointSamples.length,rooms:0};
    const warnings=[...analysis.warnings,...result.warnings,...joint.warnings,...(architecture?.warnings??[]),'الحدود والمواقع مستخرجة بصريًا وتحتاج مراجعة؛ المقياس نسبي ولا يمثل قياسات بالمتر.'];
    if(result.roomLayout?.architectureDiagnostics?.some(diagnostic=>diagnostic.reason==='visual_sightline_through_third_room'))warnings.push('بعض اللقطات ترى الغرفة عبر فراغ آخر؛ حُفظ الربط البصري دون رسم باب مباشر غير مثبت.');
    if(registered<result.scenes.filter(s=>s.position).length)warnings.unshift('يعرض المخطط أكبر مجموعة متصلة في كل دور. المجموعات الأخرى مستقلة الإحداثيات وتبقى متاحة من قائمة الغرف؛ أضف صورًا متداخلة لربطها.');
    db.exec('BEGIN IMMEDIATE');
    try{
      const authority=db.prepare("SELECT * FROM processing_jobs WHERE id=? AND lease_owner=? AND status='running' AND lease_until>=? AND cancel_requested=0").get(job.id,owner,Date.now());
      const current=loadTour(tour.id);
      const workerAuthority=db.prepare("SELECT owner FROM processing_worker_lock WHERE name='reconstruction' AND owner=? AND lease_until>=?").get(owner,Date.now());
      if(!authority||!workerAuthority){db.exec('ROLLBACK');return;}
      if(!current||imageFingerprint(current.scenes)!==job.input_hash){finish(job,'stale','تغيّرت صور الجولة أثناء المعالجة. حُفظت التعديلات؛ ابدأ معالجة جديدة.');db.exec('COMMIT');return;}
      let status=result.status==='ready'&&!analysis.warnings.length&&!joint.warnings.length&&!architecture?.warnings?.length?'completed':'review',next=null;
      if(current.spatialSource!=='images'&&current.scenes.some(s=>s.position)){
        status='review';warnings.unshift('تم تحليل الصور وحفظ النتيجة للمراجعة مع إبقاء معايرة الكاميرات والمخطط المعتمد.');
        const scenes=fillMissingDisplayDepth(current.scenes,analysis.displayDepths??{});
        if(scenes.some((scene,index)=>scene!==current.scenes[index]))next={...current,scenes,revision:current.revision+1,updatedAt:new Date().toISOString()};
      }else if(registered>=2){
        const proposed=proposedScenes(current,result,placedIds,displayDepths);
        const semantics=applyRoomSemantics(applyConnectionOverrides(proposed),{observations:[...analysis.observations,...(result.roomObservations??[])],relations:result.roomRelations??[],suiteObservations:analysis.suiteObservations});
        warnings.push(...semantics.warnings);if(semantics.warnings.length)status='review';
        const generated=buildEstimatedPlans(semantics.scenes,result),refined=applyDepthArchitecture(generated,semantics.scenes,architecture);
        const preserved=preserveAuthoredFloorState(current.scenes,current.plans,semantics.scenes,refined);
        const {protectedFloors}=preserved;
        const scenes=applyConnectionOverrides(preserved.scenes);
        const plans=preserved.plans.map(plan=>{const prepared=preparedModels.find(value=>value.floor===plan.floor);return prepared&&!protectedFloors.has(plan.floor)?{...plan,surfaceModel:prepared.model}:plan;});
        if(plans.some(plan=>plan.reviewStatus==='rejected')){status='review';warnings.unshift('يبقى المخطط المرفوض مخفيًا؛ إعادة التحليل لا تعني اعتماد صحة هندسته.');}
        if(protectedFloors.size){status='review';warnings.unshift('حُفظت حدود الغرف المعتمدة ومواضعها وروابطها؛ حُدّثت اتجاهات الصور المتطابقة فقط داخل الأدوار المعتمدة.');}
        next={...current,scenes,plans,spatialSource:'images',spatialScale:protectedFloors.size?current.spatialScale:'relative',initialView:protectedFloors.has(current.scenes[0]?.floor)?current.initialView:undefined,revision:current.revision+1,updatedAt:new Date().toISOString(),quality:{positioned:scenes.filter(scene=>scene.position).length,depthScenes:scenes.filter(scene=>scene.depth).length,components:result.components.length,warnings}};
      }else{
        status='review';
        // Useful room recognition survives a batch with insufficient spatial overlap.
        if(analysis.observations.length||analysis.displayDepths){const semantics=applyRoomSemantics(fillMissingDisplayDepth(current.scenes,analysis.displayDepths??{}),{observations:analysis.observations,relations:[],suiteObservations:analysis.suiteObservations});warnings.push(...semantics.warnings);next={...current,scenes:semantics.scenes,revision:current.revision+1,updatedAt:new Date().toISOString(),quality:{...current.quality,warnings}};}
      }
      summary.rooms=(next??current).plans.reduce((count,plan)=>count+(plan.authoredRooms??plan.generatedRooms??[]).length,0);
      if(next){
        const retainedModels=new Set(next.plans.flatMap(plan=>{const model=currentSurfaceModel(plan,next.scenes);return model?[model.url]:[];}));
        for(const prepared of preparedModels)if(retainedModels.has(prepared.model.url))db.prepare('INSERT INTO assets(id,tour_id,file,mime) VALUES(?,?,?,?)').run(prepared.id,next.id,prepared.file,surfaceModelMime);
        for(const old of db.prepare('SELECT id,file FROM assets WHERE tour_id=? AND mime=?').all(next.id,surfaceModelMime))if(!retainedModels.has(`/api/imo3d/assets/${old.id}`)){
          db.prepare('DELETE FROM assets WHERE id=? AND tour_id=?').run(old.id,next.id);surfaceCleanup.push(String(old.file));
        }
        const changed=db.prepare('UPDATE tours SET payload=?,revision=? WHERE id=? AND revision=?').run(JSON.stringify(next),next.revision,next.id,current.revision);if(!changed.changes)throw Error('تغيرت الجولة أثناء حفظ النتائج.');
      }
      db.prepare('UPDATE processing_jobs SET status=?,progress=100,stage=?,result=?,warnings=?,updated_at=? WHERE id=? AND lease_owner=?').run(status,status==='completed'?'اكتمل الربط البصري':'اكتمل التحليل — راجع النتيجة',JSON.stringify(summary),JSON.stringify(warnings),new Date().toISOString(),job.id,owner);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{
    clearInterval(heartbeat);activeController=null;
    if(surfaceCleanup.length){try{const unused=[...new Set(surfaceCleanup)].filter(file=>!db.prepare('SELECT 1 FROM assets WHERE file=? LIMIT 1').get(file));await cleanupPrivateAssetFiles(directory,unused);}catch(error){console.error('Surface model cleanup failed',job.id,error.message);}}
    // Wait until Python exits before retrying files it held open or recreated.
    try{
      // Scene deletion can cancel a job without deleting its row. Only original
      // inputs that have no current references in either asset table qualify.
      const files=unreferencedInputAssetFiles(db,directory,inputPaths);
      const cleanup=await cleanupPrivateAssetFiles(directory,files);
      if(cleanup.failed.length)console.error('Deleted input asset cleanup incomplete',job.id,cleanup.failed);
    }catch(error){console.error('Deleted input asset cleanup failed',job.id,error.message);}
    try{
      const retained=db.prepare('SELECT id,status FROM processing_jobs WHERE id=?').get(job.id);
      // Cancelled jobs are never reclaimed: retry creates a fresh UUID. Keep all
      // artifacts for queued/running jobs, including another worker's new lease.
      if(!retained||retained.status==='cancelled'){
        const cleanup=await cleanupProcessingArtifacts(directory,[job.id]);
        if(cleanup.failed.length||cleanup.skipped.length)console.error('Inactive job artifact cleanup incomplete',cleanup);
      }
    }catch(error){console.error('Inactive job artifact cleanup failed',job.id,error.message);}
  }
}
function finish(job,status,error){db.prepare("UPDATE processing_jobs SET status=?,stage=?,error=?,updated_at=? WHERE id=? AND lease_owner=? AND status='running' AND lease_until>=? AND cancel_requested=0").run(status,status==='stale'?'تحتاج معالجة جديدة':'تعذرت المعالجة',error,new Date().toISOString(),job.id,owner,Date.now());}
try{
  let idle=0;
  while(!stopped){const job=claimJob(db,owner);if(!job){if(++idle>5)break;await delay(2000);continue;}idle=0;
    try{await processJob(job);}catch(error){console.error(new Date().toISOString(),job.id,error);if(error?.name!=='AbortError')finish(job,'failed',String(error?.message||'تعذرت معالجة الصور').slice(0,1000));}
  }
}finally{clearInterval(renew);db.prepare("DELETE FROM processing_worker_lock WHERE name='reconstruction' AND owner=?").run(owner);db.close();}
