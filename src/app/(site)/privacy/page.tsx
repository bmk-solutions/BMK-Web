import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "سياسة الخصوصية",
  description:
    "سياسة الخصوصية لموقع BMK Solutions (شركة هيكل تك): البيانات التي نجمعها، أغراض المعالجة، المدفوعات، ملفات تعريف الارتباط، وحقوقك وفق نظام حماية البيانات الشخصية السعودي.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return (
    <main>
      <Frag name="privacy" />
    </main>
  );
}
