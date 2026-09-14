import type { Point } from "./model";

/** Engine/world yaw and pitch in radians; positive pitch looks above the horizon. */
export type PanoramaMeasurementRay = { yaw: number; pitch: number };
export type PanoramaFloorCalibration = {
  sceneId: string;
  heightMeters: number;
  source: "camera_height" | "floor_reference";
  referenceMeters?: number;
};
type PanoramaWallPlane = {
  sceneId: string;
  heightMeters: number;
  wall: { normal: { x: number; z: number }; distance: number };
};
export type PanoramaWallCalibration = PanoramaWallPlane & (
  { source: "wall_reference"; referenceMeters: number } |
  { source: "wall_height" }
);
export type PanoramaCeilingCalibration = {
  sceneId: string;
  heightMeters: number;
  source: "ceiling_height";
  /** Metres above the lens, established at the selected wall/ceiling junction. */
  ceilingOffsetMeters: number;
};
export type PanoramaMeasurementCalibration = PanoramaFloorCalibration | PanoramaWallCalibration | PanoramaCeilingCalibration;

const minimumDownwardPitch = 5 * Math.PI / 180;
const validHeight = (height: number) => Number.isFinite(height) && height >= .15 && height <= 10;
const validScene = (sceneId: string) => typeof sceneId === "string" && sceneId.trim().length > 0;

/**
 * A user-selected point on a level floor, relative to the panorama lens.
 * This plane is a measurement assumption, never depth or saved scene geometry.
 * Near-horizon rays are rejected because tiny pointing errors amplify distance.
 */
