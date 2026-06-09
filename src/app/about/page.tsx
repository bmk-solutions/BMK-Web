import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "من نحن",
  description:
    "عن BMK Solutions — الرؤية والرسالة، دورة حياة المشروع، أنواع القيمة السبع، والمستفيدون. شركة بصرية ورقمية مقرّها جدة، مُشغّلة عبر شركة هيكل تك.",
};

export default function About() {
  return (
    <main>
      <Frag name="banner-about" />
      <Frag name="vision-mission" />
      <Frag name="about" />
      <Frag name="project-lifecycle" />
      <Frag name="value-7-types" />
      <Frag name="beneficiaries" />
      <Frag name="clients" />
      <Frag name="cta" />
    </main>
  );
}
