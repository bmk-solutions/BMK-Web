import { z } from "zod";

const invalidPhone = "أدخل رقم جوال صالحًا من 8 إلى 15 رقمًا، مع رمز الدولة عند الحاجة.";

/** Canonical formatting, without guessing a country for local numbers. */
export function normalizeLeadPhone(input: string): string | null {
  if (input.length > 80) return null;
  const text = input.normalize("NFKC").trim()
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^\+?[\d\s()-]+$/.test(text)) return null;
  let normalized = text.replace(/[\s()-]/g, "");
  if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
  return /^\+?\d{8,15}$/.test(normalized) ? normalized : null;
}

/** Validate and normalize before storing a lead or deriving its rate-limit key. */
export const leadPhoneSchema = z.string({ error: invalidPhone }).max(80, invalidPhone).transform((value, context) => {
  const normalized = normalizeLeadPhone(value);
  if (normalized !== null) return normalized;
  context.addIssue({ code: "custom", message: invalidPhone });
  return z.NEVER;
});
