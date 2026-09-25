import type {Metadata} from "next";
import type {Tour} from "./model";
import {IMO3D_BASE_PATH} from "./base-path.ts";

/**
 * What WhatsApp and social apps show for a shared buyer link. Crawlers never run the viewer, so the
 * card is written on the server: the project's tour under the developer's own name (white label),
 * never the BMK marketing site. An unknown or unpublished tour gets a neutral card that names nothing.
 */
export type ShareCardInput={tour:Pick<Tour,"id"|"title"|"revision"|"unit"|"scenes">;brandName?:string;brandLogo?:string;projectName?:string;location?:string};
const DEFAULT_BRAND="IMO 3D";
/** A neutral 360° glyph (public/assets/imo3d-tour-icon.svg): a tour without a developer logo shows no one's mark. */
export const NEUTRAL_TOUR_ICON="/assets/imo3d-tour-icon.svg";
const clean=(value:string|undefined)=>value?.replace(/\s+/g," ").trim()||"";
/** The name a buyer sees: the developer's brand, or the project's own name while the brand is the platform default. */
export function tourBrand({title,brandName,projectName}:{title:string;brandName?:string;projectName?:string}){
 const brand=clean(brandName);
 return brand&&brand!==DEFAULT_BRAND?brand:clean(projectName)||clean(title);
}
/** One title for the shared card, the browser tab and the share sheet: never the platform's name. */
export function tourShareTitle(input:{title:string;brandName?:string;projectName?:string}){
 const tourTitle=clean(input.title),brand=tourBrand(input);
 return brand&&brand!==tourTitle?`${tourTitle} — ${brand}`:tourTitle;
}
const neutralIcons=(origin:string)=>({icon:`${origin}${IMO3D_BASE_PATH}${NEUTRAL_TOUR_ICON}`});
export function shareTourURL(origin:string,id:string){return `${origin}${IMO3D_BASE_PATH}/t/${encodeURIComponent(id)}`;}
export function shareCard(input:ShareCardInput|null,{origin,id}:{origin:string;id:string}):Metadata{
 const url=shareTourURL(origin,id),base={metadataBase:new URL(origin),alternates:{canonical:url}};
 if(!input){
  const title="جولة افتراضية 360°",description="جولة افتراضية تفاعلية داخل الوحدة.";
  return {...base,title:{absolute:title},description,openGraph:{type:"website",locale:"ar_SA",title,description,url},twitter:{card:"summary",title,description},icons:neutralIcons(origin)};
 }
 const {tour}=input,tourTitle=clean(tour.title),project=clean(input.projectName),location=clean(input.location);
 const naming={title:tour.title,brandName:input.brandName,projectName:input.projectName},brand=tourBrand(naming),title=tourShareTitle(naming);
 const facts=[tour.unit.area!==null?`المساحة ${Math.round(tour.unit.area)} م²`:"",tour.unit.bedrooms!==null?`${tour.unit.bedrooms} غرف نوم`:"",tour.unit.bathrooms!==null?`${tour.unit.bathrooms} دورات مياه`:""].filter(Boolean);
 const place=[project&&project!==tourTitle?project:"",location].filter(Boolean).join("، ");
 const description=`جولة افتراضية 360° داخل ${tourTitle}${place?` — ${place}`:""}.${facts.length?` ${facts.join(" · ")}.`:""}`;
 const image=tour.scenes.length?`${origin}${IMO3D_BASE_PATH}/api/imo3d/tours/${encodeURIComponent(tour.id)}/og-image?r=${tour.revision}`:null;
 const logo=input.brandLogo?.startsWith("/api/imo3d/branding-assets/")?`${origin}${IMO3D_BASE_PATH}${input.brandLogo}`:null;
 return {...base,title:{absolute:title},description,applicationName:brand,
  openGraph:{type:"website",locale:"ar_SA",siteName:brand,title,description,url,...(image?{images:[{url:image,width:1200,height:630,alt:tourTitle}]}:{})},
  twitter:{card:image?"summary_large_image":"summary",title,description,...(image?{images:[image]}:{})},
  icons:logo?{icon:logo,apple:logo}:neutralIcons(origin)};
}
