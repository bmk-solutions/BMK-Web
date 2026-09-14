import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import { isAdmin } from "@/lib/imo3d/auth";
import { readProjectBrandAsset } from "@/lib/imo3d/branding";
import { integrationForRequest } from "@/lib/imo3d/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if(cloudEnabled())return cloudRoute(request);
  const { id } = await context.params;
  const hasAuthorization = request.headers.has("authorization"), integration = integrationForRequest(request);
  if (hasAuthorization && !integration) return Response.json({ error: "مفتاح API غير صالح أو ملغى." }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  if (integration && !integration.scopes.includes("read")) return Response.json({ error: "مفتاح API لا يملك صلاحية القراءة." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  const asset = readProjectBrandAsset(id, !hasAuthorization && isAdmin(request), integration?.projectId);
  if (!asset) return Response.json({ error: "الشعار غير متاح." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(new Uint8Array(asset.bytes), { headers: { "Content-Type": asset.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
