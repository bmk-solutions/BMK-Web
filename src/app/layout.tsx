import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import Frag from "@/components/Frag";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.bmk.solutions"),
  title: {
    default: "BMK Solutions — منظومة بصرية ورقمية لمشاريعك العقارية",
    template: "%s — BMK Solutions",
  },
  description:
    "BMK Solutions — منظومة بصرية ورقمية متكاملة لمشاريع العقار والإنشاء في السعودية: توثيق التنفيذ، إنتاج تسويقي، تقارير الإدارة والمستثمرين، منصّات بيع 3D، وجولات وزيارات افتراضية.",
  icons: { icon: "/assets/brand/mark-black.png" },
  openGraph: {
    type: "website",
    siteName: "BMK Solutions",
    title: "BMK Solutions — Visual & Digital Systems for Real Estate",
    description:
      "An integrated visual & digital system across the full real-estate project lifecycle.",
    images: ["/assets/hero.webp"],
    url: "https://www.bmk.solutions",
  },
  twitter: { card: "summary_large_image", images: ["/assets/hero.webp"] },
};

export const viewport: Viewport = {
  themeColor: "#090b11",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" data-theme="dark">
      <body>
        <Frag name="_chrome" />
        <Frag name="_header" />
        {children}
        <Frag name="_footer" />
        <Script src="/assets/js/site.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
