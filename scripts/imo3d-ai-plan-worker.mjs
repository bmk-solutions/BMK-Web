import {DatabaseSync} from 'node:sqlite';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {aiPlanFingerprint,claimAIPlanJob,heartbeatAIPlanJob,staleAIPlanJob} from '../src/lib/imo3d/ai-plan-jobs.ts';
import {runOpenAIFloorplanPipeline} from '../src/lib/imo3d/openai-floorplan-pipeline.ts';
const id=process.argv[2];if(!/^[\w-]{1,80}$/.test(id??''))process.exit(1);
const directory=path.resolve(process.env.IMO3D_DATA_DIR||'.imo3d-data'),database=new DatabaseSync(path.join(directory,'imo3d.sqlite'));
database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const job=claimAIPlanJob(database,id);if(!job){database.close();process.exit(0);}
const outputDir=path.join(directory,'ai-plans',id),controller=new AbortController();
const load=()=>{const row=database.prepare('SELECT payload FROM tours WHERE id=?').get(job.tour_id);return row?JSON.parse(row.payload):null;};
const valid=()=>{const tour=load();return tour&&aiPlanFingerprint(tour.scenes)===job.input_hash;};
const heartbeat=setInterval(()=>{
 try{if(!valid()){staleAIPlanJob(database,id);controller.abort();return;}
 if(!heartbeatAIPlanJob(database,id))controller.abort();}catch{controller.abort();}
},3000);
let retained=false;
try{
 const tour=load();if(!tour||!valid())throw Error('STALE');
 const scenes=tour.scenes.map(scene=>{
  const row=database.prepare('SELECT file FROM scene_originals WHERE scene_id=? AND tour_id=?').get(scene.id,tour.id)||database.prepare('SELECT file FROM assets WHERE id=? AND tour_id=?').get(scene.image.split('/').at(-1),tour.id);
  let file;if(row){if(path.basename(String(row.file))!==row.file)throw Error('ASSET');file=path.join(directory,'assets',String(row.file));}
  else if(/^\/imo3d\/example\/[\w.-]+$/.test(scene.image))file=path.join(process.cwd(),'public',scene.image);else throw Error('ASSET');
  return {id:scene.id,floor:scene.floor,path:file};
 });
 await mkdir(outputDir,{recursive:true});
 const result=await runOpenAIFloorplanPipeline({scenes,outputDir,apiKey:process.env.OPENAI_API_KEY||'',signal:controller.signal,onProgress:p=>{
  controller.signal.throwIfAborted();const progress=p.stage==='analysis'?p.completed/Math.max(1,p.total)*60:p.stage==='layout'?65:p.stage==='generation'?75:p.stage==='audit'?85:99;
  const label=p.stage==='analysis'?'تحليل اللقطات':p.stage==='layout'?'تثبيت توزيع الغرف والأبواب':p.stage==='generation'?'رسم المخطط':p.stage==='audit'?'مراجعة بصرية للمخطط':'تجهيز المسودة';
  if(!database.prepare("UPDATE ai_plan_jobs SET progress=?,stage=? WHERE id=? AND status='running'").run(progress,`${label} · ${p.completed}/${p.total}`,id).changes){controller.abort();controller.signal.throwIfAborted();}
 }});
 database.exec('BEGIN IMMEDIATE');try{
  if(!valid())throw Error('STALE');
  // Only store a private draft. Generated pixels are never treated as measured geometry.
  const changed=database.prepare("UPDATE ai_plan_jobs SET status='draft',progress=100,stage='مسودة جاهزة للمراجعة',result=?,updated_at=? WHERE id=? AND status='running' AND lease_until>=?").run(JSON.stringify(result),new Date().toISOString(),id,Date.now());retained=!!changed.changes;database.exec('COMMIT');
 }catch(error){database.exec('ROLLBACK');throw error;}
}catch(error){
 const message=error?.message==='STALE'?'تغيرت صور الجولة؛ أعد التوليد.':error?.message==='ASSET'?'إحدى الصور الأصلية غير متاحة.':'تعذر إكمال التحليل. تحقق من مفتاح OpenAI ورصيد الحساب وصلاحية النماذج ثم أعد المحاولة. قد تُحتسب الطلبات التي اكتملت قبل التوقف.';
 database.prepare("UPDATE ai_plan_jobs SET status='failed',error=?,stage='لم يكتمل المخطط' WHERE id=? AND status='running'").run(message,id);
}finally{
 clearInterval(heartbeat);
 // Delete only this validated job's child directory, never the private data root.
 const expectedRoot=path.resolve(directory,'ai-plans'),relative=path.relative(expectedRoot,path.resolve(outputDir));
 try{if(!retained&&relative===id&&!path.isAbsolute(relative))await rm(outputDir,{recursive:true,force:true});}finally{database.close();}
}
