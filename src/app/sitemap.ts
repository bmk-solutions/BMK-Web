import type { MetadataRoute } from "next";

const BASE = "https://www.bmk.solutions";
const UPDATED = new Date("2026-07-14");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, lastModified: UPDATED, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/services`, lastModified: UPDATED, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/packages`, lastModified: UPDATED, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/about`, lastModified: UPDATED, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/contact`, lastModified: UPDATED, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE}/terms`, lastModified: UPDATED, changeFrequency: "yearly", priority: 0.5 },
    { url: `${BASE}/privacy`, lastModified: UPDATED, changeFrequency: "yearly", priority: 0.5 },
    { url: `${BASE}/refund-policy`, lastModified: UPDATED, changeFrequency: "yearly", priority: 0.5 },
  ];
}
