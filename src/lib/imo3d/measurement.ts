import type { Plan, Point, Tour } from "./model";

export type MeasurementPoint = { x: number; y: number };
export type PlanCalibration = { metersPerUnit: number; referenceMeters: number; referenceUnits: number };
const finitePoint = (point: MeasurementPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/** Invert a registered drawing, retaining its rotation, reflection and unequal axis scales. */
export function inversePlanProjection(project: (point: Point) => MeasurementPoint): ((point: MeasurementPoint) => MeasurementPoint) | null {
  const origin = project({ x: 0, y: 0, z: 0 }), x = project({ x: 1, y: 0, z: 0 }), z = project({ x: 0, y: 0, z: 1 });
  if (![origin, x, z].every(finitePoint)) return null;
  const a = x.x - origin.x, b = z.x - origin.x, c = x.y - origin.y, d = z.y - origin.y;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) <= Math.max(Math.abs(a * d), Math.abs(b * c), 1e-12) * 1e-10) return null;
  return point => ({ x: ((point.x - origin.x) * d - b * (point.y - origin.y)) / determinant,
    y: (a * (point.y - origin.y) - (point.x - origin.x) * c) / determinant });
}

/** Metric claims require actual registered geometry/depth, never a camera-height proxy. */
export function planHasMetricScale(plan: Plan, spatialScale: Tour["spatialScale"], hasProjection: boolean) {
  return spatialScale !== "relative" && plan.authoredScale!=="relative" && !plan.generatedFrom && !plan.generatedRooms?.length && hasProjection && (plan.kind === "geometry" || plan.kind === "depth");
}

export function horizontalPlanDistance(first: MeasurementPoint, second: MeasurementPoint, metersPerUnit = 1): number | null {
  if (!finitePoint(first) || !finitePoint(second) || !Number.isFinite(metersPerUnit) || metersPerUnit <= 0) return null;
  const value = Math.hypot(second.x - first.x, second.y - first.y) * metersPerUnit;
  return Number.isFinite(value) ? value : null;
}

export function calibratePlanReference(first: MeasurementPoint, second: MeasurementPoint, referenceMeters: number): PlanCalibration | null {
  const referenceUnits = horizontalPlanDistance(first, second);
  if (referenceUnits === null || referenceUnits < 1e-6 || !Number.isFinite(referenceMeters) || referenceMeters <= 0 || referenceMeters > 100000) return null;
  const metersPerUnit = referenceMeters / referenceUnits;
  return Number.isFinite(metersPerUnit) ? { metersPerUnit, referenceMeters, referenceUnits } : null;
}
