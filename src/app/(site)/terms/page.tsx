import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "الشروط والأحكام",
  description:
    "الشروط والأحكام لخدمات BMK Solutions — علامة تجارية تتبع شركة هيكل تك (سجل تجاري 7007295608): نطاق الخدمات، الأسعار والدفع، التسليم، الملكية الفكرية، والضمان.",
  alternates: { canonical: "/terms" },
};

export default function Terms() {
  return (
    <main>
      <Frag name="terms" />
    </main>
  );
}
