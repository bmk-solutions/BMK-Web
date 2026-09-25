import type {Tour} from "../model";
import {presentationScene} from "../photo-edits";
import {shareImageFromPanorama} from "../image-variants";
import {cloudDownloadObject} from "./client";
import {getAsset} from "./repository";
import {fail} from "./http";

const assetId=(url:string|undefined)=>/^\/api\/imo3d\/assets\/([\w-]{1,80})$/.exec(url??"")?.[1];
/**
 * The picture a shared tour link shows: the first scene as the buyer meets it (an approved retouch
 * replaces the original). Caller has authorized the tour; only a published tour is cached publicly.
 */
export async function tourShareImage(tour:Tour){
 const scene=tour.scenes[0]&&presentationScene(tour.scenes[0]);
 const id=assetId(scene?.preview)??assetId(scene?.thumbnail);
 const asset=id?await getAsset(id):null;
 if(!asset||asset.tour_id!==tour.id||!asset.mime.startsWith("image/"))return fail("لا توجد صورة لمعاينة هذه الجولة.",404);
 const bytes=await shareImageFromPanorama(await cloudDownloadObject(asset.storage_key));
 return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"image/jpeg","Content-Length":String(bytes.byteLength),"Cache-Control":tour.published?"public, max-age=3600, s-maxage=86400":"private, no-store","X-Content-Type-Options":"nosniff"}});
}
