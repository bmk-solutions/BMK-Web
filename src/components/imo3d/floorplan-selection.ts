type Point = { x: number; z: number };
export type PlanSelectionCapture = { id: string; point: Point | null; roomId?: string };
export type PlanSelectionRoom = { id: string; outline: readonly Point[] };
type SelectionHint = { roomId?: string; hitCaptureId?: string };
const finite = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.z);

/** Include the wall itself so clicks at shared boundaries can use an explicit hit. */
export function roomContainsPlanPoint(point: Point, outline: readonly Point[]): boolean {
  if (!finite(point) || outline.length < 3) return false;
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j], b = outline[i];
    if (!finite(a) || !finite(b)) return false;
    const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (squared || 1)));
    if (Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz) <= 1e-7) return true;
    if ((a.z > point.z) !== (b.z > point.z) && point.x < dx * (point.z - a.z) / dz + a.x) inside = !inside;
  }
  return inside;
}

/** Coordinates share one map frame. Room identity wins over a nearer neighboring camera. */
export function selectFloorPlanCapture(captures: readonly PlanSelectionCapture[], rooms: readonly PlanSelectionRoom[], point: Point, hint: SelectionHint = {}): string | null {
  if (!finite(point)) return null;
  const nearest = (choices: readonly PlanSelectionCapture[]) => {
    let best: string | null = null, distance = Infinity;
    for (const capture of choices) {
      if (!capture.point || !finite(capture.point)) continue;
      const next = Math.hypot(capture.point.x - point.x, capture.point.z - point.z);
      if (next < distance) { best = capture.id; distance = next; }
    }
    return best;
  };
  const explicit = rooms.find(room => room.id === hint.roomId);
  const containing = explicit ? [explicit] : rooms.filter(room => roomContainsPlanPoint(point, room.outline));
  const members = containing.flatMap(room => {
    const identified = captures.filter(capture => capture.roomId === room.id);
    // User-drawn boundaries can precede semantic grouping. Their actual inside
    // captures remain selectable without assigning them to another identity.
    return identified.length ? identified : captures.filter(capture => capture.point && roomContainsPlanPoint(capture.point, room.outline));
  });
  if (members.length) {
    if (hint.hitCaptureId && members.some(capture => capture.id === hint.hitCaptureId)) return hint.hitCaptureId;
    return nearest(members) ?? members[0].id; // A named room can have unplaced photographs.
  }
  if (hint.hitCaptureId && captures.some(capture => capture.id === hint.hitCaptureId)) return hint.hitCaptureId;
  return nearest(captures);
}
