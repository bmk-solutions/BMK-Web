import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./model";
import { ConnectionError, editTourConnection, type ConnectionEdit } from "./connection-editing";
import { cancelJob, ensureProcessingTables } from "./processing-jobs";

export function saveConnectionEdit(database: DatabaseSync, tourId: string, expectedRevision: number, edit: ConnectionEdit): Tour {
  ensureProcessingTables(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT payload FROM tours WHERE id=?").get(tourId);
    if (!row) throw new ConnectionError("الجولة غير موجودة.", 404);
    const tour = JSON.parse(String(row.payload)) as Tour;
    if (tour.revision !== expectedRevision) throw new ConnectionError("تغيّرت الجولة. حدّث اللقطات قبل تعديل الربط.", 409);
    const next = { ...editTourConnection(tour, edit), revision: tour.revision + 1, updatedAt: new Date().toISOString() };
    const updated = database.prepare("UPDATE tours SET payload=?,revision=? WHERE id=? AND revision=?").run(JSON.stringify(next), next.revision, tourId, expectedRevision);
    if (!updated.changes) throw new ConnectionError("تغيّرت الجولة. حدّث اللقطات قبل تعديل الربط.", 409);
    cancelJob(database, tourId);
    database.exec("COMMIT");
    return next;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
