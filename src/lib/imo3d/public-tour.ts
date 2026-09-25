import type {DisplayDepth,Scene,Tour} from "./model";
import {presentationScene} from "./photo-edits";
import {supportedDisplayDepth} from "./display-depth";

/**
 * What a buyer's browser receives when it opens a published tour.
 *
 * Display depth is ~90% of a tour's bytes (1.89 MB of 2.1 MB on Al Hamra) and only matters for the
 * scene being walked from or to. The arrival payload therefore names the scenes that have it
 * (`deferredDepth`) and the viewer asks for each one with the panorama it belongs to
 * (`GET tours/<id>/depth/<sceneId>`). Administrators keep the whole tour: the studio edits it.
 */
export type PublicTour=Omit<Tour,"photoEdits">&{deferredDepth?:string[]};
export function publicTourPayload(tour:Tour,{presentation,deferDepth}:{presentation:boolean;deferDepth:boolean}):PublicTour{
 const {photoEdits,...rest}=tour;void photoEdits;
 const shownScenes=presentation?tour.scenes.map(presentationScene):tour.scenes;
 if(!deferDepth)return {...rest,scenes:shownScenes};
 const deferred:string[]=[];
 const scenes=shownScenes.map(scene=>{
  const {displayDepth,...shown}=scene;
  if(supportedDisplayDepth(displayDepth))deferred.push(scene.id);
  return shown as Scene;
 });
 return {...rest,scenes,...(deferred.length?{deferredDepth:deferred}:{})};
}

/** Four decimals of a camera-height ratio; a non-zero value never rounds to zero (coverage is a count of them). */
const compact=(value:number)=>value===0?0:Math.max(1e-4,Math.round(value*1e4)/1e4);
/** One scene's display depth for the viewer, or null when the scene has none it may use. */
export function sceneDisplayDepth(tour:Tour,sceneId:string):DisplayDepth|null{
 const scene=tour.scenes.find(item=>item.id===sceneId);
 const depth=scene&&supportedDisplayDepth(scene.displayDepth);
 return depth?{...depth,values:depth.values.map(compact)}:null;
}
