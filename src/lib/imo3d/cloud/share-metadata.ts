import type {Metadata} from "next";
import {shareCard} from "../share-card";
import {suiteOrigin} from "../suite";
import {cloudEnabled} from "./client";
import {getBranding,getProjectCard,getTour} from "./repository";

/** Server-side card for a shared buyer link; any doubt (not published, not found, an outage) is the neutral card. */
export async function tourShareMetadata(id:string):Promise<Metadata>{
 const origin=suiteOrigin(),neutral=()=>shareCard(null,{origin,id});
 if(!cloudEnabled()||!/^[\w-]{1,80}$/.test(id))return neutral();
 try{
  const tour=await getTour(id);if(!tour?.published)return neutral();
  const [branding,project]=await Promise.all([getBranding(tour.projectId),getProjectCard(tour.projectId)]);
  return shareCard({tour,brandName:branding.name,brandLogo:"logo" in branding?branding.logo:undefined,projectName:project?.name,location:project?.location},{origin,id});
 }catch{return neutral();}
}
