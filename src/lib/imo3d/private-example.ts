import {sceneSchema,unitSchema,type Tour} from "./model";

// Resolve optional private fixtures at request time. Do not let the build tracer
// treat the real apartment dataset as a required production asset.
const runtimeFs:typeof import("node:fs")=process.getBuiltinModule("node:fs");
const runtimePath:typeof import("node:path")=process.getBuiltinModule("node:path");
export type PrivateExamplePreview={id:string;title:string;thumbnail:string};
export class PrivateExampleUnavailableError extends Error {
  constructor(){super("العينة الخاصة متاحة محليًا فقط عند وجود ملفاتها. يمكنك إنشاء مشروع جديد ورفع صورك.");}
}
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function validExample(value:unknown):value is Tour {
  if(!isRecord(value)||typeof value.id!=="string"||typeof value.projectId!=="string"||typeof value.title!=="string"||!value.title.trim())return false;
  if(!/^[\w-]{1,80}$/.test(value.id)||!/^[\w-]{1,80}$/.test(value.projectId)||!Number.isInteger(value.revision)||typeof value.published!=="boolean")return false;
  if(typeof value.createdAt!=="string"||!Number.isFinite(Date.parse(value.createdAt))||typeof value.updatedAt!=="string"||!Number.isFinite(Date.parse(value.updatedAt)))return false;
  if(!Array.isArray(value.scenes)||!value.scenes.length||value.scenes.length>500||value.scenes.some(scene=>!sceneSchema.safeParse(scene).success))return false;
  if(!Array.isArray(value.plans)||!unitSchema.safeParse(value.unit).success||!isRecord(value.quality))return false;
  return value.plans.every(plan=>isRecord(plan)&&Number.isInteger(plan.floor)&&typeof plan.label==="string"&&Array.isArray(plan.walls)&&isRecord(plan.bounds));
}
/** Optional local reference; never read fixture files during production builds. */
export function readPrivateExample():Tour|null {
  if(process.env.NODE_ENV!=="development"||process.env.VERCEL)return null;
  const configured=process.env.IMO3D_EXAMPLE_FILE?.trim();
  const candidates=configured?[runtimePath.resolve(configured)]:[
    runtimePath.join(process.env.IMO3D_DATA_DIR??runtimePath.join(process.cwd(),".imo3d-data"),"private-example.json"),
    runtimePath.join(process.cwd(),"src","lib","imo3d","example.json"),
  ];
  for(const file of candidates){
    try{
      const info=runtimeFs.statSync(file);if(!info.isFile()||info.size>16*1024*1024)continue;
      const value:unknown=JSON.parse(runtimeFs.readFileSync(file,"utf8"));
      if(validExample(value))return value;
    }catch{/* Missing or invalid optional fixtures do not block the application. */}
  }
  return null;
}
export function privateExamplePreview():PrivateExamplePreview|null {
  const example=readPrivateExample();
  return example?{id:example.id,title:example.title,thumbnail:example.scenes[0].preview}:null;
}
