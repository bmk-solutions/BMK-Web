import type { Metadata } from "next";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  title: "الباقات",
  description:
    "باقات BMK Solutions: الخفيفة، المميّزة، والاحترافية — كلها تعمل على المنصّة ذاتها، مع أسعار خاصّة لعقود 3 أشهر فأكثر.",
};

export default function Packages() {
  return (
    <main>
      <Frag name="banner-packages" />
      <Frag name="packages" />
      <Frag name="value-7-types" />
      <Frag name="cta" />
    </main>
  );
}
