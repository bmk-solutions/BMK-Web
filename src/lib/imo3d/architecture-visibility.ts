import type {Plan} from "./model";
/** Review is performed at save time, never again in the panorama render loop. */
export function hasReviewedArchitecture(plan?:Plan):boolean{
  return !!plan?.architecture&&plan.architectureReview==="reviewed"&&!!plan.architecture.rooms.length&&!!plan.architecture.walls.length;
}
/** Layers of the architectural drawing. */
export type ArchitectureLayers={walls:boolean;doors:boolean;windows:boolean;columns:boolean;rooms:boolean;names:boolean;areas:boolean;dimensions:boolean;cameras:boolean;direction:boolean;confidence:boolean};
/** «مخطط نظيف» is the drawing alone; «مخطط الجولة» adds the 360 positions and the view direction. */
export type ArchitecturePresentation="clean"|"tour";
export function architectureLayers(presentation:ArchitecturePresentation):ArchitectureLayers{
  const tour=presentation==="tour";
  return {walls:true,doors:true,windows:true,columns:true,rooms:true,names:true,areas:true,dimensions:false,cameras:tour,direction:tour,confidence:false};
}
/** The buyer's plan opens on the reviewed architectural drawing (the clean plan); a furnished picture is the alternative. */
export function defaultPlanView(plan?:Plan):"architecture"|"furnished"{
  return hasReviewedArchitecture(plan)?"architecture":"furnished";
}
