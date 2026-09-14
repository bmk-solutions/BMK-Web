import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {aiPlanFingerprint,enqueueAIPlan,claimAIPlanJob,cancelAIPlanJob,heartbeatAIPlanJob,staleAIPlanJob,recoverAIPlanJobs,latestAIPlanJob} from '../src/lib/imo3d/ai-plan-jobs';
function fixture(){const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tours(id TEXT PRIMARY KEY); INSERT INTO tours VALUES('t');");return db;}
test('AI plan deduplicates active jobs and claims only once',()=>{
 const db=fixture();try{
  const a=enqueueAIPlan(db,'t','one'),b=enqueueAIPlan(db,'t','two');assert.equal(a.id,b.id);
  assert.equal(db.prepare('SELECT input_hash FROM ai_plan_jobs WHERE id=?').get(a.id)?.input_hash,'one');
  assert.ok(claimAIPlanJob(db,a.id));assert.equal(claimAIPlanJob(db,a.id),undefined);
 }finally{db.close();}
});
test('AI plan cancel/stale states reject late heartbeats and allow explicit new work',()=>{
 const db=fixture();try{
  const a=enqueueAIPlan(db,'t','one');claimAIPlanJob(db,a.id);assert.equal(cancelAIPlanJob(db,'t'),1);
  assert.equal(heartbeatAIPlanJob(db,a.id),false);assert.equal(latestAIPlanJob(db,'t')?.status,'cancelled');
  const b=enqueueAIPlan(db,'t','two');assert.notEqual(a.id,b.id);claimAIPlanJob(db,b.id);staleAIPlanJob(db,b.id);
  assert.equal(heartbeatAIPlanJob(db,b.id),false);assert.equal(latestAIPlanJob(db,'t')?.status,'stale');
 }finally{db.close();}
});
test('expired AI plan worker cannot claim or revive and recovery does not retry paid calls',()=>{
 const db=fixture();try{
  const a=enqueueAIPlan(db,'t','one');db.prepare('UPDATE ai_plan_jobs SET lease_until=0 WHERE id=?').run(a.id);
  assert.equal(claimAIPlanJob(db,a.id),undefined);recoverAIPlanJobs(db);assert.equal(latestAIPlanJob(db,'t')?.status,'failed');
  const b=enqueueAIPlan(db,'t','two');claimAIPlanJob(db,b.id);db.prepare('UPDATE ai_plan_jobs SET lease_until=0 WHERE id=?').run(b.id);
  assert.equal(heartbeatAIPlanJob(db,b.id),false);recoverAIPlanJobs(db);assert.equal(latestAIPlanJob(db,'t')?.status,'failed');
 }finally{db.close();}
});
test('AI plan response strips nested local paths, tolerates malformed result and cascades on tour deletion',()=>{
 const db=fixture();try{
  const a=enqueueAIPlan(db,'t','one');db.prepare('UPDATE ai_plan_jobs SET result=? WHERE id=?').run(JSON.stringify({source:'manual-imagegen-draft',sceneCount:1,limitations:[],floors:[{floor:0,sceneIds:['s'],imagePath:'C:/private/image.png',analysisPath:'C:/private/report.json',auditPath:'C:/private/audit.json',audit:{verdict:'issues_found',issues:[],limitations:[],private:'hidden'}}]}),a.id);
  const result=latestAIPlanJob(db,'t')?.result;assert.equal(result?.source,'manual-imagegen-draft');assert.equal(JSON.stringify(result).includes('private'),false);
  db.prepare("UPDATE ai_plan_jobs SET result='bad' WHERE id=?").run(a.id);assert.equal(latestAIPlanJob(db,'t')?.result,null);
  db.prepare("DELETE FROM tours WHERE id='t'").run();assert.equal(latestAIPlanJob(db,'t'),null);
 }finally{db.close();}
});
test('scene membership, image and floor changes invalidate fingerprint while order does not',()=>{
 const scenes=[{id:'a',image:'/a',floor:0},{id:'b',image:'/b',floor:0}];
 assert.equal(aiPlanFingerprint(scenes),aiPlanFingerprint([...scenes].reverse()));
 assert.notEqual(aiPlanFingerprint(scenes),aiPlanFingerprint(scenes.slice(1)));
 assert.notEqual(aiPlanFingerprint(scenes),aiPlanFingerprint(scenes.map(s=>({...s,floor:1}))));
 assert.notEqual(aiPlanFingerprint(scenes),aiPlanFingerprint(scenes.map(s=>({...s,image:s.image+'new'}))));
});
