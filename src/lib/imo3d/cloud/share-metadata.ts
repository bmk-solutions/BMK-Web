import type {Metadata} from "next";
import {shareCard} from "../share-card";
import {suiteOrigin} from "../suite";
import {cloudEnabled,cloudQuery} from "./client";
import {getBranding,getTour} from "./repository";

/** Server-side card for a shared buyer link; any doubt (not published, not found, an outage) is the neutral card. */
export async function tourShareMetadata(id:string):Promise<Metadata>{
 const origin=suiteOrigin(),neutral=()=>shareCard(null,{origin,id});
 if(!cloudEnabled()||!/^[\w-]{1,80}$/.test(id))return neutral();
 try{
  const tour=await getTour(id);if(!tour?.published)return neutral();
  const [branding,projects]=await Promise.all([getBranding(tour.projectId),cloudQuery<{name:string;location:string}[]>("projects",`id=eq.${encodeURIComponent(tour.projectId)}&select=name,location&limit=1`)]);
  return shareCard({tour,brandName:branding.name,brandLogo:"logo" in branding?branding.logo:undefined,projectName:projects[0]?.name,location:projects[0]?.location},{origin,id});
 }catch{return neutral();}
}
