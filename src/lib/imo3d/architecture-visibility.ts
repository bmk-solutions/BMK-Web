import type {Plan} from "./model";
/** Review is performed at save time, never again in the panorama render loop. */
export function hasReviewedArchitecture(plan?:Plan):boolean{
  return !!plan?.architecture&&plan.architectureReview==="reviewed"&&!!plan.architecture.rooms.length&&!!plan.architecture.walls.length;
}
/** The buyer's plan opens on the reviewed architectural drawing (the clean plan); a furnished picture is the alternative. */
export function defaultPlanView(plan?:Plan):"architecture"|"furnished"{
  return hasReviewedArchitecture(plan)?"architecture":"furnished";
}
