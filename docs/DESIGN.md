# Design system and screen inventory

2026-09-24 source snapshot. **Preserve the existing visual design and interaction unless explicitly asked to change it.** There are two related but distinct surfaces: BMK marketing and IMO3D studio/viewer. Do not apply marketing gold/dark styling wholesale to the studio. This document describes implemented code, not a proposed redesign.

## Global marketing tokens

Source: `src/app/globals.css`. Fonts load through Google Fonts CSS, not bundled local font binaries.

| Token | Dark default | Light override |
|---|---|---|
| `--bg` | `#090b11` | `#f3f1eb` |
| `--bg2` | `#0f131c` | `#eae7de` |
| `--panel` | `#0d1119` | `#fdfcf9` |
| `--panel2` | `#11151f` | `#f4f1e9` |
| `--tx` | `#f3f0e8` | `#11141c` |
| `--muted` | `#9aa3b2` | `#525b6b` |
| `--faint` | `#6b7484` | `#8a8576` |
| `--accent` / `--accent2` | `#c8a85c` / `#e7c878` | inherited |
| `--accent-ink` | `#15110a` | inherited |
| `--line` | `rgba(243,240,232,.12)` | `rgba(17,20,28,.13)` |
| `--line2` | `rgba(243,240,232,.06)` | `rgba(17,20,28,.06)` |
| `--glass` / `--glass-hi` | white `.045` / `.085` | white `.55` / `.78` |
| `--glass-brd` / `--glass-top` | white `.11` / `.08` | dark `.1` / white `.9` |

`--maxw:1240px`; radii `--rad:20px`, `--rad-lg:26px`, `--rad-sm:13px`; pill controls999px. Blur `blur(20px) saturate(160%)`. Standard easing `cubic-bezier(.22,.61,.36,1)` and spring `cubic-bezier(.34,1.3,.5,1)`.

Dark shadow1: `0 1px 2px rgba(0,0,0,.28),0 14px 38px -16px rgba(0,0,0,.5)`; shadow2: `0 2px 4px rgba(0,0,0,.3),0 26px 60px -22px rgba(0,0,0,.62)`. Light variants use darkRGB17/20/28 with alpha `.06/.16` and `.07/.22` respectively.

## Typography

- Arabic: `--f-ar:'Alexandria',sans-serif`, requested weights200–800.
- English headings: `--f-en:'Space Grotesk',sans-serif`, weights400–700.
- English body: `--f-body:'Inter',sans-serif`, weights400/500/600.
- Technical labels/counters: `--f-mono:'Space Mono',monospace`, weights400/700.
- Marketing headings line-height1.08, weight600, tracking about-.01em. Hero `clamp(38px,6.6vw,86px)`; section titles `clamp(30px,4vw,52px)`; hero subtitle `clamp(15px,1.5vw,18.5px)`.
- Studio base font uses Alexandria/Arial, directionRTL and line-height1.7. Base CSS starts at14px then later overrides shell/dialog to16px, main controls14px, small text12px. Do not infer final font sizes from the first CSS rule only.
- Mobile form controls use16px to avoid iOS auto-zoom. Viewer compact labels are generally10–14px; inspect final responsive override per component.

## IMO3D palette and surfaces

`src/app/imo3d/imo3d.css` base variables: ink `#202c30`, muted `#67777b`, line `#e2e7e7`, green `#175f57`, gold `#dfc994`, surface `#f6f8f8`.

`liquid-glass.css` studio override: ink `#183532`, line `#dae4e2`, base `#f3f6f5`, radial tints `#dfece9` and `#eeeadf`. Sidebar/top `#f9fbfa`; large panels `#fafcfb`; cards `#fbfdfc`; active sidebar `#deece6` with `#154c40` ink. Card border white; hover border `#afcbc2`. Large panels20px radius; cards22px; settings rows16px; buttons12px, minimum46px height; nav buttons13px radius/min48px.

Panel shadow `0 8px 32px #173c3306, inset 0 1px 0 #fff`; card `0 8px 30px #163b320a`, hover `0 14px 36px #163b3217`. Transparent layers have opaque fallbacks for browsers lacking backdrop-filter. Maximum studio content width1680px.

Viewer controls overlay imagery in dark green glass (`#122923b3`, related `#102821c7`/`#12251db0`) with white foreground and contrast outlines/shadows. Measurement highlight uses gold/yellow (e.g. `#ffdd83`, focus `#ffcf52`). Project branding can set `--imo-accent`/`--imo-accent-ink`; keep per-project overrides, not hardcoded Hamra identity.

## Layout, spacing and icons

There is no single universal spacing-token scale in the code. Local values commonly4/6/8/10/12/14/16/20/22/24/28/32px, with fluid viewport-based layouts. Exact declarations and media queries are catalogued in the appended CSS inventory; the source cascade is authoritative.

- Shared `Icon.tsx` provides inline SVG icons, generally20–24px, often23px in viewer dock. Preserve strokes/viewBox/accessible labels rather than introduce another icon library.
- Studio has sidebar, topbar, heading/actions, project cards or selected-tour editor. Editor separates main tabs from side settings/preview. Responsive rules collapse columns and allow horizontal tab scrolling.
- Modals use `Dialog.tsx`, bounded viewport size and internal scrolling. Respect focus/keyboard/backdrop behavior already implemented. Do not silently turn inline unit details back into a modal.
- Viewer contains full canvas, brand/title overlay, room state, map/heading, inline unit summary, tool dock and optional overlay dialogs. UI controls must not trigger panorama navigation underneath.
- Unit summary is directly under the plan, transparent, white text with `0 1px 3px #071d18,0 0 9px #071d1890`; displays configured area/bedrooms/bathrooms and optional price. No blank price field when absent.

## CSS layering: preserve order

Global marketing CSS loads in root layout. IMO3D base CSS loads in its layout. Studio imports `studio-workflows.css` then `liquid-glass.css`. Viewer imports `viewer-mobile.css`, `room-functions.css`, `liquid-glass.css`, `viewer-clean.css`, then `viewer-presentation.css`; child components import their own styles. Later selectors and `!important` alter earlier rules. Do not reorder or consolidate these files without an explicit refactor request and visual regression checks.

## Marketing routes

Public routes use `src/content/frags.ts` via `Frag`; interactions are wired by `public/assets/js/site.js`. `WebsiteChrome` supplies header/footer only outside `/imo3d`.

| Route | Screen/content and behavior |
|---|---|
| `/` | BMK hero/media, positioning/services, projects/visual demos, packages/trust/contact sections; navigation anchors, reveals and media interactions |
| `/about` | Company story, visual/property-sector positioning and supporting imagery/content |
| `/services` | Service descriptions and interactive service presentation |
| `/packages` | Package comparison/cards and contact calls to action |
| `/contact` | Contact form/content and WhatsApp/email handoff; do not mistake composed messages for a server inbox integration |
| `/privacy` | Privacy policy text |
| `/terms` | Terms of service text |
| `/refund-policy` | Refund policy text |
| `/portal-demo.html` | Separate public static demo asset; not IMO3D administration |

Inspect each route's selected fragment name before editing copy. Preserve factual/legal text unless explicitly requested.

## IMO3D routes, screens and states

### `/imo3d`: login/dashboard

Login card includes IMO3D branding, Arabic title, administration password input with eye toggle, submit state/error. `PasswordInput` handles visibility. Dashboard verifies session first, then loads developers/projects/tours and enquiries. Sidebar/navigation and search/filter controls switch views. Developer directory contains associated projects; project cards support multiple tours, branding, usage and management. Password changes are in administration settings, not exposed to public visitors.

