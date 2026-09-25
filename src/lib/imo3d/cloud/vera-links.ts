import {z} from "zod";
import {cloudDevelopers} from "./management";
import {listProjects,listTourSummaries} from "./repository";
import {fail,json,readJSON} from "./http";
import {projectShowcase} from "../tour-lead";
import {developerProbeRef,VeraUnavailable,veraCatalogue,veraConfig,veraContext,veraDeleteLink,veraLinkIds,veraPutLink,type VeraLinkKind} from "../vera-integration";

/**
 * The studio's link selects (ProjectManagementDialog, DeveloperDirectory): which Developer OS
 * developer or project a tour project or tour developer sends its requests to. The registry is
 * VERA's; the studio reads VERA's catalogue and writes a link through the signed channel, and
 * the tour stores nothing about it. Session administrators only (checked by the caller).
 *
 *   GET    vera/catalogue[?developer=<id>]       VERA's developers, or one developer's projects
 *   GET    vera/link/<project|developer>/<id>    where this reference's requests go today
 *   PUT    vera/link/<project|developer>/<id>    {developerId, projectId?}
 *   DELETE vera/link/<project|developer>/<id>
 */
const OFF="التكامل مع VERA غير مفعّل على هذا الخادم.",DOWN="تعذّر الوصول إلى VERA. حاول مجددًا.",BAD_TARGET="المشروع لا يتبع هذا المطوّر في Developer OS، أو أن أحدهما غير موجود.";
const id=z.string().regex(/^[\w-]{1,80}$/,"المعرّف غير صالح.");
const linkBody=z.object({developerId:id,projectId:id.nullable().default(null)}).strict();

/** Where this reference's requests go today, with the linked ids when they can be named (to preselect the picker). */
async function linkState(kind:VeraLinkKind,ref:string,developer:string|null){
 const context=await veraContext(kind==="project"?{project:ref,developer}:{project:developerProbeRef(ref),developer:ref},{fresh:true});
 if(!context)throw new VeraUnavailable("CONTEXT");
 const linked=context.routed===kind,ids=linked?await veraLinkIds(context):null;
 return{configured:true,routed:context.routed,linked,developer:context.developer?{id:ids?.developerId??null,name:context.developer.name}:null,project:context.project?{id:ids?.projectId??null,name:context.project.name}:null};
}

export async function cloudVeraStudio(request:Request,segments:string[]):Promise<Response>{
 const[,what,kind,ref]=segments,method=request.method;
 try{
  if(what==="catalogue"&&segments.length===2&&method==="GET"){
   if(!veraConfig())return fail(OFF,503);
   const developer=new URL(request.url).searchParams.get("developer");
   return json(await veraCatalogue(developer?id.parse(developer):undefined));
  }
  if(what!=="link"||segments.length!==4||(kind!=="project"&&kind!=="developer"))return fail("المسار غير موجود.",404);
  const project=kind==="project"?(await listProjects()).find(item=>item.id===ref):undefined,developer=kind==="developer"?(await cloudDevelopers()).find(item=>item.id===ref):undefined;
  if(!project&&!developer)return fail(kind==="project"?"المشروع غير موجود.":"المطوّر غير موجود.",404);
  if(!veraConfig())return method==="GET"?json({configured:false,routed:null,linked:false,developer:null,project:null}):fail(OFF,503);
  if(method==="GET")return json(await linkState(kind,ref,project?.developerId??null));
  if(method==="DELETE"){await veraDeleteLink(kind,ref);return json(await linkState(kind,ref,project?.developerId??null));}
  if(method!=="PUT")return fail("العملية غير متاحة.",405);
  const input=linkBody.parse(await readJSON(request,2000));
  if(kind==="project"&&!input.projectId)return fail("اختر المشروع في Developer OS.");
  if(project){
   await veraPutLink({kind,ref,developerId:input.developerId,projectId:input.projectId,...projectShowcase(project.name,await listTourSummaries(project.id))});
  }else await veraPutLink({kind,ref,developerId:input.developerId,projectId:null,title:String(developer!.name),publicUrl:null,published:false,unitCode:null});
  return json(await linkState(kind,ref,project?.developerId??null));
 }catch(error){
  if(error instanceof VeraUnavailable)return error.code==="BAD_TARGET"?fail(BAD_TARGET,409):fail(DOWN,503);
  throw error;
 }
}
