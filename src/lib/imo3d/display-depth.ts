import type {DisplayDepth} from "./model";

/** The worker and renderer share the same usable-area gate for depth upgrades. */
export function supportedDisplayDepth(depth:DisplayDepth|undefined):DisplayDepth|undefined{
  if(!depth||!["monocular-multiview-floor-aligned","da3-base-pose-conditioned-multiview"].includes(depth.source)||depth.units!=="camera_height"||depth.purpose!=="display_only"||
    !Number.isFinite(depth.confidence)||depth.confidence<.45||depth.confidence>1||!Number.isFinite(depth.coverage)||depth.coverage<.75||depth.coverage>1||
    !Number.isInteger(depth.width)||!Number.isInteger(depth.height)||depth.width<8||depth.width>256||depth.height<4||depth.height>128||depth.width!==depth.height*2||!Array.isArray(depth.values)||depth.values.length!==depth.width*depth.height)return;
  let supported=0,nonzero=0;for(const value of depth.values){if(!Number.isFinite(value)||value<0||value>20)return;if(value>0)nonzero++;if(value>=.2)supported++;}
  return supported/depth.values.length>=.75&&Math.abs(nonzero/depth.values.length-depth.coverage)<1/depth.values.length?depth:undefined;
}