### Tour editor inside studio

Editor is selected-tour state on `/imo3d`, not a separate public route. Header has editable title, draft/publish state, save/preview/delete. Four workflow stages show uploaded photos, analysis/spatial linking, plan/review and sharing readiness. Actual coverage counts distinguish analyzed photos from globally positioned cameras; no fake100% on partial registration.

Tabs/panels cover upload thumbnails, semantic rooms, manual links, room-entry camera orientation, plan/architecture, unit information, hotspots, AI retouch and measurement scale. Project tools expose branding/API keys/management. Upload cards allow naming/deleting incorrect photos. Preview may open an embedded viewer without losing unsaved editor data. Saving uses revision checks; errors, cancellation and stale jobs are visible.

### AI plan panel and draft review

Shows worker online/configured state, queue phase/progress, cancellation/retry and Gemini error messages. Generation follows supported upload workflow automatically. Drafts show floor/room coverage and limitations; user can edit room names before approval. Existing approved plan stays on failed new generation. Images/labels/registered scene coordinates are separate evidence. Provider success is not automatic architectural acceptance.

### Manual plan editors and exports

2D room polygons, walls, openings and floor assignment are editable where supported. Architectural review controls mark reviewed geometry explicitly. Vector/raster/3D map modes must preserve their evidence distinctions. Export/download controls produce supported formats; do not interpret unreviewed 3D visualization as surveyed BIM.

### Manual links and entry views

Select source/destination points, add/delete/reset overrides under project/tour scope. Entry view editor captures yaw/pitch/FOV for room/scene selection. Room selection should face the configured subject, not automatically show a wall. User's requirement: clicking a wall in a room picks an appropriate point in that room; exits only through observed doorway relationships.

### Hotspots and image editing

Hotspot editor selects scene/type/position/content/style; viewer overlay can open media/link/product/area content. Hide/edit/delete is per point. AI retouch selects a region and prompt (including tripod shortcut), queues existing Codex workflow, shows comparison, then explicit approve/restore. Keep original image and geometry source separate from edited display pixels.

### `/imo3d/t/[id]`: tour viewer

Initial load/error/empty-tour screens are distinct. Viewer fetches authorized tour/media, renews signed media URLs and renders panorama. Mouse drag/touch rotate, supported keys move, scroll/pinch adjusts view, and destination indicator assists near/far click navigation. Downward pitch restriction reduces tripod visibility; it is not image removal.

Plan header contains plan title/expand and eye visibility control. Eye hides the map while control remains accessible; map heading shows current camera direction. Unit details remain under plan. Room panel/thumbnails support scene entry views; options include controls/overlays, fullscreen and related viewer settings. Keep loading states unobtrusive without pretending unavailable textures are ready.

Measurement tool lets users select endpoints with supported geometry/scale, choose units, see labels, select/delete one, clear all or hide without deleting. Labels persist through scene moves via tour-scoped browser storage. Vertical/floor/depth inference can be estimated or unavailable; do not remove this distinction. Avoid treating a local notebook as cloud-synchronized storage.

### Other IMO3D screens

- `/imo3d/api`: API integration guide, request examples and scoped-key guidance; never show server secrets.
- `/imo3d/connect-chatgpt`: optional account/project authorization flow for legacy MCP draft access; separate from Gemini key entry.
- Lead inbox: query/filter/pagination and contact data under administrator authorization.
- Branding: project title/logo/colors; private storage uploads; public viewer consumes approved assets.
- Unit details: area/bed/bath/price values, no forced empty price; lead registration CTA where configured.
- Measurement calibration/architecture dialogs: administrator evidence/configuration, not a forced request for visitor camera height.

## Languages and direction

Root HTML defaults `lang="ar" dir="rtl" data-theme="dark"`. Marketing `site.js` changes lang/dir and stores `bmk_lang`, with theme stored `bmk_theme`. Arabic uses Alexandria, English body Inter/headings Space Grotesk. Do not follow old README's IBM Plex/i18n.tsx description: current code uses fragments/site.js, and that older i18n module is absent.

IMO3D shell explicitly sets directionRTL. Its strings are largely Arabic literals; it is not a complete EN/AR translation system. Preserve number/unit legibility, icon order, logical properties and LTR fields such as URLs. Scope localization work separately rather than accidentally switching the whole viewer.

## Mobile, touch and accessibility

Important breakpoints include1200/900/720/700/600/380px and low-height480/560px rules, depending on component. Do not replace them with one generic breakpoint.

- Viewer mobile uses `env(safe-area-inset-*)`, `100dvh` and a bottom dock, typically68px-wide tools/min56px height. Compact map at <=720px is about164px wide with182px canvas/max25dvh; low-height rules reduce overlays.
- Touch targets usually44px or larger in final viewer controls; check inherited earlier styles. Form inputs16px and scrollable bounded dialogs prevent viewport zoom/overflow.
- Unit summary remains transparent and compact; fewer details in short landscape height. Map/dock must not block underlying room navigation.
- `prefers-reduced-motion` suppresses relevant transitions/scroll effects. Keep visible focus, aria labels on progress/buttons, adequate overlay contrast, disabled states and error text.
- Test390px phone portrait, small320–380px width, landscape low-height and desktop. Check Arabic long labels, missing price/logo, large room lists, slow image loading and keyboard focus.

## Source appendix

The following generated inventory records all CSS custom-property declarations, per-file colors/fonts/sizes/spacing/radii/shadows and breakpoints from the actual stylesheets. It is an exact-value reference, not a recommendation to unify them. Source order/selectors and viewport determine computed appearance.

### `src/app/globals.css`

Custom properties (including contextual overrides, in source order):

```css
--bg: #090b11;
--bg2: #0f131c;
--panel: #0d1119;
--panel2: #11151f;
--tx: #f3f0e8;
--muted: #9aa3b2;
--faint: #6b7484;
--accent: #c8a85c;
--accent2: #e7c878;
--accent-ink: #15110a;
--line: rgba(243,240,232,.12);
--line2: rgba(243,240,232,.06);
--maxw: 1240px;
--rad: 20px;
--rad-lg: 26px;
--rad-sm: 13px;
--glass: rgba(255,255,255,.045);
--glass-hi: rgba(255,255,255,.085);
--glass-brd: rgba(255,255,255,.11);
--glass-top: rgba(255,255,255,.08);
--shadow-1: 0 1px 2px rgba(0,0,0,.28),0 14px 38px -16px rgba(0,0,0,.5);
--shadow-2: 0 2px 4px rgba(0,0,0,.3),0 26px 60px -22px rgba(0,0,0,.62);
--blur: blur(20px) saturate(160%);
--f-ar: 'Alexandria',sans-serif;
--f-en: 'Space Grotesk',sans-serif;
--f-mono: 'Space Mono',monospace;
--f-body: 'Inter',sans-serif;
--ease: cubic-bezier(.22,.61,.36,1);
--spring: cubic-bezier(.34,1.3,.5,1);
--bg: #f3f1eb;
--bg2: #eae7de;
--panel: #fdfcf9;
--panel2: #f4f1e9;
--tx: #11141c;
--muted: #525b6b;
--faint: #8a8576;
--line: rgba(17,20,28,.13);
--line2: rgba(17,20,28,.06);
--glass: rgba(255,255,255,.55);
--glass-hi: rgba(255,255,255,.78);
--glass-brd: rgba(17,20,28,.1);
--glass-top: rgba(255,255,255,.9);
--shadow-1: 0 1px 2px rgba(17,20,28,.06),0 14px 38px -16px rgba(17,20,28,.16);
--shadow-2: 0 2px 4px rgba(17,20,28,.07),0 26px 60px -22px rgba(17,20,28,.22);
```

