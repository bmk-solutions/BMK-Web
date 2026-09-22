import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewAndRepairPlanImage} from '../src/lib/imo3d/plan-image-review';
import {floorplanAuditSchema} from '../src/lib/imo3d/openai-floorplan-pipeline';
import {z} from 'zod';
import {validateImageReviewMetadata,validateImageReview,validatePendingPlanImage} from '../src/lib/imo3d/subscription-plan-worker';

const schema=z.object({imagePath:z.string(),audit:floorplanAuditSchema});
type Candidate=z.infer<typeof schema>;
type Audit=z.infer<typeof floorplanAuditSchema>;
const good={verdict:'consistent' as const,reviewedSceneIds:['a'],issues:[],limitations:['Estimated, not surveyed']};
const bad={...good,verdict:'issues_found' as const,issues:['Missing photographed basin']};
const original:Candidate={imagePath:'first.png',audit:good};
const imageMetadata={...original,labels:[{roomId:'r',name:'غرفة',x:.5,y:.5}],baseImageHasNoText:true,reviewNotes:'Source-backed estimated draft',navigation:null};
test('initial generator issues or baked text enter review but cannot become approved metadata',()=>{
 for(const candidate of [{...imageMetadata,audit:bad},{...imageMetadata,baseImageHasNoText:false}]){
  assert.ok(validateImageReviewMetadata(candidate,['r'],['a']));
  assert.throws(()=>validateImageReview(candidate,['r'],['a']),/IMAGE_AUDIT_UNRESOLVED/);
 }
});
test('pending checkpoint retains known issues and never qualifies as an approved result',()=>{
 const checkpoint={generationStarted:10,imageSha256:'a'.repeat(64),geometryKey:'geometry-one',repairsUsed:1,repairJobId:'job-one',approval:'pending-independent-audit',reviewed:{...imageMetadata,audit:bad}};
 const checked=validatePendingPlanImage(checkpoint,'geometry-one',['r'],['a']);
 assert.equal(checked.repairsUsed,1);assert.deepEqual(checked.reviewed.audit.issues,bad.issues);
 assert.throws(()=>validateImageReview(checked.reviewed,['r'],['a']),/IMAGE_AUDIT_UNRESOLVED/);
 assert.throws(()=>validatePendingPlanImage(checkpoint,'geometry-two',['r'],['a']),/STALE/);
 assert.throws(()=>validatePendingPlanImage({...checkpoint,approval:true},'geometry-one',['r'],['a']));
 assert.throws(()=>validatePendingPlanImage({...checkpoint,repairsUsed:2},'geometry-one',['r'],['a']));
 assert.throws(()=>validatePendingPlanImage(checkpoint,'geometry-one',['other-room'],['a']),/COVERAGE/);
});
function fixture(audits:unknown[]){
 const auditCalls:string[]=[],repairCalls:string[]=[],checkpoints:{path:string;repairs:number;sha:string}[]=[];
 const controller=new AbortController();
 const options={candidate:original,signal:controller.signal,validate:(value:unknown)=>schema.parse(value),
  read:async(candidate:Candidate)=>({png:Buffer.from(candidate.imagePath),meta:{width:100,height:100}}),
  audit:async(candidate:Candidate)=>{auditCalls.push(candidate.imagePath);return audits.shift();},
  repair:async(candidate:Candidate,_image:unknown,audit:Audit)=>{repairCalls.push(candidate.imagePath);assert.deepEqual(audit.issues,bad.issues);return {imagePath:'corrected.png',audit:good};},
  checkpoint:async(candidate:Candidate,_image:unknown,sha:string,repairs:number)=>{checkpoints.push({path:candidate.imagePath,repairs,sha});},
 };
 return {options,controller,auditCalls,repairCalls,checkpoints};
}
test('a consistent independent audit accepts exact bytes without image correction',async()=>{
 const f=fixture([good]),result=await reviewAndRepairPlanImage(f.options);
 assert.equal(result.reviewed.imagePath,'first.png');assert.equal(result.repairsUsed,0);
 assert.deepEqual(f.auditCalls,['first.png']);assert.deepEqual(f.repairCalls,[]);
 assert.equal(result.imageSha256,f.checkpoints[0].sha);
});
test('one correction receives concrete issues and must pass a separate second audit',async()=>{
 const f=fixture([bad,good]),result=await reviewAndRepairPlanImage(f.options);
 assert.deepEqual(f.auditCalls,['first.png','corrected.png']);assert.deepEqual(f.repairCalls,['first.png']);
 assert.deepEqual(f.checkpoints.map(c=>[c.path,c.repairs]),[['first.png',0],['first.png',1],['corrected.png',1]]);
 assert.equal(result.repairsUsed,1);assert.equal(result.reviewed.imagePath,'corrected.png');
 assert.deepEqual(original,{imagePath:'first.png',audit:good},'original remains unchanged');
});
test('a failed correction remains unapproved and cannot start an unlimited repair loop',async()=>{
 const f=fixture([bad,bad]);await assert.rejects(reviewAndRepairPlanImage(f.options),/IMAGE_AUDIT_UNRESOLVED/);
 assert.equal(f.repairCalls.length,1);assert.equal(f.auditCalls.length,2);
 assert.equal(f.checkpoints.at(-1)!.repairs,1,'the unapproved correction records its consumed attempt');
});
test('resuming a corrected candidate always re-audits and retains the one-repair bound',async()=>{
 const f=fixture([bad]);await assert.rejects(reviewAndRepairPlanImage({...f.options,candidate:{...original,imagePath:'corrected.png'},repairsUsed:1}),/IMAGE_AUDIT_UNRESOLVED/);
 assert.deepEqual(f.auditCalls,['corrected.png']);assert.equal(f.repairCalls.length,0);
});
test('known candidate defects cannot be waived by a nominally consistent independent audit',async()=>{
 const f=fixture([good,good]);
 const result=await reviewAndRepairPlanImage({...f.options,candidate:{...original,audit:bad}});
 assert.equal(result.repairsUsed,1);assert.deepEqual(f.repairCalls,['first.png']);
 assert.deepEqual(f.auditCalls,['first.png','corrected.png']);
});
test('changing only metadata cannot clear known defects without correcting image bytes',async()=>{
 const f=fixture([bad,good]);
 await assert.rejects(reviewAndRepairPlanImage({...f.options,repair:async()=>({...original,audit:good})}),/IMAGE_REPAIR_UNCHANGED/);
 assert.equal(f.auditCalls.length,1);assert.equal(f.checkpoints.at(-1)!.repairs,1);
});
test('changed pixels during audit invalidate acceptance and do not trigger a repair',async()=>{
 const f=fixture([good]);let reads=0;
 await assert.rejects(reviewAndRepairPlanImage({...f.options,read:async()=>({png:Buffer.from(++reads===1?'original':'replaced')})}),/IMAGE_CHANGED_DURING_AUDIT/);
 assert.equal(f.repairCalls.length,0);
});
test('missing audit evidence cannot be bypassed with a nominally consistent verdict',async()=>{
 const f=fixture([{...good,reviewedSceneIds:['foreign']}]);
 await assert.rejects(reviewAndRepairPlanImage(f.options),/AUDIT_COVERAGE/);assert.equal(f.repairCalls.length,0);
});
test('cancellation after review prevents correction and successful return',async()=>{
 const f=fixture([bad]);
 await assert.rejects(reviewAndRepairPlanImage({...f.options,audit:async()=>{f.controller.abort();return bad;}}),{name:'AbortError'});
 assert.equal(f.repairCalls.length,0);
});
test('cancellation after correction prevents audit or checkpoint of the new candidate',async()=>{
 const f=fixture([bad]);
 await assert.rejects(reviewAndRepairPlanImage({...f.options,repair:async()=>{f.controller.abort();return {...original,imagePath:'new.png'};}}),{name:'AbortError'});
 assert.equal(f.auditCalls.length,1);assert.equal(f.checkpoints.length,2);assert.equal(f.checkpoints.at(-1)!.repairs,1);
});
