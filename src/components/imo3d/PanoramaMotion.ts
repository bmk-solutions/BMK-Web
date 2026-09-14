import type { Point, Scene, Wall } from "../../lib/imo3d/model";
import {supportedDisplayDepth} from "../../lib/imo3d/display-depth.ts";

/** Visual navigation modes are deliberately separate from survey/depth data. */
export type MotionMode = "depth" | "floor-proxy" | "plan-proxy" | "dissolve" | "aligned-dissolve" | "display-depth";

/** Estimated depth is a display capability only; this never supplies scene.depth. */
export function usableDisplayDepth(scene:Scene):Scene["displayDepth"]|undefined{
  return scene.depth?undefined:supportedDisplayDepth(scene.displayDepth);
}

export function displayDepthTriangle(a:number,b:number,c:number){
  const near=Math.min(a,b,c),far=Math.max(a,b,c);
  return near>=.2&&far<=20&&far-near<=Math.max(.12,near*.18);
}

/** Bounded optical approach in camera-height units, independent of diagram distance. */
export function displayViewPosition(origin:Point,bearing:number,progress:number):Point{
  const shift=.12*smoothstep(progress);
  return{x:origin.x+Math.sin(bearing)*shift,y:origin.y,z:origin.z-Math.cos(bearing)*shift};
}

export function motionMode(from: Scene, to: Scene): MotionMode {
  if (!from.position || !to.position || from.floor !== to.floor) return "dissolve";
  return from.depth && to.depth ? "depth" : "aligned-dissolve";
}

export const smoothstep = (t: number) => {
  const bounded = Math.max(0, Math.min(1, t));
  return bounded * bounded * (3 - 2 * bounded);
};

/** Zero velocity and acceleration at each end avoids a hard stop between steps. */
export function motionProgress(t: number) {
  const bounded = Math.max(0, Math.min(1, t));
  return bounded * bounded * bounded * (bounded * (bounded * 6 - 15) + 10);
}

export function motionDuration(from: Scene, to: Scene, mode?: MotionMode) {
  // Uncalibrated diagram distances must never determine the walking speed.
  // Keep photographic handovers long enough to read, without a loading pause.
  if (mode === "display-depth") return 1100;
  if (mode === "aligned-dissolve") return 1050;
  if (mode === "dissolve" || !from.position || !to.position || from.floor !== to.floor) return 950;
  const a = from.position, b = to.position;
  return Math.min(1150, Math.max(1000, 900 + Math.hypot(b.x-a.x, b.y-a.y, b.z-a.z)*60));
}

/**
 * A nominal floor 1.6 m below the capture point, capped by a distant shell.
 * This is a rendering proxy, NEVER a recovered room mesh or a measurement.
 * At the original capture pose its projection is exactly the input panorama.
 */
export function proxyRadius(pitch: number, wallDistance?: number | null) {
  const vertical=Math.sin(pitch);
  const floor=vertical < -0.0001 ? 1.6/-vertical : 12;
  // Only plan-supported rays use a wall extrusion. The 2.8 m total height is
  // nominal; the source plan specifies horizontal walls, not measured ceilings.
  if (wallDistance!=null && wallDistance>0) {
    const ceiling=vertical>0.0001 ? 1.2/vertical : 12;
    const wall=wallDistance/Math.max(0.000001,Math.cos(pitch));
    return Math.min(12,floor,ceiling,wall);
  }
  return Math.min(12,floor);
}

/** Nearest forward hit against existing world-coordinate plan segments. */
export function rayWallDistance(origin: Pick<Point,"x"|"z">, yaw: number, walls: readonly Wall[]): number | null {
  const dx=Math.sin(yaw), dz=-Math.cos(yaw);
  let nearest=Infinity;
  for (const wall of walls) {
    const ex=wall.b.x-wall.a.x, ez=wall.b.z-wall.a.z;
    const ax=wall.a.x-origin.x, az=wall.a.z-origin.z;
    const denominator=dx*ez-dz*ex;
    if (Math.abs(denominator)<1e-9) continue;
    const distance=(ax*ez-az*ex)/denominator;
    const fraction=(ax*dz-az*dx)/denominator;
    // Ignore coincident capture/line noise and intersections outside a segment.
    if (distance>0.08 && fraction>=-1e-8 && fraction<=1+1e-8) nearest=Math.min(nearest,distance);
  }
  return Number.isFinite(nearest) ? nearest : null;
}

/** One horizontal scan per panorama, reused for every latitude in its mesh. */
export function planWallDistances(scene: Scene, walls: readonly Wall[], columns=128): (number|null)[] {
  if (!scene.position || !walls.length) return [];
  const yaw=scene.yaw*Math.PI/180;
  const distances=Array.from({length:columns},(_,x)=>rayWallDistance(scene.position!, (x/columns-0.5)*2*Math.PI+yaw,walls));
  distances.push(distances[0]);
  return distances;
}

/**
 * Unknown walls/objects cannot be reprojected accurately. Smoothly bound their
 * apparent displacement, particularly on distant room selections, to avoid
 * folding a floor texture through the camera. Calibrated depth is not bounded.
 */
export function proxyViewPosition(origin: Point, camera: Point, hasPlanShell=false): Point {
  const dx=camera.x-origin.x, dz=camera.z-origin.z, length=Math.hypot(dx,dz);
  // Nearby views over shared plan geometry need the same camera position to
  // align wall features. Longer offsets still saturate before folding the proxy.
  const shift=hasPlanShell ? (length<=0.75 ? length : 0.75+0.5*Math.tanh((length-0.75)/0.5)) : 1.25*Math.tanh(length/1.25);
  const scale=length>0.00001 ? shift/length : 1;
  return { x:origin.x+dx*scale, y:origin.y+0.2*Math.tanh((camera.y-origin.y)/0.2), z:origin.z+dz*scale };
}
