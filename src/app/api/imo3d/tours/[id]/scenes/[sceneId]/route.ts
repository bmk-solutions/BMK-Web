import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { z } from "zod";
import { isAdmin, sameOrigin } from "@/lib/imo3d/auth";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import { brandingForProject } from "@/lib/imo3d/branding";
import { dataDirectory, db, getTour } from "@/lib/imo3d/store";
import { deleteSceneRecord } from "@/lib/imo3d/scene-deletion";
import { cleanupPrivateAssetFiles } from "@/lib/imo3d/private-asset-cleanup";
import { cleanupProcessingArtifacts } from "@/lib/imo3d/processing-cleanup";
import {servePayloadPaths} from "@/lib/imo3d/base-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(servePayloadPaths(value), { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
type Context = { params: Promise<{ id: string; sceneId: string }> };
const bodySchema = z.object({ revision: z.number().int().nonnegative() });

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 2000) throw new Error("TOO_LARGE");
  const reader = request.body?.getReader(); if (!reader) throw new Error("INVALID_BODY");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.length;
    if (total > 2000) { await reader.cancel(); throw new Error("TOO_LARGE"); }
    chunks.push(value);
  }
  try { return bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Error("INVALID_BODY"); }
}

export async function DELETE(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  try {
    const hasAuthorization = request.headers.has("authorization"), integration = integrationForRequest(request);
    if (hasAuthorization && !integration) return json({ error: "مفتاح API غير صالح أو ملغى." }, 401);
    const admin = !hasAuthorization && await isAdmin(request);
    if (!admin && !integration) return json({ error: "تسجيل دخول الإدارة مطلوب." }, 401);
    if (!integration && !sameOrigin(request)) return json({ error: "المصدر غير مسموح." }, 403);
    const { id, sceneId } = await context.params;
    const tour = getTour(id);
    if (!tour) return json({ error: "الجولة غير موجودة." }, 404);
    if (integration && (integration.projectId !== tour.projectId || !integration.scopes.includes("write"))) return json({ error: "الجولة أو الحذف خارج صلاحية مفتاح API." }, 403);
    const { revision } = await readBody(request);
    const result = deleteSceneRecord(db(), id, sceneId, revision);
    const [cleanup, processing] = await Promise.all([
      cleanupPrivateAssetFiles(dataDirectory(), result.files),
      cleanupProcessingArtifacts(dataDirectory(), result.jobIds),
    ]);
    return json({ ...result.tour, branding: brandingForProject(result.tour.projectId), ...(cleanup.failed.length || processing.failed.length || processing.skipped.length ? { cleanupWarning: "حُذفت اللقطة من الجولة، لكن تعذر تنظيف بعض ملفاتها الخاصة من التخزين. تحتاج هذه الملفات إلى تنظيف لاحق." } : {}) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "CONFLICT") return json({ error: "تغيّرت الجولة. أعد تحميل أحدث نسخة قبل حذف اللقطة." }, 409);
    if (code === "TOUR_NOT_FOUND" || code === "SCENE_NOT_FOUND") return json({ error: "اللقطة أو الجولة غير موجودة." }, 404);
    if (code === "TOO_LARGE") return json({ error: "بيانات الطلب أكبر من الحد المسموح." }, 413);
    if (code === "INVALID_BODY") return json({ error: "أرسل رقم إصدار الجولة الصحيح مع طلب الحذف." }, 400);
    return json({ error: "تعذر تأكيد حذف اللقطة. حدّث الجولة للتحقق من حالتها قبل إعادة المحاولة." }, 500);
  }
}
