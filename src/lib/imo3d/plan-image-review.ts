import {floorplanAuditSchema} from './openai-floorplan-pipeline';
import {planImageDigest,matchesPlanImageDigest} from './plan-render-integrity';
import type {z} from 'zod';

type Audit=z.infer<typeof floorplanAuditSchema>;

/** A persisted candidate is never an approval. Every candidate, including a
 * resumed correction, must pass an independent audit of its exact bytes. */
export async function reviewAndRepairPlanImage<T extends {audit:Audit},P extends {png:Buffer}>(options:{
 candidate:T;repairsUsed?:number;signal:AbortSignal;
 validate:(value:unknown)=>T;
 read:(candidate:T)=>Promise<P>;
 audit:(candidate:T,image:P,repairsUsed:number)=>Promise<unknown>;
 repair:(candidate:T,image:P,audit:Audit)=>Promise<T>;
 checkpoint?:(candidate:T,image:P,imageSha256:string,repairsUsed:number)=>Promise<void>;
}){
 let candidate=options.validate(options.candidate),repairsUsed=options.repairsUsed??0;
 if(!Number.isInteger(repairsUsed)||repairsUsed<0||repairsUsed>1)throw Error('INVALID_IMAGE_REPAIR_COUNT');
 while(true){
  options.signal.throwIfAborted();
  const image=await options.read(candidate),imageSha256=planImageDigest(image.png);
  options.signal.throwIfAborted();
  await options.checkpoint?.(candidate,image,imageSha256,repairsUsed);
  options.signal.throwIfAborted();
  const audit=floorplanAuditSchema.parse(await options.audit(candidate,image,repairsUsed));
  options.signal.throwIfAborted();
  const expected=candidate.audit.reviewedSceneIds,actual=audit.reviewedSceneIds;
  if(actual.length!==expected.length||new Set(actual).size!==expected.length||actual.some(id=>!expected.includes(id)))throw Error('AUDIT_COVERAGE');
  const afterAudit=await options.read(candidate);
  options.signal.throwIfAborted();
  if(!matchesPlanImageDigest(afterAudit.png,imageSha256))throw Error('IMAGE_CHANGED_DURING_AUDIT');
  // A later reviewer cannot silently waive a generator or prior reviewer defect.
  // Only a correction, with fresh candidate metadata, can clear those findings.
  const knownIssues=candidate.audit.issues.length?candidate.audit.issues:candidate.audit.verdict!=='consistent'?['Candidate review remains unresolved.']:[];
  audit.issues=[...new Set([...knownIssues,...audit.issues])];
  audit.limitations=[...new Set([...candidate.audit.limitations,...audit.limitations])];
  if(audit.issues.length)audit.verdict='issues_found';
  if(audit.verdict==='consistent'&&!audit.issues.length){
   return {reviewed:options.validate({...candidate,audit}),image,imageSha256,repairsUsed};
  }
  if(repairsUsed>=1)throw Error('IMAGE_AUDIT_UNRESOLVED');
  // Consume the allowance before calling a potentially interrupted generator.
  // A resumed checkpoint must never restart an unlimited correction cycle.
  repairsUsed++;
  candidate=options.validate({...candidate,audit});
  await options.checkpoint?.(candidate,image,imageSha256,repairsUsed);
  options.signal.throwIfAborted();
  const corrected=await options.repair(candidate,image,audit);
  options.signal.throwIfAborted();
  candidate=options.validate(corrected);
  const correctedImage=await options.read(candidate);
  options.signal.throwIfAborted();
  if(matchesPlanImageDigest(correctedImage.png,imageSha256))throw Error('IMAGE_REPAIR_UNCHANGED');
 }
}
