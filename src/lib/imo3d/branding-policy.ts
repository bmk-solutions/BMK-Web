import {z} from "zod";
export type ProjectBranding = { name: string; logo?: string; accent: string; logoStyle?:"clean"|"original" };
export const defaultBranding: ProjectBranding = { name: "IMO 3D", accent: "#24b18b" };

export const brandingPatchSchema = z.object({
  name: z.string({ error: "أدخل اسم العلامة المعروض." }).trim().min(1, "أدخل اسم العلامة المعروض.").max(80, "اسم العلامة لا يزيد على 80 حرفًا."),
  accent: z.string({ error: "اختر لونًا صالحًا للعلامة." }).regex(/^#[\da-f]{6}$/i, "اختر لونًا صالحًا للعلامة.").transform(value => value.toLowerCase()),
  removeLogo: z.boolean().optional().default(false),
  logoStyle:z.enum(["clean","original"]).optional(),
});

