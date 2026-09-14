import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runRoomAnalysis,validRoomProfile,validRoomDisplayDepth} from '../src/lib/imo3d/room-analysis.ts';

// Optional real-model smoke: read one known panorama and write diagnostics only.
// This script neither imports the store nor opens the production database.
const inputFile=process.argv[2];
if(!inputFile)throw Error('Provide the private layout-input.json path as the first argument. No default apartment is selected.');
const input=JSON.parse(await readFile(inputFile,'utf8'));
const scene=input.scenes[2],outputDir=path.resolve('work/room-analysis-smoke');
assert.ok(scene?.id&&scene?.path);
const digest=async()=>createHash('sha256').update(await readFile(scene.path)).digest('hex');
const before=await digest(),started=Date.now(),progress=[];
const result=await runRoomAnalysis({scenes:[scene],outputDir,assetRoots:[path.dirname(scene.path)],onProgress:value=>{progress.push(value);console.log(JSON.stringify(value));}});
assert.equal(await digest(),before,'The source panorama must remain byte-identical');
assert.equal(Object.keys(result.profiles).length,1,'The real boundary model must produce this panorama profile');
assert.equal(validRoomProfile(result.profiles[scene.id]),true);
assert.equal(result.observations.length,1,'The real local vision model must produce structured evidence');
assert.equal(result.observations[0].sceneId,scene.id);
assert.ok(progress.some(value=>value.stage==='boundaries'&&value.completed===1));
assert.ok(progress.some(value=>value.stage==='room_recognition'&&value.completed===1));
// Depth is optional when its local model is not installed. If present, its
// bounded nonmetric contract must hold; a missing model leaves the other stages.
if(result.displayDepths?.[scene.id]){
  assert.equal(validRoomDisplayDepth(result.displayDepths[scene.id]),true);
  assert.equal(result.displayDepths[scene.id].values.length,8192);
  assert.ok(progress.some(value=>value.stage==='photo_depth'&&value.completed===1));
}
await mkdir(outputDir,{recursive:true});
await writeFile(path.join(outputDir,'smoke-summary.json'),JSON.stringify({sceneId:scene.id,sourceSha256:before,elapsedSeconds:(Date.now()-started)/1000,progress,result},null,2));
console.log(JSON.stringify({ok:true,elapsedSeconds:(Date.now()-started)/1000,kind:result.observations[0].kind,confidence:result.observations[0].confidence,warnings:result.warnings}));
