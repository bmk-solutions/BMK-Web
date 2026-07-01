import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // HTML pages: short CDN TTL so deploys show up within minutes.
        // (Hostinger's CDN otherwise honors Next's default year-long
        // s-maxage on prerendered HTML and serves stale pages after deploys.)
        source: "/:path((?!_next/|assets/|brand/|clients/|media/|projects/|tours/|bim/).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
