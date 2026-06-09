# BMK Solutions — Next.js site

Next.js **16** (App Router) + React 19 + TypeScript. This is the Next.js port of the BMK
marketing site (same navy/gold design, official logo, 6 services, bilingual AR/EN, dark/light).

## ⚠️ Build it on a machine with Node (this PC has none)
There is **no Node/npm on the authoring machine**, so the build was authored but NOT run/verified
here. Build & verify on any Node 18+ machine, or deploy straight to **Vercel**.

```bash
cd app/bmk-app
npm install        # deps are already vendored in node_modules, but safe to run
npm run dev        # http://localhost:3000
npm run build      # production build — run this to verify
npm start          # serve the production build
```
Deploy: push to Git and import into **Vercel** (zero config for Next.js), or `vercel` CLI.

## How it's structured
- `src/app/layout.tsx` — `<html lang=ar dir=rtl data-theme=dark>`, metadata, loads global CSS,
  renders shared chrome + header + footer, and loads `/public/assets/js/site.js` via `next/script`.
- Routes: `src/app/page.tsx` (home), `/services`, `/about`, `/packages`, `/contact` — each composes
  section fragments via the `Frag` component and exports per-page `metadata`.
- `src/components/Frag.tsx` — renders a section from `src/content/frags.ts` (a bundled string map
  generated from the verified static site, so content is guaranteed included in the serverless build).
- `src/app/globals.css` — the full navy/gold design system (imported Google Fonts at top).
- `public/assets/` — images (.webp), `brand/` (official logo: mark + lockup, white/black),
  `logos/` (15 client logos), `reel.mp4`, and `js/site.js` (all interactivity: theme/lang toggle,
  custom cursor, gold constellation, scroll FX, 6-services accordion, AI-report carousel, logo
  marquee, contact→WhatsApp form). `public/portal-demo.html` is the live-portal demo.

Navigation uses plain `<a>` (full-page loads) so `site.js` re-initialises every page. Contact/WhatsApp
number is **+966 56 827 9558**. Official logo is theme-aware (white on dark, black on light).

The tested static version remains at `../../website/bmk-website/` (deployable to Netlify as-is).