**Colors**: `#000`; `#070910`; `#090b11`; `#0a0d14`; `#0d1119`; `#0f131c`; `#11141c`; `#11151f`; `#15110a`; `#1faf54`; `#3aae62`; `#525b6b`; `#6b7484`; `#8a8576`; `#9aa3b2`; `#c8a85c`; `#e0533a`; `#e7c878`; `#eae7de`; `#f3f0e8`; `#f3f1eb`; `#f4f1e9`; `#fdfcf9`; `#fff`; `rgba(0,0,0,.28)`; `rgba(0,0,0,.3)`; `rgba(0,0,0,.45)`; `rgba(0,0,0,.5)`; `rgba(0,0,0,.62)`; `rgba(17,20,28,.06)`; `rgba(17,20,28,.07)`; `rgba(17,20,28,.1)`; `rgba(17,20,28,.13)`; `rgba(17,20,28,.16)`; `rgba(17,20,28,.22)`; `rgba(243,240,232,.06)`; `rgba(243,240,232,.12)`; `rgba(255,255,255,.045)`; `rgba(255,255,255,.08)`; `rgba(255,255,255,.085)`; `rgba(255,255,255,.1)`; `rgba(255,255,255,.11)`; `rgba(255,255,255,.12)`; `rgba(255,255,255,.14)`; `rgba(255,255,255,.3)`; `rgba(255,255,255,.42)`; `rgba(255,255,255,.55)`; `rgba(255,255,255,.62)`; `rgba(255,255,255,.7)`; `rgba(255,255,255,.74)`; `rgba(255,255,255,.78)`; `rgba(255,255,255,.9)`; `rgba(31,175,84,.5)`; `rgba(7,9,14,.62)`; `rgba(7,9,14,.85)`; `rgba(7,9,14,.9)`.

**Fonts**: `inherit`; `var(--f-ar)`; `var(--f-body)`; `var(--f-en)`; `var(--f-mono)`.

**Font sizes**: `10.5px`; `10px`; `11.5px`; `11px`; `12.5px`; `12px`; `13.5px`; `13px`; `14.5px`; `14px`; `15.5px`; `15px`; `16.5px`; `16px`; `17.5px`; `17px`; `18px`; `19px`; `20px`; `22px`; `24px`; `26px`; `30px`; `40px`; `8px`; `9px`; `clamp(15px,1.5vw,18.5px)`; `clamp(15px,1.6vw,18px)`; `clamp(18px,2.3vw,25px)`; `clamp(24px,3.3vw,42px)`; `clamp(28px,3.6vw,46px)`; `clamp(30px,4vw,52px)`; `clamp(34px,4.4vw,52px)`; `clamp(34px,5.4vw,72px)`; `clamp(34px,5.6vw,66px)`; `clamp(38px,6.6vw,86px)`.

**Line heights**: `1`; `1.04`; `1.06`; `1.08`; `1.32`; `1.5`; `1.55`; `1.6`; `1.65`; `1.7`; `1.75`; `1.8`; `1.9`.

**Spacing (padding/margin/gap)**: `-14px 0 22px`; `0`; `0 0 26px`; `0 20px`; `0 28px`; `0 36px`; `0 auto`; `10px`; `10px 0`; `11px`; `11px 17px`; `120px 0`; `12px`; `12px 0`; `12px 15px`; `12px 19px`; `12px 22px`; `12px 24px`; `130px 0 44px`; `13px`; `13px 15px`; `13px 17px`; `140px 0`; `14px`; `14px 0 6px`; `150px 0 58px`; `15px`; `15px 0`; `15px 30px`; `165px 0 72px`; `16px`; `16px 0`; `16px 18px`; `18px`; `18px 0`; `18px 0 8px`; `1px`; `20px`; `20px 0`; `20px 18px`; `20px 22px`; `22px`; `22px 0`; `22px 0 18px`; `22px 24px`; `24px`; `24px 20px`; `24px 26px`; `24px auto 40px`; `26px`; `26px 0`; `26px 22px`; `26px 24px`; `28px 26px`; `2px`; `30px`; `30px 26px`; `30px 32px`; `30px 4px`; `32px`; `34px`; `34px 28px`; `36px`; `38px`; `38px 30px`; `38px 32px`; `3px`; `3px 10px`; `40px`; `42px`; `42px 38px`; `46px`; `4px 8px 12px`; `50px`; `54px`; `56px`; `5px`; `5px 12px`; `5px 13px`; `5px 9px`; `60px`; `64px`; `6px`; `6px 0 40px`; `70px 0 90px`; `7px`; `84px 0`; `8px`; `8px 0`; `8px 18px`; `8px 26px`; `92px`; `9px`; `9px 22px`; `auto`.

**Radii**: `11px`; `14px`; `16px`; `20px`; `2px`; `30px`; `4px`; `50%`; `6px`; `999px`; `9px`; `calc(var(--rad-lg) - 12px)`; `var(--rad)`; `var(--rad-lg)`; `var(--rad-sm)`.

**Shadows**: `0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)`; `0 0 10px #e0533a`; `0 0 10px color-mix(in srgb,var(--accent) 70%,transparent)`; `0 10px 26px -8px color-mix(in srgb,var(--accent) 55%,transparent)`; `0 10px 30px -8px color-mix(in srgb,var(--accent) 60%,transparent)`; `0 12px 30px -8px rgba(31,175,84,.5)`; `0 1px 0 var(--glass-top) inset,0 10px 34px -18px rgba(0,0,0,.45)`; `inset 0 1px 0 rgba(255,255,255,.1)`; `inset 0 1px 0 rgba(255,255,255,.42)`; `inset 0 1px 0 rgba(255,255,255,.42),0 10px 26px -10px color-mix(in srgb,var(--accent) 60%,transparent)`; `inset 0 1px 0 rgba(255,255,255,.42),0 8px 22px -10px color-mix(in srgb,var(--accent) 55%,transparent)`; `inset 0 1px 0 var(--glass-top)`; `inset 0 1px 0 var(--glass-top),var(--shadow-1)`; `inset 0 1px 0 var(--glass-top),var(--shadow-2)`.

**Responsive conditions**: `(hover:none),(pointer:coarse)`; `(max-width:1080px)`; `(max-width:680px)`; `(max-width:880px)`; `(prefers-reduced-motion:reduce)`.


### `src/app/imo3d/imo3d.css`

Custom properties (including contextual overrides, in source order):

```css
--imo-ink: #202c30;
--imo-muted: #67777b;
--imo-line: #e2e7e7;
--imo-green: #175f57;
--imo-gold: #dfc994;
--imo-surface: #f6f8f8;
--imo-ink: #253931;
```

