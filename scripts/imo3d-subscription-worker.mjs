import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';
import {withLocalCredential} from './lib/imo3d-local-credentials.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'work/subscription-worker-runtime'),files=new Set();
function compile(file){
 file=path.resolve(file);if(files.has(file))return;files.add(file);
 const source=readFileSync(file,'utf8');
 for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){
  let dependency=path.resolve(path.dirname(file),match[1]);if(!/\.tsx?$/.test(dependency))dependency+='.ts';compile(dependency);
 }
 const output=path.join(target,path.relative(root,file).replace(/\.ts$/,'.js'));mkdirSync(path.dirname(output),{recursive:true});
 writeFileSync(output,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,rewriteRelativeImportExtensions:true}}).outputText);
}
compile(path.join(root,'src/lib/imo3d/subscription-plan-worker.ts'));
const require=createRequire(import.meta.url);
const worker=require(path.join(target,'src/lib/imo3d/subscription-plan-worker.js'));
// IMO3D_PLAN_PROVIDER=codex: plans run on this PC's own Codex (the owner's ChatGPT subscription, `codex exec`);
// the Gemini provider is not injected and no Gemini credential is read. Unset keeps the Gemini provider.
const planProvider=(process.env.IMO3D_PLAN_PROVIDER||'gemini').trim().toLowerCase();
if(!['codex','gemini'].includes(planProvider)){console.log(JSON.stringify({status:'invalid-plan-provider'}));process.exit(2);}
if(process.argv.includes('--check'))console.log(JSON.stringify({status:'plan-runtime-imported',provider:planProvider,networkContacted:false}));
else if(planProvider==='codex'){
 const login=await worker.codexLoginStatus();
 if(!login.ok){console.log(JSON.stringify({status:'codex-login-unavailable',provider:'codex',mode:login.mode,build:login.build}));process.exit(2);}
 console.log(JSON.stringify({provider:'codex',status:'configured',mode:login.mode,build:login.build}));
 if(process.argv.includes('--check-credentials'))process.exit(0);
 await worker.runSubscriptionWorker(root,process.argv.includes('--once'));
}
else {
 const {createGeminiPlanProvider}=require(path.join(target,'src/lib/imo3d/gemini-plan-provider.js'));
 const provider=createGeminiPlanProvider(root,use=>withLocalCredential('gemini-api-key',use));
 try { await withLocalCredential('gemini-api-key',async()=>true); }
 catch {
  const checked=spawnSync(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/imo3d-local-credential-bridge.ps1'),'-Diagnostics'],{windowsHide:true,encoding:'utf8',timeout:15000,env:worker.subscriptionChildEnvironment(process.env)});
  let safe={configured:false,decryptable:false};try {const value=JSON.parse(checked.stdout);safe={configured:value.configured===true,decryptable:value.decryptable===true,...(typeof value.diagnostic==='string'&&/^[a-z_]+$/.test(value.diagnostic)?{diagnostic:value.diagnostic}:{})};}catch{}
  console.log(JSON.stringify({status:'private-credential-unavailable',...safe,bridgeExit:checked.status,bridgeOutput:!!checked.stdout,bridgeFailure:checked.error?.code??null}));process.exit(2);
 }
 console.log(JSON.stringify({provider:provider.id,status:'configured'}));
 if(process.argv.includes('--check-credentials'))process.exit(0);
 await worker.runSubscriptionWorker(root,process.argv.includes('--once'),provider);
}
