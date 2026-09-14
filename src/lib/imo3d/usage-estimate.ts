import type { ProjectUsage } from "./project-usage";

export type UsageRates = { storagePerGBMonth: number | null; elapsedPerMinute: number | null; transferGB: number | null; transferPerGB: number | null };
/** Optional user-entered unit prices; missing costs stay unknown instead of silently becoming zero. */
export function estimateProjectUsage(usage: ProjectUsage, rates: UsageRates) {
  const valid = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;
  const storage = valid(rates.storagePerGBMonth) ? usage.storage.bytes / 1_000_000_000 * rates.storagePerGBMonth! : null;
  const processing = valid(rates.elapsedPerMinute) ? usage.processing.elapsedSeconds / 60 * rates.elapsedPerMinute! : null;
  const transfer = valid(rates.transferGB) && valid(rates.transferPerGB) ? rates.transferGB! * rates.transferPerGB! : null;
  const known = [storage, processing, transfer].filter((value): value is number => value !== null);
  return { storage, processing, transfer, subtotal: known.reduce((sum, value) => sum + value, 0), complete: known.length === 3 && !usage.storage.missingFiles && !usage.storage.unreadableFiles && !usage.processing.unknownDurationJobs };
}
