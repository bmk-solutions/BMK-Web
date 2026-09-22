import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReconstructionProgress,reconstructionProgressPresentation} from '../src/lib/imo3d/reconstruction';

test('rectified feature preparation reaches the queue with a per-photo linking label',()=>{
 for(const completed of [0,1,24,100]){
  const event=parseReconstructionProgress({event:'progress',stage:'perspective_features',completed,total:100});
  assert.ok(event);
  assert.deepEqual(reconstructionProgressPresentation(event,67.7),{progress:67.7,stage:`تصحيح منظور الصور للربط · ${completed} / 100`});
 }
});
test('progress parser retains known stages and rejects invalid counters and unknown logs',()=>{
 for(const stage of ['features','matching','layout'])assert.ok(parseReconstructionProgress({event:'progress',stage,completed:0,total:1}));
 for(const value of [null,{}, {event:'error'}, {event:'progress',stage:'unknown',completed:1,total:2},
  ...[-1,1.5,101,Infinity].map(completed=>({event:'progress',stage:'perspective_features',completed,total:100})),
  {event:'progress',stage:'perspective_features',completed:0,total:0}])assert.equal(parseReconstructionProgress(value),null);
});
