import type {Tour} from '../model';
import {cloudQuery,cloudSignedDownloads} from './client';
import type {CloudAsset} from './types';

/** Caller must authorize the tour first. Never sign originals or stale/unrelated assets. */
export async function tourMedia(tour:Tour){
  const references=new Set(tour.scenes.flatMap(scene=>[scene.image,scene.preview,scene.thumbnail,scene.detail?.image]).filter(Boolean));
  const assets=await cloudQuery<Pick<CloudAsset,'id'|'storage_key'|'mime'>[]>('assets',`tour_id=eq.${encodeURIComponent(tour.id)}&select=id,storage_key,mime`);
  const selected=assets.filter(asset=>asset.mime.startsWith('image/')&&references.has(`/api/imo3d/assets/${asset.id}`));
  // Expire slightly before the storage token, including time spent signing it.
  const expiresAt=Date.now()+270_000;
  const signed=await cloudSignedDownloads(selected.map(asset=>asset.storage_key));
  return {expiresAt,urls:Object.fromEntries(selected.flatMap(asset=>{
    const url=signed.get(asset.storage_key);return url?[[`/api/imo3d/assets/${asset.id}`,url]]:[];
  }))};
}
