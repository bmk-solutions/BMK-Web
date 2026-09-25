import type { Metadata } from "next";
import WebsiteChrome from "@/components/WebsiteChrome";
import Frag from "@/components/Frag";
import { withBasePath } from "@/lib/imo3d/base-path";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.bmk.solutions"),
  title: {
    default: "BMK Solutions — منظومة بصرية ورقمية لمشاريعك العقارية",
    template: "%s — BMK Solutions",
  },
  description:
    "BMK Solutions — منظومة بصرية ورقمية متكاملة لمشاريع العقار والإنشاء في السعودية: توثيق التنفيذ، إنتاج تسويقي، تقارير الإدارة والمستثمرين، منصّات بيع 3D، وجولات وزيارات افتراضية.",
  // Under the suite basePath: metadata icon URLs are not prefixed by Next, public files are.
  icons: { icon: withBasePath("/assets/brand/mark-black.png") },
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

const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "BMK Solutions",
  legalName: "Company haykal tak",
  alternateName: ["BMK Solutions", "شركة هيكل تك", "Haykal Tak Company"],
  identifier: {
    "@type": "PropertyValue",
    propertyID: "CR",
    name: "Commercial Registration (سجل تجاري)",
    value: "7007295608",
  },
  vatID: "314084197400003",
  taxID: "314084197400003",
  brand: { "@type": "Brand", name: "BMK Solutions" },
  url: "https://www.bmk.solutions",
  logo: "https://www.bmk.solutions/assets/brand/lockup-white.png",
  email: "info@bmk.solutions",
  telephone: "+966568279558",
  address: {
    "@type": "PostalAddress",
    streetAddress: "مبنى 2989، شارع ابن الصقر، حي الروضة",
    addressLocality: "Jeddah",
    postalCode: "23435",
    addressCountry: "SA",
  },
  sameAs: [
    "https://instagram.com/_bmk.solutions",
    "https://x.com/_bmk_solutions",
  ],
};

/** The marketing pages: BMK's own name, card, JSON-LD, header and footer (the tour and studio have none). */
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
      />
      <WebsiteChrome header={<><Frag name="_chrome" /><Frag name="_header" /></>} footer={<Frag name="_footer" />}>
        {children}
      </WebsiteChrome>
    </>
  );
}