**Colors**: `#0001`; `#0002`; `#0003`; `#0005`; `#001a171c`; `#001d2730`; `#08161696`; `#10201e75`; `#10242577`; `#102821c7`; `#104e47`; `#12251db0`; `#122627ab`; `#12292380`; `#122923b3`; `#15282270`; `#162223`; `#172d2ade`; `#172e2999`; `#175f57`; `#18302b70`; `#1939310c`; `#1a3533`; `#1a6b50`; `#1b392c`; `#1c332fcc`; `#1d6350`; `#1d7b66`; `#1e3533`; `#202c30`; `#216044`; `#223b35`; `#226347`; `#22634b`; `#236247`; `#243d31`; `#244d4299`; `#246547`; `#253931`; `#253b3b`; `#263c3012`; `#263d31`; `#27332b`; `#276a4b`; `#294d36`; `#2b7250`; `#325f49`; `#344c3d`; `#344d45`; `#354747`; `#36634a`; `#38654d`; `#3ba28b`; `#3c4d4b`; `#41644e`; `#475653`; `#4c7961`; `#526a5d`; `#536c63`; `#537e61`; `#557760`; `#637c78`; `#638674`; `#65816d`; `#67777b`; `#6b7a79`; `#71857b`; `#72837e`; `#768785`; `#773e31`; `#7a898c`; `#7a8c7d`; `#7c9185`; `#7c9284`; `#80938a`; `#809589`; `#82948b`; `#83948a`; `#84948e`; `#859194`; `#85958c`; `#87938e`; `#87958d`; `#8a9691`; `#8a9991`; `#8b999d`; `#8b9b91`; `#8b9e95`; `#8c989c`; `#8c9992`; `#8c9a9a`; `#8e9b94`; `#8eb79e`; `#92afa955`; `#96a79e`; `#9f4736`; `#9f8953`; `#a0aaa4`; `#a1aca6`; `#a5b6b0`; `#ac4438`; `#b39b63`; `#bdcfc4`; `#bdd0c3`; `#c5d8cc`; `#c7ddd0`; `#cee5d7`; `#d2af5f`; `#d4dfdc`; `#d6bd80`; `#d6c592`; `#d6dfdd`; `#d8e2dc`; `#dae5e0`; `#dbe4de`; `#dbe6df`; `#dcc58d`; `#dce6dd`; `#dce7e2`; `#deaf54`; `#dfc994`; `#dfe8e1`; `#e0c891`; `#e2e7e7`; `#e2ebe5`; `#e2ebe8`; `#e3cb92`; `#e3d09a`; `#e3eae5`; `#e3ebe5`; `#e3ece6`; `#e5f2ec`; `#e6ece7`; `#e8eee9`; `#e9f2ec`; `#e9f4ed`; `#eaf0ed`; `#eaf1ee`; `#edf0ee`; `#edf2f1`; `#edf3f1`; `#edf4f2`; `#edf9ef`; `#eef5f0`; `#f0d8d1`; `#f0f5f1`; `#f1dbaa`; `#f4f6f3`; `#f5f7f3ed`; `#f6f8f8`; `#f7faf8`; `#fbfcfb`; `#fcfdfc`; `#fdf0ed`; `#fff`; `#fff9`; `#fffd`; `#ffffff12`; `#ffffff21`; `#ffffff25`; `#ffffff2e`; `#ffffff30`; `#ffffff38`; `#ffffff3b`; `#ffffff65`; `#ffffff8a`; `#ffffff9e`; `#ffffffac`; `#ffffffdf`; `#ffffffeb`; `#ffffffec`; `rgba(255,255,255,.8)`.

**Fonts**: `'Space Grotesk',Arial,sans-serif`; `Arial,sans-serif`; `serif`; `var(--f-ar),Arial,sans-serif`.

**Font sizes**: `0`; `10px`; `10px!important`; `11px`; `11px!important`; `12px`; `13px`; `14px`; `15px`; `16px`; `17px`; `19px`; `20px`; `22px`; `23px`; `24px`; `25px`; `27px`; `28px`; `29px`; `30px`; `32px`; `33px`; `6px`; `7px`; `8px`; `9px`.

**Line heights**: `1.1`; `1.3`; `1.45`; `1.55`; `1.6`; `1.7`; `1.8`; `1.9`; `20px`.

**Spacing (padding/margin/gap)**: `-2px auto 5px`; `0`; `0 0 35px`; `0 11px`; `0 13px 15px`; `0 15px`; `0 20px`; `0 22px 25px`; `0 2px`; `0 30px`; `0 42px`; `0 5px`; `0 65px`; `0 6px`; `0 7px`; `0 8px`; `0 auto`; `0 auto 15px`; `10px`; `10px 12px`; `10px 12px 0`; `10px 13px`; `10px 14px`; `10px 18px`; `10px 8px`; `10px 9px 3px`; `11px`; `11px 12px`; `120px`; `12px`; `12px 0`; `12px 0 24px`; `12px 18px`; `12px 20px`; `13px`; `13px 12px`; `13px 18px`; `13px 20px`; `13px 4px`; `14px`; `15px`; `15px 0`; `15px 20px 0`; `16px`; `16px 0 8px`; `16px 11px`; `17px`; `17px 20px`; `18px`; `19px`; `19px 0 16px`; `1px 0`; `1px 7px`; `20px`; `20px 0 10px`; `20px 42px 0`; `21px`; `21px 23px`; `22px`; `22px 8px 0`; `23px`; `23px 20px`; `24px`; `25px`; `26px`; `26px 20px`; `27px`; `28px`; `28px 11px`; `29px 35px`; `2px`; `30px`; `30px 12px`; `30px 5px`; `32px`; `35px 20px 24px`; `36px`; `38px`; `3px`; `3px 10px`; `3px 12px 12px`; `3px 18px`; `3px 2px`; `3px 9px`; `40px`; `42px`; `4px`; `50px`; `50px 65px`; `54px 14px 12px`; `5px`; `5px 5px 30px`; `5px 8px`; `65px 28px`; `6px`; `6px 0`; `6px 11px`; `6px 12px`; `7px`; `8px`; `8px 0 22px`; `8px 11px`; `8px 12px`; `8px 13px`; `9px`; `auto`.

**Radii**: `10px`; `11px`; `12px`; `16px`; `17px`; `4px`; `50%`; `5px`; `6px`; `7px`; `8px`; `9px`.

**Shadows**: `0 10px 30px #1939310c`; `0 1px 6px #0005`; `0 20px 100px #0003`; `0 20px 70px #263c3012`; `0 2px 10px #0001`; `0 3px 20px #001a171c`; `0 5px 25px #0002`; `none`.

**Responsive conditions**: `(max-height:560px)`; `(max-width:1200px)`; `(max-width:600px)`; `(max-width:900px)`; `(min-width:1600px)`; `(prefers-reduced-motion:reduce)`.


### `src/components/imo3d/apartment-plan-editor.css`

**Colors**: `#24634b`; `#309a76`; `#647d70`; `#71867b`; `#dbcaa5`; `#dce5df`; `#e4f4ed`; `#f7faf8`; `#faf5e9`; `#fff`.

**Font sizes**: `11px`; `12px`.

**Spacing (padding/margin/gap)**: `0`; `0 0 10px`; `10px`; `12px`; `14px`; `16px 0`; `20px`; `4px`; `6px`; `8px`; `auto`.

**Radii**: `10px`; `14px`; `6px`.

**Responsive conditions**: `(max-width:700px)`.


### `src/components/imo3d/architectural-editor.css`

**Colors**: `#243946`; `#263c43`; `#a93636`; `#ccd7d8`; `#ced8dd`; `#d5dfe5`; `#d6dfe1`; `#e1e8eb`; `#fff`.

**Font sizes**: `12px`.

**Spacing (padding/margin/gap)**: `0`; `10px`; `12px 0`; `18px`; `3px 6px`; `5px`; `6px`; `8px`; `8px 0`; `8px 10px`.

