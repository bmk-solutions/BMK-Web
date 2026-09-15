import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'work/subscription-worker-runtime'),files=new Set();
function compile(file){
 file=path.resolve(file);if(files.has(file))return;files.add(file);
 const source=readFileSync(file,'utf8');
 for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){
  let dependency=path.resolve(path.dirname(file),match[1]);if(!/\.tsx?$/.test(dependency))dependency+='.ts';compile(dependency);
 }
 const output=path.join(target,path.relative(root,file).replace(/\.ts$/,'.js'));mkdirSync(path.dirname(output),{recursive:true});
 writeFileSync(output,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
}
compile(path.join(root,'src/lib/imo3d/subscription-plan-worker.ts'));
const require=createRequire(import.meta.url);
await require(path.join(target,'src/lib/imo3d/subscription-plan-worker.js')).runSubscriptionWorker(root,process.argv.includes('--once'));