export function projectPanoramaFloor(ray: PanoramaMeasurementRay, heightMeters = 1): Point | null {
  if (!validHeight(heightMeters) || !Number.isFinite(ray.yaw) || !Number.isFinite(ray.pitch)
    || ray.pitch > -minimumDownwardPitch || ray.pitch < -Math.PI / 2) return null;
  const radius = heightMeters * Math.cos(ray.pitch) / -Math.sin(ray.pitch);
  const point = { x: Math.sin(ray.yaw) * radius, y: -heightMeters, z: -Math.cos(ray.yaw) * radius };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

export function calibratePanoramaHeight(sceneId: string, heightMeters: number): PanoramaFloorCalibration | null {
  return validScene(sceneId) && validHeight(heightMeters) ? { sceneId, heightMeters, source: "camera_height" } : null;
}

/** A known separation on the same floor fixes the ray-plane scale. */
export function calibratePanoramaReference(sceneId: string, first: PanoramaMeasurementRay, second: PanoramaMeasurementRay, referenceMeters: number): PanoramaFloorCalibration | null {
  if (!validScene(sceneId) || !Number.isFinite(referenceMeters) || referenceMeters < .05 || referenceMeters > 100) return null;
  const a = projectPanoramaFloor(first), b = projectPanoramaFloor(second);
  if (!a || !b) return null;
  const length = Math.hypot(a.x - b.x, a.z - b.z);
  // Close picks or a very short reference make the scale unstable at normal
  // screen resolution; ask for a longer, clearly visible floor reference.
  const dot = Math.sin(first.pitch) * Math.sin(second.pitch)
    + Math.cos(first.pitch) * Math.cos(second.pitch) * Math.cos(first.yaw - second.yaw);
  if (length < .03 || Math.acos(Math.max(-1, Math.min(1, dot))) < Math.PI / 180) return null;
  const heightMeters = referenceMeters / length;
  return validHeight(heightMeters) ? { sceneId, heightMeters, source: "floor_reference", referenceMeters } : null;
}

/** Calibration never transfers silently to a different camera or apartment. */
export function measurePanoramaFloor(sceneId: string, first: PanoramaMeasurementRay, second: PanoramaMeasurementRay, calibration: PanoramaFloorCalibration): number | null {
  if (!validScene(sceneId) || calibration.sceneId !== sceneId || !validHeight(calibration.heightMeters)) return null;
  const a = projectPanoramaFloor(first, calibration.heightMeters), b = projectPanoramaFloor(second, calibration.heightMeters);
  return a && b ? Math.hypot(a.x - b.x, a.z - b.z) : null;
}

/** Two floor/wall corners with known separation establish one vertical plane. */
export function calibratePanoramaWall(sceneId: string, first: PanoramaMeasurementRay, second: PanoramaMeasurementRay, referenceMeters: number): PanoramaWallCalibration | null {
  const floor = calibratePanoramaReference(sceneId, first, second, referenceMeters);
  if (!floor) return null;
  const calibrated = calibratePanoramaWallHeight(sceneId, first, second, floor.heightMeters);
  return calibrated ? { ...calibrated, source: "wall_reference", referenceMeters } : null;
}

/** User-provided lens height plus two points on one wall/floor junction fixes that wall plane. */
export function calibratePanoramaWallHeight(sceneId: string, first: PanoramaMeasurementRay, second: PanoramaMeasurementRay, heightMeters: number): PanoramaWallCalibration | null {
  if (!validScene(sceneId) || !validHeight(heightMeters)) return null;
  const a = projectPanoramaFloor(first, heightMeters), b = projectPanoramaFloor(second, heightMeters);
  if (!a || !b) return null;
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  const dot = Math.sin(first.pitch) * Math.sin(second.pitch)
    + Math.cos(first.pitch) * Math.cos(second.pitch) * Math.cos(first.yaw - second.yaw);
  if (length < .03 || Math.acos(Math.max(-1, Math.min(1, dot))) < Math.PI / 180) return null;
  let normal = { x: dz / length, z: -dx / length };
  let distance = normal.x * a.x + normal.z * a.z;
  if (distance < 0) { normal = { x: -normal.x, z: -normal.z }; distance = -distance; }
  // A line passing through/very close to the lens cannot establish a stable wall.
  if (!Number.isFinite(distance) || distance < .1) return null;
  return { sceneId, heightMeters, source: "wall_height", wall: { normal, distance } };
}

/** Horizontal ceiling intersections use the calibrated positive lens-to-ceiling offset. */
export function projectPanoramaCeiling(ray: PanoramaMeasurementRay, ceilingOffsetMeters: number): Point | null {
  if (!Number.isFinite(ceilingOffsetMeters) || ceilingOffsetMeters <= 0 || ceilingOffsetMeters > 100
    || !Number.isFinite(ray.yaw) || !Number.isFinite(ray.pitch)
    || ray.pitch < minimumDownwardPitch || ray.pitch > Math.PI / 2) return null;
  const travel = ceilingOffsetMeters / Math.sin(ray.pitch);
  if (!Number.isFinite(travel) || travel > 100) return null;
  const radius = travel * Math.cos(ray.pitch);
  return { x: Math.sin(ray.yaw) * radius, y: ceilingOffsetMeters, z: -Math.cos(ray.yaw) * radius };
}

/** A junction on the already calibrated wall establishes the ceiling's horizontal plane. */
export function calibratePanoramaCeiling(sceneId: string, junction: PanoramaMeasurementRay, calibration: PanoramaWallCalibration): PanoramaCeilingCalibration | null {
  if (!validScene(sceneId) || calibration.sceneId !== sceneId
    || !["wall_height", "wall_reference"].includes(calibration.source)
    || !Number.isFinite(junction.pitch) || junction.pitch < minimumDownwardPitch) return null;
  const point = projectPanoramaMeasurement(junction, calibration);
  if (!point || !projectPanoramaCeiling(junction, point.y)) return null;
  return { sceneId, heightMeters: calibration.heightMeters, source: "ceiling_height", ceilingOffsetMeters: point.y };
}

/** Intersections apply only to the explicitly calibrated floor or wall plane. */
export function projectPanoramaMeasurement(ray: PanoramaMeasurementRay, calibration: PanoramaMeasurementCalibration): Point | null {
  if (!validHeight(calibration.heightMeters)) return null;
  if (calibration.source === "ceiling_height") return projectPanoramaCeiling(ray, calibration.ceilingOffsetMeters);
  if (calibration.source !== "wall_reference" && calibration.source !== "wall_height") return projectPanoramaFloor(ray, calibration.heightMeters);
  if (!Number.isFinite(ray.yaw) || !Number.isFinite(ray.pitch) || Math.abs(ray.pitch) > Math.PI / 2) return null;
  const { normal, distance } = calibration.wall;
  if (![normal.x, normal.z, distance].every(Number.isFinite) || Math.abs(Math.hypot(normal.x, normal.z) - 1) > 1e-6 || distance < .1) return null;
  const direction = { x: Math.sin(ray.yaw) * Math.cos(ray.pitch), y: Math.sin(ray.pitch), z: -Math.cos(ray.yaw) * Math.cos(ray.pitch) };
  const incidence = normal.x * direction.x + normal.z * direction.z;
  if (incidence < .05) return null; // Behind the lens or nearly parallel.
  const travel = distance / incidence;
  if (!Number.isFinite(travel) || travel > 100) return null;
  return { x: direction.x * travel, y: direction.y * travel, z: direction.z * travel };
}

export function measurePanoramaPlane(sceneId: string, first: PanoramaMeasurementRay, second: PanoramaMeasurementRay, calibration: PanoramaMeasurementCalibration): number | null {
  if (!validScene(sceneId) || calibration.sceneId !== sceneId) return null;
  const a = projectPanoramaMeasurement(first, calibration), b = projectPanoramaMeasurement(second, calibration);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null;
}

export function parseMeasurementMeters(value: string): number {
  const normalized = value.trim().replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 1776 : 1632))).replace(/[٫,]/g, ".");
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : NaN;
}
