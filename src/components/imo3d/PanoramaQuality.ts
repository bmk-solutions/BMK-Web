import type { Scene } from "@/lib/imo3d/model";

export type PanoramaQuality = "preview" | "image" | "detail";
export type PanoramaDisplayPolicy = { memoryBudget: number; maxTextureSize: number; detailAllowed: boolean;arrivalMaxWidth?:number };
export function panoramaDisplayPolicy(coarse: boolean, maxTextureSize: number, deviceMemory?: number): PanoramaDisplayPolicy {
  const detailAllowed = !coarse && maxTextureSize >= 8192 && (deviceMemory === undefined || deviceMemory >= 4);
  return { memoryBudget: (coarse ? 48 : detailAllowed ? 192 : 96) * 1024 * 1024, maxTextureSize, detailAllowed,arrivalMaxWidth:coarse?3072:4096 };
}

/** Estimate required panorama pixels from the real render size and view angle. */
export function desiredPanoramaWidth(width: number, height: number, verticalFov: number, pixelRatio: number): number {
  if (width <= 0 || height <= 0) return 0;
  const vertical = Math.max(40, Math.min(95, verticalFov)) * Math.PI / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * width / height);
  return Math.max(width * Math.PI * 2 / horizontal, height * Math.PI * 2 / vertical) * pixelRatio;
}

/** Never request the private original or a texture the current device cannot hold. */
export function panoramaQualityCandidate(scene: Scene, quality: PanoramaQuality, failed: ReadonlySet<string>, policy: PanoramaDisplayPolicy, desiredWidth: number) {
  const detail = scene.detail;
  if (quality !== "detail" && detail && policy.detailAllowed && desiredWidth > 4096 * 1.1 && detail.width > 4096 &&
    detail.width <= policy.maxTextureSize && detail.height <= policy.maxTextureSize && !failed.has(detail.image)) {
    const bytes = detail.width * detail.height * 4;
    // Leave space for the existing 4K texture until replacement uploads, and
    // for previews during the next transition. Only one 8K texture can fit.
    if (bytes + 4096 * 2080 * 4 <= policy.memoryBudget) return { url: detail.image, quality: "detail" as const, bytes };
  }
  if (quality === "preview" && desiredWidth > 2048 * 1.1 && policy.maxTextureSize >= 4096 && scene.image !== scene.preview && !failed.has(scene.image)) {
    return { url: scene.image, quality: "image" as const, bytes: 4096 * 2080 * 4 };
  }
  return null;
}

/** Arrival quality must fit beside the still-visible source, not replace it early. */
export function panoramaArrivalCandidate(scene:Scene,policy:PanoramaDisplayPolicy,desiredWidth:number,availableBytes:number,canResize:boolean){
  const preview={url:scene.preview,quality:"preview" as const,width:2048,bytes:2048*1024*4};
  if(desiredWidth<=2048*1.1||scene.image===scene.preview)return preview;
  for(const width of [4096,3072]){
    if(width>policy.maxTextureSize||width>(policy.arrivalMaxWidth??4096)||width<4096&&!canResize)continue;
    const bytes=width*(width/2)*4;
    if(bytes+2*1024*1024<=availableBytes)return{url:scene.image,quality:"image" as const,width,bytes};
  }
  return preview;
}

