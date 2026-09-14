// Run against image files only, then compare the output to held-out reference
// camera poses. Ground truth is read only AFTER the reconstruction completes.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runPanoramaReconstruction } from '../src/lib/imo3d/reconstruction.ts';

const directory = path.resolve('public/imo3d/example');
const names = (await readdir(directory)).filter(name => name.endsWith('.lite.webp')).sort();
const outputDir = path.resolve('work/reconstruction-evaluation');
const result = process.argv.includes('--reuse') ? JSON.parse(await readFile(path.join(outputDir,'result.json'),'utf8')) : await runPanoramaReconstruction({
  scenes: names.map(name => ({id:name.replace('.lite.webp',''),path:path.join(directory,name),floor:0})),
  outputDir, assetRoots:[directory],
  onProgress: event => process.stdout.write(JSON.stringify(event)+'\n'),
});
const groundTruth = JSON.parse(await readFile('src/lib/imo3d/example.json','utf8'));
const gtById = new Map(groundTruth.scenes.map(scene=>[path.basename(scene.image).replace('.full.webp',''),scene]));
const strongest = result.components[0];
const valid = result.scenes.filter(scene=>scene.position && scene.component===strongest.id && gtById.get(scene.id)?.position);
const pairs = result.pairs.map(pair=>{
  const a=gtById.get(pair.a),b=gtById.get(pair.b);
  return {...pair,heldOutDistance:Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z),
    heldOutAdjacent:a.links.includes(b.id)||b.links.includes(a.id)};
});
// Fit the single scale+rotation+translation gauge allowed by monocular SfM.
const average = values => values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length);
const sourceCentre = {x:average(valid.map(s=>s.position.x)),z:average(valid.map(s=>s.position.z))};
const targetCentre = {x:average(valid.map(s=>gtById.get(s.id).position.x)),z:average(valid.map(s=>gtById.get(s.id).position.z))};
let cross=0,dot=0,norm=0;
for(const scene of valid){
  const a={x:scene.position.x-sourceCentre.x,z:scene.position.z-sourceCentre.z};
  const gt=gtById.get(scene.id).position,b={x:gt.x-targetCentre.x,z:gt.z-targetCentre.z};
  cross+=a.x*b.z-a.z*b.x;dot+=a.x*b.x+a.z*b.z;norm+=a.x*a.x+a.z*a.z;
}
const angle=Math.atan2(cross,dot),scale=Math.hypot(cross,dot)/Math.max(1e-9,norm);
const errors=valid.map(scene=>{
  const a={x:scene.position.x-sourceCentre.x,z:scene.position.z-sourceCentre.z},gt=gtById.get(scene.id).position;
  return Math.hypot(scale*(Math.cos(angle)*a.x-Math.sin(angle)*a.z)+targetCentre.x-gt.x,
    scale*(Math.sin(angle)*a.x+Math.cos(angle)*a.z)+targetCentre.z-gt.z);
});
const yawErrors=valid.map(scene=>{
  const difference=(scene.yaw+angle*180/Math.PI-gtById.get(scene.id).yaw)*Math.PI/180;
  return Math.atan2(Math.sin(difference),Math.cos(difference))*180/Math.PI;
});
const report={status:result.status,diagnostics:result.diagnostics,
  connectedComponents:result.components.map(component=>({id:component.id,count:component.sceneIds.length,layout:component.layout,bearingErrorDegrees:component.bearingErrorDegrees})),
  heldOutEvaluation:{evaluatedCameras:valid.length,similarityAlignedCameraRMSEMeters:Math.sqrt(average(errors.map(e=>e*e))),
    orientationRMSEDegrees:Math.sqrt(average(yawErrors.map(e=>e*e))),
    adjacentPairs:pairs.filter(pair=>pair.heldOutAdjacent).length,totalPairs:pairs.length,
    maxPairDistanceMeters:Math.max(0,...pairs.map(pair=>pair.heldOutDistance)),
    note:'Evaluation uses held-out original camera coordinates after image-only processing. No ground-truth values become reconstruction inputs.'},
  pairs,warnings:result.warnings};
await writeFile(path.join(outputDir,'evaluation.json'),JSON.stringify(report,null,2),'utf8');
process.stdout.write(JSON.stringify({...report,pairs:undefined},null,2)+'\n');
