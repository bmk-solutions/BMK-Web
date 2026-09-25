import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "الخدمات",
  description:
    "الخدمات الست من BMK: توثيق المشاريع ومنصّات المتابعة، الإنتاج التسويقي، تقارير الإدارة والمستثمرين، منصّات 3D التفاعلية، الجولات الافتراضية، ومنصّة الزيارات الافتراضية.",
};

export default function Services() {
  return (
    <main>
      <Frag name="banner-services" />
      <Frag name="the-six-services-accordion" />
      <Frag name="platform" />
      <Frag name="ai-reports" />
      <Frag name="deliverables" />
      <Frag name="cta" />
    </main>
  );
}
