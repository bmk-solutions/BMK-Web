import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "سياسة الاسترجاع والإلغاء",
  description:
    "سياسة الاسترجاع والإلغاء لخدمات BMK Solutions (شركة هيكل تك): الإلغاء قبل التنفيذ وبعده، آلية الاسترداد خلال 5–14 يوم عمل، ورسوم الطرف الثالث، وفق نظام التجارة الإلكترونية السعودي.",
  alternates: { canonical: "/refund-policy" },
};

export default function RefundPolicy() {
  return (
    <main>
      <Frag name="refund-policy" />
    </main>
  );
}
