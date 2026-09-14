import {spawn} from "node:child_process";
import {dataDirectory,db} from "./store";
const path:typeof import("node:path")=process.getBuiltinModule("node:path");
export function launchAIPlan(id:string){
 const child=spawn(process.execPath,[path.join(process.cwd(),"scripts/imo3d-ai-plan-worker.mjs"),id],{cwd:process.cwd(),env:{...process.env,IMO3D_DATA_DIR:dataDirectory()},detached:true,windowsHide:true,stdio:"ignore"});
 child.on("error",()=>{db().prepare("UPDATE ai_plan_jobs SET status='failed',error='تعذر تشغيل عامل تحليل الصور.' WHERE id=? AND status='queued'").run(id);});child.unref();
}
