import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { z } from "zod";
import { isAdmin, sameOrigin } from "@/lib/imo3d/auth";
import { createIntegrationKey, integrationForRequest, integrationKeysForProject, integrationProjectExists, revokeIntegrationKey } from "@/lib/imo3d/integrations";
import {servePayloadPaths} from "@/lib/imo3d/base-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const json = (value: unknown, status = 200) => Response.json(servePayloadPaths(value), { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
const createSchema = z.object({ name: z.string().trim().min(1, "أدخل اسمًا للمفتاح.").max(80, "اسم المفتاح لا يزيد على 80 حرفًا."), scopes: z.array(z.enum(["read", "write", "leads"])).min(1, "اختر صلاحية واحدة على الأقل.").max(3) });

async function input(request: Request) {
  if (Number(request.headers.get("content-length")) > 4000) throw new Error("TOO_LARGE");
  const reader = request.body?.getReader(); if (!reader) throw new Error("INVALID_INPUT");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length; if (total > 4000) { await reader.cancel(); throw new Error("TOO_LARGE"); } chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("INVALID_INPUT"); }
}
async function handle(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  // Sending a key never falls back to the administrator's cookie or localhost bypass.
  if (request.headers.has("authorization")) return json({ error: "إدارة مفاتيح التكامل تتطلب جلسة الاستوديو، ولا تتاح بمفتاح API." }, integrationForRequest(request) ? 403 : 401);
  if (!await isAdmin(request)) return json({ error: "تسجيل دخول الإدارة مطلوب." }, 401);
  if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "المصدر غير مسموح." }, 403);
  const { id } = await context.params;
  if (!integrationProjectExists(id)) return json({ error: "المشروع غير موجود." }, 404);
  if (request.method === "GET") return json(integrationKeysForProject(id));
  const body = await input(request);
  if (request.method === "POST") {
    const value = createSchema.parse(body);
    return json(createIntegrationKey(id, value.name, value.scopes), 201);
  }
  const value = z.object({ id: z.string().uuid() }).parse(body);
  return revokeIntegrationKey(id, value.id) ? json({ ok: true }) : json({ error: "المفتاح غير موجود في هذا المشروع." }, 404);
}
async function safe(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  try { return await handle(request, context); }
  catch (error) {
    if (error instanceof z.ZodError) return json({ error: error.issues[0]?.message ?? "بيانات المفتاح غير صالحة." }, 400);
    if (error instanceof Error && error.message === "TOO_LARGE") return json({ error: "البيانات أكبر من الحد المسموح." }, 413);
    if (error instanceof Error && error.message === "INVALID_INPUT") return json({ error: "بيانات المفتاح غير صالحة." }, 400);
    return json({ error: "تعذر تنفيذ عملية مفتاح التكامل. حاول مجددًا." }, 500);
  }
}
export { safe as GET, safe as POST, safe as DELETE };
