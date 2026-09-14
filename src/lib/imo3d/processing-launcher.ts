import {spawn} from "node:child_process";
import {mkdirSync,openSync,closeSync} from "node:fs";
// Worker files and private logs live in the runtime checkout, not build assets.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");
import {dataDirectory} from "./store";

let lastLaunch=0;
/** The worker lives outside the request and survives closing/reloading Studio. */
export function wakeProcessingWorker(){
  if(Date.now()-lastLaunch<5_000)return;lastLaunch=Date.now();
  const directory=dataDirectory();mkdirSync(directory,{recursive:true});
  const log=openSync(path.join(directory,"processing-worker.log"),"a");
  const child=spawn(process.execPath,[path.join(process.cwd(),"scripts","imo3d-worker.mjs")],{
    cwd:process.cwd(),env:{...process.env,IMO3D_DATA_DIR:directory},detached:true,windowsHide:true,stdio:["ignore",log,log],
  });
  child.on("error",error=>console.error("IMO 3D worker could not start",error.message));child.unref();closeSync(log);
}