**Radii**: `14px`; `6px`; `8px`.

**Responsive conditions**: `(max-width:760px)`.


### `src/components/imo3d/architectural-plan.css`

**Colors**: `#152c4426`; `#174e68`; `#227ca7`; `#28333f`; `#485563`; `#74808b`; `#78838e`; `#aac4d1`; `#dce2e8`; `#e4e8ed`; `#e8dba9`; `#eaf3f7`; `#eef2f5`; `#fff`; `#fffdf0e8`; `rgba(148,163,184,.24)`; `rgba(250,251,252,.96)`; `rgba(255,255,255,.88)`.

**Fonts**: `Arial,sans-serif`.

**Font sizes**: `10px`; `11px`; `12px`; `13px`; `15px`; `17px`.

**Line heights**: `1.7`; `1.9`.

**Spacing (padding/margin/gap)**: `10px`; `10px 16px`; `12px`; `14px`; `16px 20px`; `40px 25px`; `5px`; `6px`; `8px 10px`; `8px 12px`; `9px`; `auto`.

**Radii**: `12px`; `16px`; `8px`.

**Shadows**: `0 12px 35px #152c4426`.

**Responsive conditions**: `(max-width:600px)`.


### `src/components/imo3d/brand-logo.css`

**Colors**: `#0004`.

**Font sizes**: `12px`; `18px`.

**Line heights**: `1.4`.

**Spacing (padding/margin/gap)**: `0!important`; `14px`; `8px`.

**Radii**: `0!important`.

**Shadows**: `none!important`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/branding.css`

**Colors**: `#0002`; `#1a241f`; `#27382f`; `#6b776e`; `#738078`; `#76837e`; `#86948e`; `#985047`; `#d6dfd9`; `#e3e8e5`; `#e4e9e7`; `#f0f2f1`; `#fafcfb`; `#fff`; `#ffffff02`; `#ffffff09`; `#ffffff0d`.

**Fonts**: `monospace`.

**Font sizes**: `11px`; `12px`; `13px`; `14px`; `19px`.

**Line heights**: `1.7`; `1.85`.

**Spacing (padding/margin/gap)**: `0`; `10px`; `10px 12px`; `12px`; `14px`; `18px`; `20px`; `28px`; `3px`; `4px`; `6px`; `8px`; `9px`; `auto`.

**Radii**: `12px`; `14px`; `7px`; `8px`.

**Shadows**: `0 3px 14px #0002`.

**Responsive conditions**: `(max-width:500px)`.


### `src/components/imo3d/compact-apartment-map.css`

**Colors**: `#0003`; `#226850`; `#385347`; `#7a8274`; `#e5eae6`; `#f9faf8f5`; `#fff`; `#ffffff36`.

**Font sizes**: `10px`; `11px`; `12px`.

**Line heights**: `1.65`.

**Spacing (padding/margin/gap)**: `10px`; `3px`; `4px`; `7px`; `9px`; `9px 7px`; `auto`.

**Radii**: `0`; `15px`; `8px`.

**Shadows**: `0 12px 40px #0003`; `none`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/floorplan-export-controls.css`

**Colors**: `#193b2724`; `#289879`; `#2b6d53`; `#2b6d5330`; `#395e49`; `#415d4e`; `#44221917`; `#6caa8c`; `#788777`; `#924b3d`; `#d8e4dc`; `#d9e5dc`; `#e4c6c0`; `#edf1ed`; `#eff7f1`; `#f3faf5`; `#fff`; `#fff5f2`.

**Font sizes**: `10px`; `11px`; `12px`.

**Line heights**: `1.7`.

**Spacing (padding/margin/gap)**: `0`; `10px`; `10px 12px`; `5px`; `7px`; `7px 5px 9px`; `8px`; `8px 12px`; `8px 5px 4px`; `9px`.

**Radii**: `11px`; `50%`; `6px`; `7px`; `8px`.

**Shadows**: `0 10px 30px #193b2724`; `0 6px 18px #44221917`.

**Responsive conditions**: `(max-width:600px)`; `(prefers-reduced-motion:reduce)`.


### `src/components/imo3d/floorplan.css`

**Colors**: `#00000018`; `#218365`; `#23795f`; `#258264`; `#2baa82`; `#2baa821c`; `#37463d`; `#3e4651`; `#46505d`; `#526253`; `#54715f`; `#586170`; `#61715e`; `#6e7886`; `#788574`; `#7d8894`; `#87919d`; `#a2d8c8`; `#ad8044`; `#d8dfd7`; `#d8e0e6`; `#e1e5e9`; `#e3e7ec`; `#e5e9ee`; `#e8ebef`; `#e9f7f1`; `#f0f3ec`; `#f0faf6`; `#f6f7f9`; `#f7f6ef`; `#f8f9fa`; `#f8f9facf`; `#f8f9faf2`; `#f9faf7`; `#f9fcf363`; `#fafbf8`; `#fff`; `#fffef9`; `#ffffff8f`; `#fffffff2`.

**Fonts**: `var(--f-ar),Arial,sans-serif`.

**Font sizes**: `10px`; `11px`; `12px`; `9px`.

**Line heights**: `1.6`; `1.8`.

**Spacing (padding/margin/gap)**: `0`; `0 14px 12px`; `0 auto 15px`; `10px`; `11px 14px`; `12px 15px`; `13px 10px`; `14px 20px`; `22px 26px`; `24px`; `4px`; `5px 7px`; `6px`; `7px`; `7px 9px`; `8px`; `8px 10px`; `8px 14px 12px`; `8px 15px`; `9px 11px`; `auto`.

**Radii**: `12px`; `14px`; `50%`; `7px`.

**Shadows**: `0 0 0 3px #2baa821c`; `0 8px 30px #00000018`.

**Responsive conditions**: `(max-width:600px)`.


### `src/components/imo3d/floorplan3d.css`

**Colors**: `#17895c`; `#1b2a2399`; `#209869`; `#263c2810`; `#27462f0a`; `#27462f0b`; `#278260`; `#27ab7f`; `#27ab7f14`; `#285e48`; `#288153`; `#2f46320c`; `#344c40`; `#3d8057`; `#409c6a`; `#45644f`; `#4b6553`; `#4c6856`; `#57746255`; `#587363`; `#61715e`; `#637c6a`; `#657861`; `#6a7c69`; `#6d7f71`; `#6d9684`; `#6f8173`; `#788570`; `#788574`; `#799181`; `#7a8c7e`; `#7bb795`; `#829080`; `#87938a`; `#8a968b`; `#8b978d`; `#96a091`; `#a2aa9d`; `#b4beb1`; `#b99458`; `#c6ac82`; `#c8e5d2`; `#d6e3d8`; `#d8e5de`; `#dce6df`; `#dfe7df`; `#dfe8df`; `#e4e9e3`; `#e4eae2`; `#e4eae3`; `#e5ece5`; `#e5ede7`; `#e6ece6`; `#e7f4ec`; `#e8eee8`; `#e8eee9`; `#e9eee7`; `#e9f4ed`; `#edf7f0`; `#eef8f1`; `#eff4f0`; `#f0f5f0d9`; `#f2f5f0f2`; `#f4f7f4`; `#f9fbf5c9`; `#f9fbf8`; `#fafbf8`; `#fbfcf9`; `#fcfcf7`; `#fcfdfb`; `#fff`; `#ffffffe3`; `#fffffff0`; `#fffffff2`.

