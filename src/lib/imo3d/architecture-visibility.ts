import type {Plan} from "./model";
/** Review is performed at save time, never again in the panorama render loop. */
export function hasReviewedArchitecture(plan?:Plan):boolean{
  return !!plan?.architecture&&plan.architectureReview==="reviewed"&&!!plan.architecture.rooms.length&&!!plan.architecture.walls.length;
}
