import type { NextConfig } from "next";
import { IMO3D_BASE_PATH } from "./src/lib/imo3d/base-path";

// This deployment's own host. The old public URLs, the ChatGPT connector (its OAuth issuer)
// and every embed stay here; the suite (os.bmk.solutions) forwards /media-support/tour/* to it.
const appOrigin = new URL(process.env.IMO3D_APP_ORIGIN || "https://bmk-imo3d.vercel.app").origin;
// Where the owner signs in. Only reached from this host: through the suite the login page is the suite's own.
const suiteOrigin = new URL(process.env.MS_SUITE_ORIGIN || "https://os.bmk.solutions").origin;
// Old links move with a 307, not a 308: browsers cache a 308 forever, and the cutover must stay reversible.
const moved = (source: string, destination: string) => ({ source, destination, basePath: false as const, permanent: false });
// Next only allows a rewrite outside the basePath to an absolute URL, so these proxy to this same
// deployment: the old paths keep answering byte-for-byte (the owner's ChatGPT connection keeps working).
const kept = (source: string, destination: string) => ({ source, destination: appOrigin + IMO3D_BASE_PATH + destination, basePath: false as const });

const nextConfig: NextConfig = {
  // The studio suite serves this app at os.bmk.solutions/media-support/tour.
  basePath: IMO3D_BASE_PATH,
  // Keep production verification separate from the running local preview.
  distDir: process.env.IMO3D_BUILD_DIR || ".next",
  devIndicators: false,
  async redirects() {
    return [
      // Inside the basePath: one address per page (the studio is the root, a tour is /t/<id>).
      { source: "/imo3d", destination: "/", permanent: false },
      { source: "/imo3d/t/:id", destination: "/t/:id", permanent: false },
      // Old public addresses on this host (shared links, client embeds, stored asset paths).
      moved("/imo3d", IMO3D_BASE_PATH),
      moved("/imo3d/t/:id", `${IMO3D_BASE_PATH}/t/:id`),
      moved("/imo3d/:path*", `${IMO3D_BASE_PATH}/imo3d/:path*`),
      moved("/api/imo3d/assets/:id", `${IMO3D_BASE_PATH}/api/imo3d/assets/:id`),
      moved("/api/imo3d/branding-assets/:id", `${IMO3D_BASE_PATH}/api/imo3d/branding-assets/:id`),
      // The admin pages send a signed-out visitor to /media-support/login; on this host that is the suite's.
      moved("/media-support/login", `${suiteOrigin}/media-support/login`),
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        // The studio at the basePath root (the marketing home page is not part of this deployment's surface).
        { source: "/", destination: "/imo3d" },
        { source: "/t/:id", destination: "/imo3d/t/:id" },
        // Integrations and the ChatGPT connector keep their old paths on this host.
        kept("/api/imo3d/:path*", "/api/imo3d/:path*"),
        kept("/api/imo3d-chatgpt/:path*", "/api/imo3d-chatgpt/:path*"),
        kept("/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server"),
        kept("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource"),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        // HTML pages: short CDN TTL so deploys show up within minutes.
        // (Hostinger's CDN otherwise honors Next's default year-long
        // s-maxage on prerendered HTML and serves stale pages after deploys.)
        // The studio (the basePath root) and tours (/t/) are IMO3D pages and stay uncached, as /imo3d was.
        source: "/:path((?!_next/|api/imo3d/|imo3d|t/|assets/|brand/|clients/|media/|projects/|tours/|bim/).+)",
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