**Font sizes**: `10px`; `11px`; `12px`; `13px`; `14px`; `18px`; `23px`; `9px`.

**Line heights**: `1`; `1.5`; `1.6`; `1.8`; `1.9`.

**Spacing (padding/margin/gap)**: `0`; `0 19px 10px`; `0 19px 15px`; `10px`; `10px 12px`; `11px`; `12px`; `12px 17px`; `13px`; `16px 20px`; `2px`; `2px 4px`; `35px`; `3px`; `3px 0 0`; `4px`; `4px 10px`; `4px 17px 13px`; `5px`; `5px 0`; `6px`; `6px 9px`; `7px`; `7px 10px`; `7px 11px`; `8px`; `8px 10px`; `8px 13px`; `8px 14px`; `8px 15px`; `8px 16px`; `9px 12px`; `auto`.

**Radii**: `11px`; `16px`; `1px`; `20px`; `22px`; `50%`; `6px`; `7px`; `8px`; `9px`.

**Shadows**: `0 0 0 3px #27ab7f14`; `0 1px 5px #263c2810`; `0 3px 16px #27462f0a`; `0 6px 20px #27462f0b`; `0 8px 24px #2f46320c`.

**Responsive conditions**: `(max-width:700px)`.


### `src/components/imo3d/hotspots.css`

**Colors**: `#0004`; `#0005`; `#122922`; `#14392ce0`; `#18302b`; `#197860`; `#1d6655`; `#206b4933`; `#285a49`; `#286251`; `#6b8177`; `#943d30`; `#dce7e1`; `#e5eee9`.

**Font sizes**: `11px`; `12px`.

**Spacing (padding/margin/gap)**: `10px 12px`; `12px`; `14px`; `15px`; `15px 0`; `16px 0`; `18px`; `18px 0`; `20px`; `5px`; `7px`; `8px`.

**Radii**: `10px`; `14px`; `16px`; `50%`; `8px`.

**Shadows**: `0 1px 3px black`; `0 2px 12px #0004`; `0 4px 18px #0005`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/integration-keys.css`

**Colors**: `#216548`; `#2b513d`; `#2f7150`; `#326b4d`; `#336849`; `#526a5d`; `#6c8475`; `#6d8173`; `#728778`; `#8b9b90`; `#8c9c91`; `#a0aba3`; `#bcdcc9`; `#d4e5da`; `#e0e9e3`; `#e4eae6`; `#f0f8f3`; `#f3f7f4`; `#f7f9f8`; `#fafcfb`; `#fff`.

**Fonts**: `monospace`.

**Font sizes**: `10px`; `11px`; `12px`; `13px`; `14px`; `15px`.

**Line heights**: `1.8`; `1.9`.

**Spacing (padding/margin/gap)**: `0`; `0 0 20px`; `10px`; `10px 20px`; `12px`; `12px 0`; `14px`; `14px 0!important`; `14px 16px`; `15px`; `18px`; `20px`; `22px`; `24px`; `28px 0 13px`; `5px`; `5px 0 12px`; `6px 11px`; `7px 12px`; `8px`.

**Radii**: `11px`; `6px`; `7px`; `9px`.

**Responsive conditions**: `(max-width:600px)`.


### `src/components/imo3d/interactive-floorplan.css`

**Colors**: `#254b3214`; `#284b39`; `#286b50`; `#289879`; `#2b6d53`; `#586f60`; `#5f7669`; `#638271`; `#d8e4dc`; `#dee8e1`; `#f2f7f4`; `#f4f8f5`; `#fff`.

**Fonts**: `Arial,sans-serif`.

**Font sizes**: `10px`; `11px`; `12px`; `13px`; `14px`; `20px`.

**Line heights**: `1.9`.

**Spacing (padding/margin/gap)**: `0`; `12px`; `14px`; `15px`; `16px`; `32px`; `3px`; `4px`; `7px`; `8px`; `8px 10px`; `8px 12px`; `8px 7px`.

**Radii**: `10px`; `12px`; `7px`.

**Shadows**: `0 1px 5px #254b3214`.

**Responsive conditions**: `(max-width:600px)`; `(max-width:720px)`.


### `src/components/imo3d/liquid-glass.css`

Custom properties (including contextual overrides, in source order):

```css
--imo-line: #dae4e2;
--imo-ink: #183532;
```

**Colors**: `#0001`; `#071e2342`; `#081d2426`; `#091c3540`; `#102b29b8`; `#154c40`; `#163b320a`; `#163b3217`; `#16594f`; `#165d4c`; `#173c3306`; `#18332f`; `#18332fed`; `#183532`; `#195c4820`; `#1c473a`; `#23735c`; `#28776a`; `#2c4439`; `#303d36`; `#33564de8`; `#49645b70`; `#546a66`; `#56665f`; `#afcbc2`; `#d3eee229`; `#d3eee299`; `#d5e2dd`; `#dae4e2`; `#dce4dd`; `#deece6`; `#dfece9`; `#e8eeeb`; `#e9f2ee`; `#eeeadf`; `#f0f2ec`; `#f3f6f5`; `#f3f8f59c`; `#f7f6f0`; `#f7faf2e6`; `#f7faf8`; `#f7faf8f0`; `#f9fbfa`; `#fafcfb`; `#fbfdfc`; `#fff`; `#fff9`; `#ffffff29`; `#ffffff38`; `#ffffff80`; `#ffffffa8`; `#ffffffad`; `#ffffffb8`; `#ffffffc9`; `#ffffffd9`; `#ffffffe8`.

**Font sizes**: `11px`; `12px`.

**Spacing (padding/margin/gap)**: `10px`; `10px 16px`; `12px`; `12px 16px`; `16px`; `18px`; `22px`; `3px`; `4px`; `5px`; `8px`; `8px 10px`; `auto`.

**Radii**: `10px`; `11px`; `12px`; `13px`; `14px`; `15px`; `16px`; `17px`; `20px`; `22px`; `24px`; `50%`.

**Shadows**: `0 14px 36px #163b3217`; `0 28px 100px #091c3540, inset 0 1px 0 #fff`; `0 2px 6px #0001`; `0 4px 12px #195c4820, inset 0 1px 0 #ffffff38`; `0 8px 30px #163b320a`; `0 8px 32px #173c3306, inset 0 1px 0 #fff`; `inset 0 0 0 1px #d3eee229, 0 6px 24px #081d2426`; `inset 0 1px 0 #fff9`; `inset 0 1px 0 #ffffff29, 0 6px 24px #081d2426`.

**Responsive conditions**: `(max-width:720px)`; `(prefers-reduced-motion:reduce)`; `(prefers-reduced-transparency:reduce)`.


### `src/components/imo3d/manual-links.css`

**Colors**: `#000`; `#0008`; `#11241f88`; `#17241f`; `#17241fe8`; `#24372f`; `#35a27c`; `#3b5d4e`; `#65716e`; `#65a687`; `#68756d`; `#718079`; `#728078`; `#729083`; `#738078`; `#75b49a`; `#796432`; `#7b8a82`; `#dce4e0`; `#e0e6e2`; `#e5ebe7`; `#ecdcb6`; `#f0f8f4`; `#fff`; `#fff8e9`.

**Font sizes**: `10px`; `11px`; `12px`; `13px`; `15px`; `20px`; `24px`.

**Line heights**: `1.7`; `1.8`.

