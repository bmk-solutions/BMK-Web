import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production verification separate from the running local preview.
  distDir: process.env.IMO3D_BUILD_DIR || ".next",
  devIndicators: false,
  async headers() {
    return [
      {
        // HTML pages: short CDN TTL so deploys show up within minutes.
        // (Hostinger's CDN otherwise honors Next's default year-long
        // s-maxage on prerendered HTML and serves stale pages after deploys.)
        source: "/:path((?!_next/|api/imo3d/|imo3d|assets/|brand/|clients/|media/|projects/|tours/|bim/).*)",
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
