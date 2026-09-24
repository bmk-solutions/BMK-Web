import {cloudEnabled} from "@/lib/imo3d/cloud/client";
import {cloudRoute} from "@/lib/imo3d/cloud/handlers";
import sharp from "sharp";
import { z } from "zod";
import { isAdmin, sameOrigin } from "@/lib/imo3d/auth";
import { brandingForProject, brandingPatchSchema, brandingProjectExists, brandingProjectReadable, saveProjectBranding } from "@/lib/imo3d/branding";
import { integrationForRequest } from "@/lib/imo3d/integrations";
import {servePayloadPaths} from "@/lib/imo3d/base-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const maxLogoBytes = 5 * 1024 * 1024;
const json = (value: unknown, status = 200) => Response.json(servePayloadPaths(value), { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });

class BrandingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function boundedBody(request: Request, maximum: number) {
  if (Number(request.headers.get("content-length")) > maximum) throw new BrandingError("حجم الملف أكبر من الحد المسموح.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BrandingError("البيانات المرسلة فارغة.");
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new BrandingError("حجم الملف أكبر من الحد المسموح.", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function handle(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  const { id } = await context.params;
  const hasAuthorization = request.headers.has("authorization"), integration = integrationForRequest(request);
  if (hasAuthorization && !integration) return json({ error: "مفتاح API غير صالح أو ملغى." }, 401);
  const admin = !hasAuthorization && await isAdmin(request);
  if (request.method === "GET") {
    const readable = integration ? integration.projectId === id && integration.scopes.includes("read") && brandingProjectExists(id) : brandingProjectReadable(id, admin);
    return readable ? json(brandingForProject(id)) : json({ error: "المشروع غير متاح." }, 404);
  }
  if (!admin && !(integration?.projectId === id && integration.scopes.includes("write"))) return json({ error: integration ? "المشروع أو العملية خارج صلاحية مفتاح API." : "تسجيل دخول الإدارة مطلوب." }, integration ? 403 : 401);
  if (!integration && !sameOrigin(request)) return json({ error: "المصدر غير مسموح." }, 403);
  if (!brandingProjectExists(id)) return json({ error: "المشروع غير موجود." }, 404);
  if (request.method === "PATCH") {
    let input: unknown;
    try { input = JSON.parse((await boundedBody(request, 4000)).toString("utf8")); }
    catch (error) { if (error instanceof BrandingError) throw error; throw new BrandingError("بيانات العلامة غير صالحة."); }
    return json(saveProjectBranding(id, brandingPatchSchema.parse(input)));
  }
  const bytes = await boundedBody(request, maxLogoBytes + 16_384);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData(); }
  catch { throw new BrandingError("تعذر قراءة ملف الشعار. أعد اختيار الصورة."); }
  const input = brandingPatchSchema.parse({ name: form.get("name"), accent: form.get("accent"),logoStyle:form.get("logoStyle")??undefined });
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new BrandingError("اختر صورة الشعار.");
  if (file.size > maxLogoBytes) throw new BrandingError("الحد الأقصى للشعار 5 ميجابايت.", 413);
  const source = Buffer.from(await file.arrayBuffer());
  const rasterHeader = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    source.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    (source.subarray(0, 4).toString("ascii") === "RIFF" && source.subarray(8, 12).toString("ascii") === "WEBP");
  if (!rasterHeader) throw new BrandingError("اختر شعارًا ثابتًا بصيغة PNG أو JPG أو WEBP.", 415);
  let output: Buffer;
  try {
    const image = sharp(source, { limitInputPixels: 16_777_216, animated: false });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new BrandingError("اختر شعارًا ثابتًا بصيغة PNG أو JPG أو WEBP.", 415);
    }
    output = await image.rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 100 }).toBuffer();
  } catch (error) {
    if (error instanceof BrandingError) throw error;
    throw new BrandingError("تعذر قراءة صورة الشعار. اختر ملف PNG أو JPG أو WEBP صالحًا.", 415);
  }
  return json(saveProjectBranding(id, input, output));
}

async function safe(request: Request, context: Context) {
  if(cloudEnabled())return cloudRoute(request);
  try { return await handle(request, context); }
  catch (error) {
    if (error instanceof BrandingError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: error.issues[0]?.message ?? "بيانات العلامة غير صالحة." }, 400);
    return json({ error: "تعذر حفظ العلامة. لم يتم تأكيد الحفظ؛ حاول مجددًا." }, 500);
  }
}
export { safe as GET, safe as PATCH, safe as POST };
