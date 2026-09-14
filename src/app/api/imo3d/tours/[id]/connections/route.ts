import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { z } from "zod";
import { isAdmin, sameOrigin } from "@/lib/imo3d/auth";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import { brandingForProject } from "@/lib/imo3d/branding";
import { db, getTour } from "@/lib/imo3d/store";
import { ConnectionError, type ConnectionEdit } from "@/lib/imo3d/connection-editing";
import { saveConnectionEdit } from "@/lib/imo3d/connection-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
const pairSchema = z.object({ revision: z.number().int().nonnegative(), fromId: z.string().regex(/^[\w-]{1,80}$/), toId: z.string().regex(/^[\w-]{1,80}$/) });
const connectSchema = pairSchema.extend({ fromYaw: z.number().finite(), toYaw: z.number().finite() }).strict();
async function input(request: Request) {
  if (Number(request.headers.get("content-length")) > 2000) throw new ConnectionError("البيانات المرسلة أكبر من الحد المسموح.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new ConnectionError("أرسل بيانات الربط بصيغة JSON.", 400);
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length;
    if (total > 2000) { await reader.cancel(); throw new ConnectionError("البيانات المرسلة أكبر من الحد المسموح.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ConnectionError("بيانات الربط غير صالحة.", 400); }
}
async function handle(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  const hasAuthorization = request.headers.has("authorization"), integration = integrationForRequest(request);
  if (hasAuthorization && !integration) return json({ error: "مفتاح API غير صالح أو ملغى." }, 401);
  const admin = !hasAuthorization && isAdmin(request);
  if (!admin && !integration) return json({ error: "تسجيل دخول الإدارة مطلوب." }, 401);
  if (!integration && !sameOrigin(request)) return json({ error: "المصدر غير مسموح." }, 403);
  const { id } = await context.params, tour = getTour(id);
  if (!tour) return json({ error: "الجولة غير موجودة." }, 404);
  if (integration && (integration.projectId !== tour.projectId || !integration.scopes.includes("write"))) return json({ error: "الجولة أو الربط خارج صلاحية مفتاح API." }, 403);
  const body = await input(request);
  let edit: ConnectionEdit, revision: number;
  if (request.method === "POST") {
    const value = connectSchema.parse(body); revision = value.revision;
    edit = { action: "connect", fromId: value.fromId, toId: value.toId, fromYaw: value.fromYaw, toYaw: value.toYaw };
  } else {
    const value = pairSchema.strict().parse(body); revision = value.revision;
    edit = { action: "disconnect", fromId: value.fromId, toId: value.toId };
  }
  const updated = saveConnectionEdit(db(), id, revision, edit);
  return json({ ...updated, branding: brandingForProject(updated.projectId) });
}
async function safe(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  try { return await handle(request, context); }
  catch (error) {
    if (error instanceof ConnectionError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "أرسل رقم الإصدار ولقطتين صالحَتين، واتجاه كل لقطة عند إنشاء الربط." }, 400);
    return json({ error: "تعذر تأكيد تعديل الربط. حدّث الجولة للتحقق من النتيجة قبل إعادة المحاولة." }, 500);
  }
}
export { safe as POST, safe as DELETE };
