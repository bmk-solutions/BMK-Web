import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "تواصل",
  description:
    "تواصل مع BMK Solutions — واتساب +966 56 827 9558، info@bmk.solutions، الروضة، جدة. أرسل تفاصيل مشروعك وسنكمل عبر واتساب.",
};

export default function Contact() {
  return (
    <main>
      <Frag name="contact-page" />
    </main>
  );
}
