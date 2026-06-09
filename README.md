# BMK Solutions — Website

Flagship one-page marketing site for **BMK Solutions** (Visual Construction Intelligence, Jeddah · KSA).
Dark, **architectural-monochrome + champagne-gold**, motion-rich, fully bilingual **English / Arabic** with proper RTL.
Built around BMK's real brand kit, real project imagery, and real client logos.

## Highlights / interactive features

- **Logo-intro preloader** (uses BMK's own logo animation)
- **Cinematic hero** — looping golden-hour drone film, word-by-word reveal, count-up stats
- **Interactive AI portal demo** — clickable live site map, typewriter report, animated gauge
- **Drone progress timeline** — drag-to-scrub through real site phases (`#progress`)
- **360° tour viewer** — drag-to-look real AR/VR panoramas, auto-pan + zoom (`#tours`)
- **Filterable projects gallery** with lightbox (`#work`)
- **Working contact form** — composes a prefilled WhatsApp/email message (no backend); wire-ready for Formspree/Resend
- Magnetic buttons, tilt cards, scroll reveals, smooth (Lenis) scrolling, cursor glow

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind v4** + a custom CSS design system (`src/app/globals.css`)
- **motion** (Framer Motion) for animation, **lenis** for smooth scrolling
- All hero/section media generated with AI and optimized to WebP / H.264+VP9

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (static-prerendered)
npm run start    # serve the production build
```

## Project structure

```
src/
  app/
    layout.tsx        # fonts, metadata, providers, ambient background layers
    page.tsx          # section composition
    globals.css       # design tokens + component styles + RTL handling
    icon.svg          # favicon (BMK monogram)
  lib/
    content.ts        # ALL copy, EN + AR (single source of truth)
    i18n.tsx          # language context, <html dir/lang> switching, persistence
  components/
    Navbar, Hero, Positioning, ServiceLayers, PlatformDemo,
    Packages, WhyItMatters, TrustedBy, Contact, Footer
    primitives.tsx    # Reveal, Counter, Magnetic, Tilt, useInViewport, ...
    icons.tsx         # inline SVG logo + icon set
    SmoothScroll.tsx, CursorGlow.tsx
public/media/         # generated + optimized imagery and hero video
scripts/
  optimize-media.mjs  # PNG -> sized WebP (dev utility)
  shoot.mjs           # Puppeteer screenshot harness (dev utility)
```

## Editing content

Everything the visitor reads lives in **`src/lib/content.ts`** under `en` and `ar`.
Update brand facts (phone, email, socials) in the `brand` object and the client list in `clients`.

## Language

- Toggle in the navbar (EN / ع). Choice is saved to `localStorage`; Arabic visitors are auto-detected.
- Switching sets `dir="rtl"` and swaps the body font to IBM Plex Sans Arabic. Layout uses CSS
  logical properties so it mirrors automatically.

## Media & brand assets

- `public/brand/` — white BMK logo (mark + lockups) and the logo-intro video/poster
- `public/projects/` — real drone orthomosaics & aerials (progress timeline)
- `public/tours/` — real 360° equirectangular panoramas (residential, NGHA Riyadh)
- `public/bim/` — real BIM clash/MEP/model screenshots (gallery + service layers)
- `public/clients/companies.webp` — real client logo wall
- `public/media/` — AI-generated cinematic hero (`hero-web.mp4/.webm`, `hero.webp`, `hero-poster.webp`) and `blueprint.webp`

Real source assets were optimized to WebP (and the video to H.264/VP9) via:

```bash
npm install --no-save sharp ffmpeg-static
node scripts/brand-assets.mjs   # real brand/project assets → /public
node scripts/optimize-media.mjs # AI media → /public/media
```

## Wiring the form to a real backend (optional)

`Contact.tsx` currently composes a prefilled WhatsApp/email message — fully working with no server.
To capture submissions to a database/inbox instead, POST the form state to Formspree, Resend, or a
Next.js route handler in the form's `onSubmit` (the composed `body` string is already assembled there).

## Deploy

The app is fully static-prerendered. Deploy to **Vercel** (zero config) or any static/Node host.
No environment variables required.