**Spacing (padding/margin/gap)**: `0`; `0 0 13px`; `10px`; `10px 0`; `12px`; `16px`; `18px`; `20px`; `22px`; `24px`; `28px`; `3px`; `3px 3px 12px`; `4px`; `6px`; `6px 8px`; `7px`; `8px`; `8px 0`; `9px`.

**Radii**: `10px`; `14px`; `2px`; `5px`; `7px`; `8px`; `9px`.

**Shadows**: `0 1px 5px #000`.

**Responsive conditions**: `(max-width:850px)`.


### `src/components/imo3d/measurement-scale-panel.css`

**Colors**: `#173e32`; `#216044`; `#365449`; `#c9d9d0`; `#f8fbf9`.

**Font sizes**: `12px`.

**Line heights**: `1.8`.

**Spacing (padding/margin/gap)**: `12px 0`; `6px`; `8px`; `9px 11px`.

**Radii**: `7px`.


### `src/components/imo3d/measurement.css`

**Colors**: `#177257`; `#1c7255`; `#233e2910`; `#2baa82`; `#304c40`; `#334d3e`; `#65796b`; `#688070`; `#6c8070`; `#728779`; `#758277`; `#816b40`; `#849087`; `#859187`; `#919c92`; `#a57a3b`; `#bda77c`; `#e1e8e3`; `#e4ece5`; `#e5ebe5`; `#e6dcc8`; `#edf1ed`; `#eff4ef`; `#f0f4f1`; `#f8f5ed`; `#fbfcfa`; `#fff`; `#fffffff0`.

**Font sizes**: `10px`; `11px`; `12px`; `16px`; `23px`; `28px`.

**Line heights**: `1.8`.

**Spacing (padding/margin/gap)**: `0`; `10px 12px`; `12px`; `14px`; `14px 0 10px`; `14px 0 5px`; `15px`; `18px`; `18px 0 13px`; `4px`; `5px`; `5px 14px`; `6px`; `6px 10px`; `7px`; `8px`; `8px 10px`; `9px 13px`.

**Radii**: `10px`; `13px`; `20px`; `7px`.

**Shadows**: `0 2px 7px #233e2910`.

**Responsive conditions**: `(max-width:600px)`; `(max-width:720px)`.


### `src/components/imo3d/panorama-measurement.css`

**Colors**: `#0003`; `#020f0a66`; `#123326`; `#8ceac0`; `#91e0bc`; `#9fb4a8`; `#a6baaf`; `#a6bfb0`; `#aac1b3`; `#acffdb`; `#adcebf`; `#aecab833`; `#b5dcc7`; `#b6cbbf`; `#bccec4`; `#c3d5cc`; `#c5ffe5`; `#c9ddcf`; `#eef7f3`; `#f4d09a`; `#ffccaa`; `#fff`; `#ffffff09`; `#ffffff0e`; `#ffffff12`; `#ffffff19`; `#ffffff25`; `#ffffff30`; `rgba(15,33,28,.94)`.

**Font sizes**: `10px`; `11px`; `12px`; `14px`; `16px`; `25px`; `28px`; `9px`.

**Line heights**: `1.5`; `1.7`.

**Spacing (padding/margin/gap)**: `0`; `10px`; `10px 0`; `12px`; `12px 14px`; `16px 18px`; `1px 8px`; `4px`; `5px`; `6px`; `6px 10px`; `8px`; `8px 0 0`; `8px 10px`; `9px`.

**Radii**: `10px`; `12px`; `16px`; `8px`.

**Shadows**: `0 15px 55px #0003`.

**Responsive conditions**: `(max-height:520px) and (orientation:landscape)`; `(max-width:720px)`.


### `src/components/imo3d/password-input.css`

**Colors**: `#25836c`; `#42685b`; `#42685b12`.

**Spacing (padding/margin/gap)**: `0`; `52px`.

**Radii**: `8px`.


### `src/components/imo3d/project-usage.css`

**Colors**: `#296246`; `#2b4738`; `#388469`; `#395440`; `#3aa27b`; `#3b5a45`; `#4d753f`; `#60937b`; `#637c5d`; `#65816b`; `#687d6e`; `#6f8274`; `#79906b`; `#7c8e7e`; `#7f9183`; `#849389`; `#86977f`; `#869a8a`; `#87958c`; `#8b988c`; `#90a092`; `#92a094`; `#94a197`; `#98a492`; `#9eab9f`; `#a0805b`; `#a0aa9b`; `#a76d5e`; `#b1bdb1`; `#dfe8df`; `#e0e8d8`; `#e3eae1`; `#e6ede6`; `#e8eee8`; `#f0f7f2`; `#f5f7f4`; `#f5f8f5`; `#f7f8f3`; `#fcf4f1`; `#fff`.

**Font sizes**: `10px`; `11px`; `12px`; `15px`; `18px`; `19px`; `21px`; `22px`; `25px`; `28px`; `9px`.

**Line heights**: `1.8`; `1.9`.

**Spacing (padding/margin/gap)**: `0`; `0 0 20px`; `0 0 6px`; `10px`; `11px 12px`; `12px`; `12px 0 18px`; `12px 0 6px`; `12px 14px`; `13px`; `13px 0`; `14px`; `15px 0`; `16px`; `16px 18px`; `17px`; `19px`; `22px 0 14px`; `2px`; `4px 9px`; `5px 0`; `60px 15px`; `6px`; `6px 0`; `6px 9px`; `7px`; `8px`; `9px`.

**Radii**: `11px`; `12px`; `5px`; `7px`.

**Responsive conditions**: `(max-width:600px)`.


### `src/components/imo3d/room-entry-view.css`

**Colors**: `#000`; `#18352f`.

**Font sizes**: `32px`.

**Spacing (padding/margin/gap)**: `0`; `16px`; `18px`; `24px`.

**Radii**: `18px`.

**Shadows**: `0 1px 5px #000`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/room-functions.css`

**Colors**: `#286b55`; `#3d5b4e`; `#bb9a50`; `#d6dfd8`; `#d9e2dc`; `#f5f8f5`.

**Font sizes**: `11px`; `12px`.

**Spacing (padding/margin/gap)**: `0 0 18px`; `12px`; `14px`; `6px`; `7px`; `7px 10px`; `8px`; `8px 13px`.

**Radii**: `10px`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/semantic-rooms-editor.css`

**Colors**: `#536a5e`; `#77877e`; `#dde8e1`; `#e0e8e3`; `#f8fbf9`.

**Font sizes**: `11px`; `12px`; `15px`; `16px`; `17px`.

**Line heights**: `1.6`.

**Spacing (padding/margin/gap)**: `0 0 6px`; `12px`; `15px`; `16px`; `22px`; `26px`; `7px`; `auto`.

**Radii**: `12px`.

**Responsive conditions**: `(max-width:480px)`.


### `src/components/imo3d/studio-workflows.css`

