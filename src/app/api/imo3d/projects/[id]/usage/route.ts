import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { isAdmin } from "@/lib/imo3d/auth";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import { dataDirectory, db } from "@/lib/imo3d/store";
import { projectUsage } from "@/lib/imo3d/project-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if(cloudEnabled())return cloudRoute(request);
  try {
    const integration = integrationForRequest(request), authorization = request.headers.has("authorization");
    if (authorization && !integration) return json({ error: "مفتاح API غير صالح أو أُلغي." }, 401);
    const admin = !authorization && isAdmin(request);
    if (!admin && !integration) return json({ error: "تسجيل دخول الإدارة مطلوب." }, 401);
    const { id } = await context.params;
    if (integration && (integration.projectId !== id || !integration.scopes.includes("read"))) return json({ error: "المشروع خارج صلاحية القراءة لمفتاح API." }, 403);
    const usage = await projectUsage(db(), dataDirectory(), id);
    return usage ? json(usage) : json({ error: "المشروع غير موجود." }, 404);
  } catch (error) {
    console.error("IMO 3D project usage failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "تعذر قراءة استخدام المشروع. أعد المحاولة." }, 500);
  }
}
