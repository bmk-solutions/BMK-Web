import type { Viewport } from "next";
import "./globals.css";

/*
 * The document shell only. The marketing site's metadata, its Organization JSON-LD and its header
 * and footer live in (site)/layout.tsx, so a buyer's tour (/t/<id>) and the studio carry nothing
 * of BMK's own: the tour is white-labelled under the developer's name.
 */
export const viewport: Viewport = {
  themeColor: "#090b11",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" data-theme="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