**Colors**: `#0002`; `#101815`; `#1e694e`; `#245f4a`; `#254b3d`; `#27634b`; `#2d4840`; `#2f7851`; `#315943`; `#327254`; `#3a9a6a`; `#3e7758`; `#459875`; `#506e61`; `#61796e`; `#643e38`; `#65786d`; `#6d8174`; `#788d7f`; `#7c8882`; `#806861`; `#827650`; `#86948e`; `#87652d`; `#8a672f`; `#8b584b`; `#8c703e`; `#8d7846`; `#8e2727`; `#8f6b33`; `#943e38`; `#94651b`; `#974a40`; `#9b665e`; `#a12525`; `#a13535`; `#a22f2f`; `#a34940`; `#a63730`; `#ac3434`; `#b9dcc9`; `#d4b576`; `#d8e2db`; `#dce5df`; `#dce6df`; `#dce9e1`; `#dfc99f`; `#dfe8e2`; `#dfe8e3`; `#e4d8ba`; `#e4eee8`; `#e5e9e6`; `#e5ece7`; `#e6f5ec`; `#e7c7c7`; `#eadbd7`; `#ebd9d3`; `#eddfc4`; `#edf8f2`; `#efd7d2`; `#f4eee0`; `#f5fbf7`; `#f7f9f8`; `#f8faf9`; `#f9fcfa`; `#fafcfb`; `#fcf8ef`; `#fcf9f0`; `#fff`; `#fff1ed`; `#fff5f3`; `#fff8f6`; `#fff9f7`; `#fffaf0`; `#ffffffed`.

**Fonts**: `Arial,sans-serif`.

**Font sizes**: `10px`; `11px`; `12px`; `12px!important`; `13px`; `14px`; `15px`; `16px!important`; `18px`; `19px`; `20px`; `22px`.

**Line heights**: `1.6`; `1.8`; `1.85`.

**Spacing (padding/margin/gap)**: `0`; `0 0 14px`; `0 0 20px`; `0 0 22px`; `0 0 5px`; `0 10px`; `0 17px 0 0`; `10px`; `10px 0`; `12px`; `12px 0 0`; `12px 14px`; `12px 16px`; `13px`; `13px 16px`; `14px`; `15px`; `15px 0 0`; `16px`; `16px 0 0`; `16px 12px`; `18px`; `20px`; `21px`; `21px 24px`; `22px`; `24px`; `30px`; `3px`; `4px`; `5px`; `5px 0`; `5px 10px`; `6px`; `6px 10px`; `6px 12px`; `6px 9px!important`; `7px 12px`; `8px`; `8px 0`; `9px`; `9px 10px`; `auto`.

**Radii**: `10px`; `12px`; `20px`; `6px`; `6px!important`; `7px`; `8px`; `99px`; `9px`.

**Shadows**: `0 2px 8px #0002`.

**Responsive conditions**: `(max-width:1100px)`; `(max-width:600px)`; `(max-width:720px)`.


### `src/components/imo3d/viewer-clean.css`

**Colors**: `#0002`; `#0003`; `#0005`; `#0008`; `#14211fbc`; `#14231eed`; `#14231ef0`; `#142921ba`; `#14362c70`; `#14362c75`; `#15221fdc`; `#15221ff2`; `#173d31`; `#284b39`; `#315f50`; `#90a99d`; `#dbe9df`; `#dceae1`; `#e6eee980`; `#e8efe980`; `#f5faf5`; `#ffbdb5`; `#ffcf52`; `#ffdd83`; `#ffe0a5`; `#ffffff0d`; `#ffffff19`; `#ffffff20`; `#ffffff24`; `#ffffff25`; `#ffffff26`; `#ffffff55`; `#ffffff70`.

**Font sizes**: `0`; `10px`; `11px`; `12px`; `13px`; `14px`; `16px`; `20px`; `9px`.

**Line heights**: `1.6`; `12px`.

**Spacing (padding/margin/gap)**: `0`; `0!important`; `10px`; `10px 12px`; `10px 14px`; `12px`; `4px`; `5px`; `5px 10px`; `5px 12px`; `6px`; `6px 10px`; `8px`; `8px 10px`.

**Radii**: `0`; `10px`; `12px`; `14px`; `20px`; `50%`; `7px`; `8px`; `9px`.

**Shadows**: `0 1px 5px #0008`; `0 2px 8px #0003`; `0 6px 24px #0002`; `0 8px 28px #0002`; `none`; `none!important`.

**Responsive conditions**: `(max-height:520px)`; `(max-width:380px)`; `(max-width:720px)`.


### `src/components/imo3d/viewer-floorplan.css`

**Colors**: `#284b39`; `#607469`; `#dce6df`; `#fff`; `#ffffff26`.

**Font sizes**: `12px`; `13px`; `22px`.

**Line heights**: `1.7`.

**Spacing (padding/margin/gap)**: `0`; `0 auto`; `12px`; `5px`; `6px`; `8px`; `8px 12px`.

**Radii**: `12px`; `50%`; `9px`.

**Responsive conditions**: `(max-width:720px)`.


### `src/components/imo3d/viewer-mobile.css`

Custom properties (including contextual overrides, in source order):

```css
--controls-hidden: is(.imo-view-header,.imo-location,.imo-view-footer,.imo-mobile-dock,.imo-view-help,.imo-minimap,.imo-vignette);
--controls-hidden: is(.imo-view-header,.imo-view-footer,.imo-mobile-dock,.imo-minimap) *;
```

**Colors**: `#0002`; `#071b1545`; `#09231b24`; `#15261a35`; `#16322b25`; `#376b5d`; `#3e806b`; `#52674e`; `#788680`; `#83938c`; `#bb9a50`; `#d6dfd9`; `#e8d5a5`; `#eaf2e73d`; `#eef5f1`; `#f5f9efc2`; `#f5f9efcc`; `#f6faf1ad`; `#f7faf0c4`; `#f9fcf1b8`; `#f9fcf363`; `#ffffff52`; `#ffffff68`; `#ffffff73`; `#ffffffa8`; `#ffffffb0`.

**Font sizes**: `11px`; `12px`; `12px!important`; `13px`; `14px`; `16px`; `18px`; `24px`; `6px`.

**Line heights**: `1.5`; `1.6`; `1.7`; `1.8`.

**Spacing (padding/margin/gap)**: `0`; `0 auto`; `10px`; `10px 12px`; `10px 14px`; `11px 15px`; `12px`; `12px 14px 14px`; `13px`; `14px`; `15px`; `18px`; `3px`; `4px`; `5px`; `6px`; `7px`; `8px`; `8px 10px`; `8px 12px`; `8px 16px`; `9px`; `9px 10px`; `calc(12px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 8px max(16px,env(safe-area-inset-left,0px))`.

**Radii**: `11px`; `12px`; `13px`; `14px`; `20px`; `50%`.

**Shadows**: `0 10px 32px #09231b24`; `0 1px 4px #16322b25`; `0 24px 90px #071b1545`; `0 4px 20px #0002`; `0 4px 24px #0002`.

**Responsive conditions**: `(max-width:380px)`; `(max-width:720px)`; `(prefers-reduced-motion:reduce)`.


### `src/components/imo3d/viewer-presentation.css`

**Colors**: `#001c2526`; `#071d18`; `#071d1890`; `#10241f`; `#12372dde`; `#142c3266`; `#176957`; `#aaf4dc`; `#fff`; `#ffffff1f`; `#ffffff36`.

**Font sizes**: `10px`; `11px`; `11px!important`; `12px`; `13px`; `14px`; `15px`.

**Line heights**: `1.6`.

**Spacing (padding/margin/gap)**: `0`; `0 4px`; `0 8px`; `10px`; `10px!important`; `12px`; `2px`; `4px`; `4px 0`; `5px!important`; `6px`; `8px`; `auto`.

**Radii**: `0`; `12px`; `14px!important`; `18px!important`; `24px!important`; `50%`.

**Shadows**: `0 1px 3px #071d18,0 0 9px #071d1890`; `0 1px 4px #10241f`; `0 8px 32px #001c2526!important`; `none!important`.

**Responsive conditions**: `(max-height:480px)`; `(max-width:720px)`.
