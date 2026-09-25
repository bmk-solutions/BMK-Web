import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { IMO3D_BASE_PATH } from "./src/lib/imo3d/base-path";

type BuildEnv = Record<string, string | undefined>;

/**
 * The host the old paths are proxied to: always THIS deployment. A Vercel preview proxies to its own
 * unique URL (behind its deployment protection), never to production; everything else uses this
 * deployment's public host, IMO3D_APP_ORIGIN (default https://bmk-imo3d.vercel.app, the production alias).
 */
export function selfOrigin(env: BuildEnv = process.env) {
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) return new URL("https://" + env.VERCEL_URL).origin;
  return new URL(env.IMO3D_APP_ORIGIN || "https://bmk-imo3d.vercel.app").origin;
}

/**
 * The branch `main` of this repository is the marketing site www.bmk.solutions, built by Hostinger
 * with `npm run build`. This config puts every page under /media-support/tour, so it must only ever
 * be built for the bmk-imo3d Vercel project: Vercel sets VERCEL=1 (remote builds and `vercel build`);
 * a local verification build opts in with IMO3D_SUITE_BUILD=1. Anywhere else the build stops, and the
 * site that is already live keeps serving, instead of a green build that answers 404 at /.
 */
export function assertSuiteBuild(env: BuildEnv = process.env) {
  if (env.VERCEL === "1" || env.IMO3D_SUITE_BUILD === "1") return;
  throw new Error("This branch serves IMO3D at /media-support/tour and is built only for the bmk-imo3d Vercel project. Never merge it into main (the marketing site). For a local verification build set IMO3D_SUITE_BUILD=1.");
}

/**
 * User agents that get the shared-link card in <head>. Next streams metadata into <body> for every
 * agent outside its own short list, and a link-preview crawler reads only <head>: Snapchat, Viber,
 * Signal and Teams (all used to share a tour in KSA) saw no title, picture or name. This keeps
 * Next's list (WhatsApp, Telegram, Facebook/iMessage, X, Slack, Discord, LinkedIn…) and adds every
 * agent that calls itself a bot, crawler, spider or preview. A browser keeps streamed metadata.
 */
export const LINK_PREVIEW_BOTS =
  /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight|bot|crawler|spider|preview|snapchat|viber|telegram|signal|teams|skype|pinterest|kakaotalk|line-poker|embedly|iframely/i;

export function imo3dConfig(env: BuildEnv = process.env): NextConfig {
  // This deployment's own host. The old public URLs, the ChatGPT connector (its OAuth issuer)
  // and every embed stay here; the suite (os.bmk.solutions) forwards /media-support/tour/* to it.
  const appOrigin = selfOrigin(env);
  // Where the owner signs in. Only reached from this host: through the suite the login page is the suite's own.
  const suiteOrigin = new URL(env.MS_SUITE_ORIGIN || "https://os.bmk.solutions").origin;
  // Old links move with a 307, not a 308: browsers cache a 308 forever, and the cutover must stay reversible.
  const moved = (source: string, destination: string) => ({ source, destination, basePath: false as const, permanent: false });
  // Next only allows a rewrite outside the basePath to an absolute URL, so these proxy to this same
  // deployment: the old paths keep answering byte-for-byte (the owner's ChatGPT connection keeps working).
  const kept = (source: string, destination: string) => ({ source, destination: appOrigin + IMO3D_BASE_PATH + destination, basePath: false as const });
  // The admin pages open only inside the owner's suite session (src/proxy.ts): no shared cache may keep one.
  const privatePage = (source: string) => ({ source, headers: [{ key: "Cache-Control", value: "private, no-store" }] });

  return {
    // The studio suite serves this app at os.bmk.solutions/media-support/tour.
    basePath: IMO3D_BASE_PATH,
    // Keep production verification separate from the running local preview.
    distDir: env.IMO3D_BUILD_DIR || ".next",
    devIndicators: false,
    htmlLimitedBots: LINK_PREVIEW_BOTS,
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
        privatePage("/"),
        privatePage("/imo3d/connect-chatgpt"),
      ];
    },
  };
}

export default function nextConfig(phase: string) {
  if (phase === PHASE_PRODUCTION_BUILD) assertSuiteBuild();
  return imo3dConfig();
}
