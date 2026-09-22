import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
const targetRoot=path.resolve('work/imo3d-plan-quality-tests'),files=new Set();
function collect(file){
 file=path.resolve(file);if(files.has(file))return;files.add(file);
 for(const match of readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){
  let dependency=path.resolve(path.dirname(file),match[1]);if(!/\.[cm]?tsx?$/.test(dependency))dependency+='.ts';collect(dependency);
 }
}
const tests=['tests/imo3d-plan-quality.test.ts','tests/imo3d-plan-recovery.test.ts','tests/imo3d-plan-render-integrity.test.ts','tests/imo3d-plan-output-schema.test.ts','tests/imo3d-plan-image-review.test.ts'];
tests.forEach(collect);
for(const file of files){
 const output=path.join(targetRoot,path.relative(process.cwd(),file).replace(/\.ts$/,'.js'));mkdirSync(path.dirname(output),{recursive:true});
 writeFileSync(output,ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,rewriteRelativeImportExtensions:true}}).outputText);
}
const result=spawnSync(process.execPath,['--test',...tests.map(file=>path.join(targetRoot,file.replace(/\.ts$/,'.js')))],{stdio:'inherit'});process.exit(result.status??1);
