import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
const targetRoot=path.resolve('work/imo3d-cloud-tests');
const files=new Set();
function collect(file){file=path.resolve(file);if(files.has(file))return;files.add(file);const source=readFileSync(file,'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){let dependency=path.resolve(path.dirname(file),match[1]);if(dependency.endsWith('.css'))continue;if(!/\.[cm]?tsx?$/.test(dependency))dependency+='.ts';try{collect(dependency);}catch(error){if(error.code!=='ENOENT')throw error;}}}
collect('tests/imo3d-cloud-routes.test.ts');
for(const file of files){const output=path.join(targetRoot,path.relative(process.cwd(),file).replace(/\.ts$/,'.js'));mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,rewriteRelativeImportExtensions:true}}).outputText);}
const result=spawnSync(process.execPath,['--test',path.join(targetRoot,'tests/imo3d-cloud-routes.test.js')],{stdio:'inherit'});process.exit(result.status??1);
