import type { DatabaseSync } from "node:sqlite";
import type { Lead } from "./model";

export type LeadPage = { leads: (Lead & { projectId: string; projectName: string; tourTitle: string })[]; total: number; nextCursor: string | null };
export class LeadQueryError extends Error { readonly status = 400; }
type Cursor = { createdAt: string; id: string; projectId: string | null };

export function getLeads(database: DatabaseSync, options: { projectId?: string; cursor?: string; limit?: number } = {}): LeadPage {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new LeadQueryError("حجم صفحة الطلبات يجب أن يكون بين 1 و1000.");
  if (options.projectId !== undefined && !/^[\w-]{1,80}$/.test(options.projectId)) throw new LeadQueryError("معرّف المشروع غير صالح.");
  let cursor: Cursor | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 1000 || !/^[a-zA-Z0-9_-]+$/.test(options.cursor)) throw Error();
      cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Cursor;
      if (!cursor || typeof cursor.createdAt !== "string" || cursor.createdAt.length > 80 || !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== "string" || !/^[\w-]{1,80}$/.test(cursor.id) || cursor.projectId !== (options.projectId ?? null)) throw Error();
    } catch { throw new LeadQueryError("مؤشر الصفحة غير صالح لهذا المشروع. أعد تحميل الطلبات."); }
  }
  const where: string[] = [], parameters: (string | number)[] = [];
  if (options.projectId) { where.push("tour.project_id=?"); parameters.push(options.projectId); }
  const scope = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(database.prepare(`SELECT count(*) AS count FROM leads lead JOIN tours tour ON tour.id=lead.tour_id ${scope}`).get(...parameters)?.count ?? 0);
  if (cursor) { where.push("(lead.created_at<? OR (lead.created_at=? AND lead.id<?))"); parameters.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = database.prepare(`SELECT lead.id,lead.tour_id AS tourId,lead.name,lead.phone,lead.note,lead.created_at AS createdAt,
    tour.project_id AS projectId,project.name AS projectName,json_extract(tour.payload,'$.title') AS tourTitle
    FROM leads lead JOIN tours tour ON tour.id=lead.tour_id JOIN projects project ON project.id=tour.project_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY lead.created_at DESC,lead.id DESC LIMIT ?`).all(...parameters, limit + 1);
  const hasMore = rows.length > limit, leads = rows.slice(0, limit).map(row => ({ id: String(row.id), tourId: String(row.tourId), name: String(row.name), phone: String(row.phone), note: String(row.note), createdAt: String(row.createdAt), projectId: String(row.projectId), projectName: String(row.projectName), tourTitle: String(row.tourTitle ?? "") }));
  const last = leads.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id, projectId: options.projectId ?? null } satisfies Cursor)).toString("base64url") : null;
  return { leads, total, nextCursor };
}
