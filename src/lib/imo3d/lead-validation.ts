import { z } from "zod";

/** The one sentence a buyer reads for a number that is refused, here and in VERA's BAD_PHONE answer. */
export const INVALID_LEAD_PHONE = "رقم الجوال غير صحيح. اكتب رقمًا سعوديًا (05…) أو رقمًا دوليًا يبدأ بـ + أو 00.";

/*
 * E.164 calling codes are prefix-free: «1» and «7» are the only one-digit codes, the two-digit
 * ones are listed, every other assigned code is three digits. Enough to find where the national
 * number starts, which «no leading 0 after the code» is a rule about. The same list as VERA's.
 */
const CC1 = new Set(["1", "7"]);
const CC2 = new Set("20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "));
const countryCodeLength = (digits: string) => CC1.has(digits.slice(0, 1)) ? 1 : CC2.has(digits.slice(0, 2)) ? 2 : 3;

/**
 * VERA's rule (bmk-spatial lib/phone.ts normalizeLeadPhone, INTEGRATION-CONTRACT §6), checked
 * first at the tour: a Saudi mobile in any shorthand (05…, 5…, 9665…, 009665…, +9665…, Arabic
 * digits) becomes +9665XXXXXXXX; any other number must start with + or 00 and be E.164-shaped.
 * One Saudi number therefore has one form, which is also its rate-limit key. The tour refuses a
 * few inputs VERA would clean (letters, markup) but never accepts one VERA refuses.
 */
export function normalizeLeadPhone(input: string): string | null {
  if (input.length > 80) return null;
  const text = input.normalize("NFKC").trim()
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  if (!/^\+?[\d\s().\-‎‏]+$/.test(text)) return null;
  const compact = text.replace(/[\s().\-‎‏]/g, "");
  let saudi = compact.replace(/^00/, "").replace(/^\+/, "");
  saudi = saudi.startsWith("966") ? saudi.slice(3) : saudi.startsWith("0") ? saudi.slice(1) : saudi;
  if (/^5\d{8}$/.test(saudi)) return `+966${saudi}`;
  const digits = compact.startsWith("+") ? compact.slice(1) : compact.startsWith("00") ? compact.slice(2) : null;
  if (digits === null || !/^[1-9]\d{7,14}$/.test(digits)) return null;
  const national = digits.slice(countryCodeLength(digits));
  return national.length < 7 || national.length > 14 || national.startsWith("0") ? null : `+${digits}`;
}

/** Validate and normalize before forwarding a lead or deriving its rate-limit key. */
export const leadPhoneSchema = z.string({ error: INVALID_LEAD_PHONE }).max(80, INVALID_LEAD_PHONE).transform((value, context) => {
  const normalized = normalizeLeadPhone(value);
  if (normalized !== null) return normalized;
  context.addIssue({ code: "custom", message: INVALID_LEAD_PHONE });
  return z.NEVER;
});
