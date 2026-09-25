import sharp from "sharp";

/**
 * Smaller copies of images that already exist, made when a browser asks and kept by shared caches.
 * Nothing is written back to storage: the stored original stays the only copy.
 */
export type PlanImageVariant="webp"|"mini";
export const PLAN_MINI_MAX=600;
export const planImageVariantOf=(value:string|null):PlanImageVariant|null=>value==="webp"||value==="mini"?value:null;

/** The published plan as WebP (quality 82) and a ≤600 px copy for the compact map. The PNG stays for «فتح بالحجم الكامل». */
export async function planImageVariant(png:Uint8Array,variant:PlanImageVariant){
 const image=sharp(png,{limitInputPixels:40_000_000}).rotate();
 const sized=variant==="mini"?image.resize({width:PLAN_MINI_MAX,height:PLAN_MINI_MAX,fit:"inside",withoutEnlargement:true}):image;
 return sized.webp({quality:82,alphaQuality:90,effort:4}).toBuffer();
}

/** A link preview (WhatsApp, social) of a 2:1 panorama: its centre, 1200×630 JPEG, well under WhatsApp's 300 KB. */
export const SHARE_IMAGE={width:1200,height:630};
export async function shareImageFromPanorama(panorama:Uint8Array){
 return sharp(panorama,{limitInputPixels:80_000_000}).rotate().resize({...SHARE_IMAGE,fit:"cover",position:"centre"}).jpeg({quality:78,mozjpeg:true}).toBuffer();
}
