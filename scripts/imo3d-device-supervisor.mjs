import {spawn} from 'node:child_process';
import {mkdir,appendFile,stat,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {superviseWorker} from './lib/imo3d-supervision.mjs';

const role=process.argv[2];
if(!['plans','photos'].includes(role))throw Error('Expected plans or photos');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const logDir=path.join(root,'work','device-workers');
await mkdir(logDir,{recursive:true});
const logFile=path.join(logDir,role+'.log');
let logQueue=Promise.resolve();
const log=value=>{logQueue=logQueue.then(async()=>{
  if(await stat(logFile).then(s=>s.size>8*1024*1024,()=>false))await rename(logFile,logFile+'.'+Date.now());
  await appendFile(logFile,value);
}).catch(()=>{});};
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
await superviseWorker({signal:controller.signal,wait:(ms,signal)=>delay(ms,undefined,{signal}),onStatus:value=>log(JSON.stringify({...value,at:new Date().toISOString()})+'\n'),run:signal=>new Promise(resolve=>{
  const worker=role==='plans'?'imo3d-subscription-worker.mjs':'imo3d-cloud-worker.mjs';
  const child=spawn(process.execPath,['--env-file='+path.join(root,'.env.cloud.local'),'--dns-result-order=ipv4first',path.join(root,'scripts',worker)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  log(JSON.stringify({status:'started',role,pid:child.pid,at:new Date().toISOString()})+'\n');
  child.stdout.on('data',chunk=>log(chunk));child.stderr.on('data',chunk=>log(chunk));
  const stop=()=>{if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');};
  signal.addEventListener('abort',stop,{once:true});
  child.once('error',()=>resolve());
  child.once('close',()=>{signal.removeEventListener('abort',stop);resolve();});
  if(signal.aborted)stop();
})});
await logQueue;
