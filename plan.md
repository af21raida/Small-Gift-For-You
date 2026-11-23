# Plan — Interactive Digital Letter & Vinyl Gift

## Status
This repo currently contains a **front-end prototype only** (`index.html`), built in a
sandboxed chat environment with no network access and no persistent server. It proves out
the core interaction design. It is not the production system described below — that needs
a real repo, package manager, database, and deploy target (Claude Code, not this chat).

## Status (updated 2026-11-04) — production architecture

> The paragraph above ("front-end prototype only") is kept for history. It is **superseded**: the project is now a
> built static site + Netlify Functions + Supabase. **Code is complete and tested locally; the live Supabase/Netlify
> setup has not been performed or verified yet** (see "Remaining setup steps").

### Architecture
```
src/ (index.html template, css/app.css, js/app.js, img/ optimized variants, audio/, fonts/)
   |  node scripts/build.mjs  (fingerprints assets -> dist/assets/*.<hash>.ext, expands <picture> macros,
   v                            emits index.html (pre-rendered home, LCP image in HTML) + g.html + 404.html)
dist/  --- Netlify CDN ---  /assets/* immutable 1y, HTML must-revalidate, /g/* -> g.html (noindex)
   |
   +-- /api/*  Netlify Functions (netlify/functions/*.mjs, shared code in netlify/lib/)
          POST /api/photos       raw image -> validated (magic bytes, <=1.5 MB) -> private bucket `gift-photos`
          POST /api/gifts        validated gift -> CSPRNG 20-char code -> Postgres (idempotent)
          GET  /api/gifts/:code  gift JSON + 1-hour signed photo URLs
          DELETE /api/gifts/:code  requires Bearer manage key; wipes content, keeps tombstone
          cleanup (scheduled daily)  purge unattached uploads > 24 h
          |
          v  service-role key (Netlify env only)
       Supabase: Postgres (tables gifts/photos/rate_limits, RLS forced + zero policies, SECURITY DEFINER RPCs)
                 Storage (private bucket)
```
Browser <-> Supabase direct access does not exist: no anon key is shipped; every table is closed to `anon`/`authenticated`.

### Backend / storage decisions
* **Supabase via plain `fetch`** (PostgREST RPC + Storage REST) — no `supabase-js` dependency, nothing to bundle.
* **All DB access through SQL functions** (`create_gift`, `get_gift`, `delete_gift`, `register_photo`, `rate_limit_hit`,
  `purge_orphans`), executable by `service_role` only. Gift creation is one transaction.
* **Gift code:** 20 chars of Crockford base32 from `crypto.randomBytes` (100 bits, unbiased `byte & 31`), generated
  server-side; unique constraint + automatic retry on collision; never overwrites. Replaces the old 6-char `Math.random()` code.
* **Authorization:** share link = read-only bearer secret. No edit endpoint exists. Delete needs the creator's 256-bit
  manage key (client-generated, only its SHA-256 stored). A future account system can replace this without schema change.
* **Idempotent saves:** the client sends one idempotency key per payload; retries return the same code (no duplicate gifts);
  a key reused with a different manage key is rejected.
* **Photos:** resized/compressed in the browser (<=1024 px, WebP/JPEG, EXIF orientation applied), uploaded one by one
  (progress / retry / error states), stored privately, shown via signed URLs. Max 5. External https links are still
  supported (flagged `external`); trade-offs documented in docs/DEPLOYMENT.md.
* **Rate limiting:** Postgres fixed-window counters keyed by salted hash of the client IP (no raw IPs stored).
* **Songs:** 1-10 (MIN_SONGS=1, MAX_SONGS=10) enforced in UI, client validation, server validation and a DB CHECK.
  Home text now reads "add one to ten songs". Bundled MP3s are only fetched when needed (`preload=metadata` on the current track).

### Image optimization strategy
* Root cause of slow PNGs: the eleven original PNGs totalled **8.08 MB** (e.g. `frame.png` 1.46 MB drawn at 520 px,
  `cursor-2.png` 1.41 MB drawn at ~60 px, `corner-vine-left.png` 1.07 MB), no responsive sizes, no caching headers,
  and all decorative art requested up front.
* `npm run images` (sharp) renders each artwork at its real display widths (1x and ~2x) as **AVIF, WebP and PNG**; `<picture>`
  chooses AVIF -> WebP -> PNG. Originals remain in `originals/img/` (never deleted). Variant sizes: docs/image-report.json.
* Priorities: the title frame is `fetchpriority=high` and in the HTML; vines are `low`; cursor images, envelopes are warmed
  after `load` via idle callbacks (and only on pointer devices for the cursor cluster); the open-envelope image is preloaded
  before the user can click; photos beyond the first are `loading=lazy`; width/height attributes prevent layout shift.
* Cursor cluster: one rAF loop that sleeps when idle, when the tab is hidden, off the home screen, or when the pointer is over a
  button; `translate3d` transforms only; not created for touch devices or `prefers-reduced-motion`.

### Netlify configuration (`netlify.toml`)
Publish `dist`, functions `netlify/functions`; `/assets/*` immutable 1 year; HTML/`/` `max-age=0, must-revalidate`; `/g/*`
noindex; `/api/*` `no-store`; security headers (CSP without inline scripts, `Referrer-Policy: no-referrer` so secret share URLs do not leak,
HSTS, nosniff, frame-ancestors none). Netlify compresses text assets automatically.

### Completed
Image pipeline and build; Netlify config; frontend hardening (drafts, retry, double-submit guard, error states, adaptive letter paper,
responsive fixes incl. 561-914 px envelope overflow); Supabase schema; functions; dev server; 39 unit/integration tests; 69 browser checks;
before/after load measurements (docs/perf-report.json, docs/TEST-REPORT.md).

### Remaining setup steps (need your accounts) — see docs/DEPLOYMENT.md
1. Create Supabase project, run `supabase/schema.sql`. 2. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RATE_LIMIT_SALT` in Netlify.
3. Deploy and run the 12-point live checklist (cross-device open, signed URLs, delete, headers, Lighthouse on the real CDN).

### Known limitations
No creator accounts (lost manage key => delete via Supabase dashboard); share links are bearer secrets; external photo/audio links can vanish or
track; streaming-site URLs are not playable in `<audio>`; signed photo URLs expire after 1 h (auto-refetch); Celandine font not bundled
(licensed) so the serif fallback is used; the CSP allows `https:` images/audio because creators may paste external links; live-Supabase
behaviour (quotas, key formats) is untested; old prototype codes only work in the browser that created them.

## Product goal
Creator writes a letter, optionally attaches 1–5 postcard photos, and picks 1–10 songs →
gets a share code/link → recipient opens a closed envelope, watches it open, reads the
letter (with the postcard photo(s) if the creator added any), scrolls to a vinyl player,
and listens. Recipient never sees editor controls; editing is enforced server-side, not
just hidden by CSS.

## Core flows
- **Creator:** home → envelope (click) → letter (write, optionally attach 1–5 postcard
  photos) → scroll → vinyl (add 1–10 songs, reorder, remove) → save → unique share code/link.
- **Recipient:** open link/code → envelope (click) → letter (read-only; sees the postcard
  photo(s) only if the creator added any — nothing shown otherwise) → scroll → vinyl
  (play only).

## Prototype implementation (this repo)
Single-file `index.html`, vanilla JS, no build step.
- Envelope: picture-based (`envelope-closed.png` → click → `envelope-open.png` with fade,
  ~1.25s hold, then `unfold` to the letter). Hover is a 12px horizontal slide.
  Six decorative pictures (`cursor-1.png` … `cursor-6.png`) ring the envelope via a
  relatively positioned `.envelope-stage` (zero-size anchors, verified centered,
  sun/lady/rabbit offsets tuned for 100%-zoom windows).
- Letter: `letter-page.png` lace paper with a `.letter-writing` overlay (top 15% /
  sides 19% / bottom 8%, on the white inner area). Creator `<textarea>` is italic
  pink `#ac6b73` with a matching visible placeholder; the old "Your letter" label
  was removed (recipient "A letter for you" tag kept). No scroll cue; the continue
  button is the small variant (13px / 9px 20px + 18px top margin).
- Vinyl: picture-based disc (`vinyl-record.png` in the 220px slot on the
  plinth/tonearm recorder) with the existing audio-synced rotation reused as-is
  (`.spinning` 2.6s loop while playing, `.paused` otherwise, centered,
  `border-radius:50%` + `object-fit:cover`). Transport controls (prev/play/pause/next),
  seek bar bound to `audio.currentTime`/`duration`, volume, playlist with reorder/remove
  for the creator. The "A Letter For You" brand line was removed from this page's
  top bar (creator song counter kept, right-aligned).
- Background/theme: page background is `#fdedad` (`--bg`/`--paper`; `--paper-dark`
  `#dfd198`). Full-page floral scrollwork overlay (`.floral-overlay` tiling
  `floral-overlay.png` at 780px, opacity .30, non-interactive, below all content);
  the earlier CSS lace stack and the leftover `.app::before` dot grid are both removed.
  Corner vines (`corner-vine.png` / `corner-vine-left.png`, height `min(52vh,460px)`,
  32vh mobile, tilted ±20° from the top corners, non-interactive) frame every screen.
  Home title is the `frame.png` image with "My Love For You" (bold italic IM Fell
  English) overlaid; landing cursor cluster (`cursor-1..6.png` trail) shows on the
  home view only and hides on button hover.
- Songs: creator enters title/artist + a direct audio URL (mp3/wav or any URL the browser's
  `<audio>` tag can play). No file upload/object storage in this environment — see below.
- Postcard photos: optional, 1–5 per letter. Creator can either upload an image file (read
  client-side via `FileReader`, downscaled to a max 900px edge and re-encoded as JPEG on a
  `<canvas>` to keep it small, then stored as a base64 data URL) or paste an external image
  URL. If the creator adds none, the recipient's letter screen shows no postcard element at
  all — the photo section is fully omitted, not shown empty.
- "Share": on save, the letter + playlist + photos JSON is written under a random
  6-character code (`letter:<CODE>`). It uses the Claude artifact's built-in persistent
  key-value store when available (`window.storage`, shared scope), and falls back to the
  browser's `localStorage` when that API doesn't exist — e.g. when this file is opened
  directly or served locally outside claude.ai. The `localStorage` fallback is private to
  one browser on one machine, so codes only resolve on the same device that created them;
  it exists so the app is runnable/testable locally, not as a real shared backend.

## What's out of scope here (needs the real stack)
- **File uploads** for audio and photos (needs real object storage, e.g. Supabase Storage —
  this sandbox has no network egress to any storage provider; photos here are downscaled and
  inlined as base64 in the same JSON blob as the rest of the letter, which works for a
  handful of small images but won't scale to a production system with unbounded uploads).
- **Real shareable URLs** (`/l/<token>`) resolved by a server/router — the artifact has no
  routing of its own; recipients currently paste a code back into the same UI.
- **Server-side authorization** — the prototype's "read-only" mode is a UI-layer flag only;
  a real build needs row-level security (e.g. Supabase RLS: creator can write their own letter
  by owner id, anyone with the share token can read, no one else can read or write).
- **External music source integrations** (Spotify/YouTube embeds, etc.) — needs each service's
  official embed/API, evaluated per-service for CORS/DRM/ToS constraints.
- Persistent multi-session devlog/phase tracking, automated tests, CI, deployment.

## Recommended production stack (unchanged from brief, still valid)
Next.js + TypeScript + Tailwind, GSAP/Framer Motion for the envelope, TipTap for the letter
editor, Postgres via Supabase (with RLS for the creator/recipient split above), Supabase
Storage for uploaded audio, Vercel for hosting.

## Suggested phase order for a Claude Code build
0. Discovery (inspect any existing repo) → 1. Foundation (Next.js scaffold, schema) →
2. Envelope animation → 3. Letter editor + read-only renderer → 4. Vinyl player →
5. Song upload/playlist persistence → 6. Database/storage wiring → 7. Share links + RLS →
8. Validation/error handling → 9. Full integration pass → 10. Testing/polish →
11. Deployment docs. Each phase should update `plan.md` and append to `devlog.md` per the
original brief's handoff format, since that repo will actually persist across sessions.

---

## Visual Theme Update — Color Palette & Celandine Typography

Date: 2026-09-09

Purpose: apply the requested color scheme and main font to the existing single-file
prototype (`index.html`) without redesigning anything. Same website, new palette +
Celandine typography.

New palette (final):
- Background: `#eedec8`
- Main text: `#606c38` (bold)
- Secondary/subtext: `#ac6b73` (kept non-bold unless already bold)
- Buttons: `#4d0e12` (button text kept light `#eedec8` for readability; hover `#380a0d`)
- Other accents: `#a5bcd6`
- Main font: Celandine (stack: `'Celandine', Georgia, 'Times New Roman', serif`)

What was updated (all in `index.html`, styles + a few inline JS style strings only):
- `:root` theme tokens rewritten to the palette above; envelope tokens remapped into the
  `#a5bcd6` family (`#a5bcd6` / `#87a3c4` / `#bccfdd`); record remapped to `#4d0e12` with
  an `#a5bcd6` label; `--gold` now `#a5bcd6`.
- Page/app background (`body`, `.app`) → `#eedec8` (removed the old dark gradient).
- Main headings and primary text (`h1/h2/h3`, `.brand`, `.home-card`, `.now-playing .title`,
  `.track .meta .t`, `.letter-readonly`, share-code) → `#606c38` and bold.
- Secondary text (paragraphs, `.letter-meta`, `.hint`, `.env-hint`, `.scroll-cue`,
  `.now-playing .artist/.status`, `.track .num/.a`, `.time-row`, form labels,
  `.top-bar .code`, `.readonly-tag`) → `#ac6b73`.
- Buttons (`.btn`, `.icon-btn.play`, `accent-color` on ranges) → `#4d0e12`.
- Accent/interface elements (input borders, playlist border, `.track.active`, `.badge`,
  `.plinth` turntable base, tonearm SVG strokes, photo-thumb frames, letter margin rule,
  focus outline, loading dot) → `#a5bcd6` family.
- Cards/inputs kept on near-background tints (`#eedec8` paper, `#fbf4e2` card/input fill)
  to preserve the existing visual hierarchy on the new light background.
- Typography: `body` and form fields now use the `Celandine` stack; added `@font-face`
  rules pointing at `fonts/celandine-regular.woff2` / `fonts/celandine-bold.woff2` so a
  licensed copy can be dropped in with no code change. Font sizes, line heights, spacing,
  and dimensions were not changed.
- Inline JS colors updated to match: postcard/playlist `h3` headings → `#606c38`;
  tonearm SVG fills/strokes → `#4d0e12` / `#a5bcd6` / `#ac6b73`.

Intentionally preserved (not changed): layout, page structure, components, animations
(flap flip, paper slide, record spin, tonearm swing, screen transitions), interactions,
functionality, button behavior, navigation, content, images, spacing, sizing,
positioning, storage/share logic, and routes. Only color styling, text weight for main
text, and font family changed. See `devlog.md` (Visual Theme Update entry) for the
Celandine availability limitation and test results.

---

## Letter Frame & Title Update

Date: 2026-09-10

- The old "A Letter For You" text was removed from the home section: both the `.brand`
  label line and the `h1` heading line in `renderHome()` (`index.html`) are gone.
- The provided frame image was added: `renderHome()` now renders
  `<img src="frame.png">` (class `.title-frame-img`, natural proportions preserved via
  `width:100%; height:auto`) in place of the removed text.
- "My Love For You" was added inside the frame as an overlaid, centered
  `.title-frame-text` div.
- The text uses bold italic `IM FELL English` (Google Fonts `IM Fell English` italic
  webfont + `font-weight:bold; font-style:italic`; stack falls back to Georgia/serif).
- Manual step required: save the provided frame picture as `frame.png` next to
  `index.html` (see `devlog.md` entry for this change).
- The rest of the existing website (layout, colors, other typography, animations,
  functionality, other screens' labels) was intentionally preserved.

---

## Corner Vine Picture (Top-Right)

Date: 2026-09-10

- The provided vine/flower picture was added to the top-right corner of the website.
- Implementation in `index.html`: a static
  `<img src="corner-vine.png" alt="" aria-hidden="true" class="corner-vine">` placed as
  a direct child of `<body>` (outside `#app`, so screen re-renders never wipe it) plus
  a `.corner-vine` rule — `position:fixed; top:0; right:0`, width
  `clamp(96px,16vw,168px)` (76px on screens ≤560px wide), `height:auto` so original
  proportions are preserved, `pointer-events:none` so it never blocks text, buttons,
  navigation, or animations. Decorative only (`alt=""`, `aria-hidden`).
- Manual step required: save the provided vine picture as `corner-vine.png` next to
  `index.html` (see `devlog.md` entry for this change).
- Nothing else changed: layout, colors, fonts, text, images, animations, interactions,
  functionality, and backend behavior intentionally preserved.

---

## Corner Vine Picture (Top-Left, Mirrored)

Date: 2026-09-10

- The second provided vine picture was added to the top-left corner, mirroring the
  right vine's configuration: same fixed positioning, same height sizing
  (`min(52vh,460px)`, 32vh on screens ≤560px via the shared `.corner-vine` rule),
  same non-interactive decorative treatment (`pointer-events:none`, `alt=""`).
- Mirrored geometry in `.corner-vine-left` (`index.html`): `left:0` (with
  `right:auto`), `translate(-45%,0) rotate(-20deg)` pivoting on
  `transform-origin:45% 0` (the new vine's stem tip), so the tip sits in the
  top-left corner and the body swings right into full view — the mirror image of
  the right vine.
- Manual step required: save the second provided vine picture as
  `corner-vine-left.png` next to `index.html` (see `devlog.md`).

---

## Cursor-Following Image Cluster (Landing Page)

Date: 2026-09-10

- The 6 provided pictures form a cursor-following cluster on the landing page only
  (the `renderHome()` view holding "Create a letter" / "I received a gift code").
- Implementation in `index.html` (existing vanilla-JS/CSS conventions, no new
  dependencies): a static `#cursorCluster` div (direct `<body>` child, outside `#app`
  so re-renders never wipe it) holding 6 separate `<img>` tags (`cursor-1.png` …
  `cursor-6.png`); each keeps natural proportions (`height:auto`, individual widths
  52–64px) and its own cluster offset (`.cc1`…`.cc6`), plus a staggered reuse of the
  existing `bob` keyframe for a gentle independent float.
- Motion: a `requestAnimationFrame` loop lerps the container toward the cursor
  (factor 0.12) for a smooth trailing follow; the loop only reads `state.view` and
  touches no existing render logic. `pointer-events:none`, hidden until the first
  mousemove and when the cursor leaves the window; hidden entirely under
  `prefers-reduced-motion`, matching project conventions.
- Hover: delegated `mouseover`/`mouseout` on `.home-card .btn` hides the cluster
  (fast opacity fade) over either landing button.
- Click/navigation: visibility is gated on `state.view==='home'`, so entering either
  flow (or any other screen) hides the effect completely with no transition leakage.
- Manual step required: save the 6 provided pictures as `cursor-1.png` … `cursor-6.png`
  next to `index.html` (see `devlog.md`).
- Nothing else changed: layout, colors, fonts, text, buttons, animations,
  functionality, and backend behavior intentionally preserved.

---

## Envelope Decorative Pictures (Marked Spots + Hover Slide)

Date: 2026-09-10

- The 6 provided pictures (`cursor-1.png` … `cursor-6.png`, same files as the landing
  cluster) are placed at the six marked spots around the envelope on the envelope
  screen (`renderEnvelope()`, shared by creator and recipient flows): top-left,
  top-center, top-right, bottom-left, bottom-center, bottom-right — matching the
  screenshot's marked areas, sizes (~56–88px, `height:auto` so proportions hold), and
  spacing.
- Implementation in `index.html`: six `span.env-spot` anchors absolutely positioned
  inside the (relatively positioned) `.screen` container, each holding one `img.env-pic`
  centered on its spot; `z-index:1`, decorative (`aria-hidden`, empty `alt`).
- Hover interaction (pure CSS, per-picture independent): hovering a picture slides it
  12px sideways (`.env-spot:hover .env-pic`, `transition:transform .25s ease`) with no
  disappearing, rotating, or distortion; it returns smoothly on mouse-leave. Disabled
  under `prefers-reduced-motion`, matching project conventions.
- Follow-up: pictures enlarged (~88–128px) and properly aligned by anchoring them to
  the envelope itself via a relatively positioned `.envelope-stage` wrapper (pixel
  offsets from the envelope edges, so alignment holds on any window size); tighter
  offsets + `overflow-x:clip` guard on small screens.
- Nothing else changed: envelope animation, flows, layout, colors, fonts, backend
  intentionally preserved.

---

## Picture-Based Envelope → Letter Sequence

Date: 2026-09-10

- The CSS-drawn envelope was replaced with the 3 provided pictures (exact files, no
  CSS recreations): `envelope-closed.png` (3rd supplied picture, embossed flap),
  `envelope-open.png` (2nd supplied picture, open envelope with card),
  `letter-page.png` (1st supplied picture, lace frame). All shown at natural aspect
  ratios (`width:100%; height:auto`), never stretched.
- Sequence (existing timing kept): closed picture is the clickable element → click
  swaps to the open picture with a fade (`env-fade` .45s) → open stays visible for
  the existing brief ~1.25s pause → smooth `unfold` transition to the letter page
  (creator and recipient flows share the envelope screen).
- Letter page: the writing area (composer `<textarea>` / read-only message plus the
  existing labels) sits in a `.letter-writing` overlay positioned inside the lace
  frame's inner area over the `letter-page.png` image.
- Hover: envelope hover is now a 12px maximum horizontal slide (`translateX(12px)`,
  `.35s`, smooth return, no vertical movement), matching the existing pictures' hover
  spec; the 6 decorative pictures' 12px hover is untouched. Reduced-motion guards
  cover the new fade/hover.
- Manual step required: save the 3 pictures as `envelope-closed.png`,
  `envelope-open.png`, `letter-page.png` next to `index.html` (see `devlog.md`,
  including the background note).
- Bugfix (2026-09-10, verified with headless-Chrome screenshots): the letter paper
  404'd because the file was saved as `lace frame.png` — renamed to `letter-page.png`,
  which had left the whole letter screen empty after the open-envelope pause; open
  state also recomposed (artwork-hugging drop-shadow, compact centered sizing).
- Follow-up (new open-envelope artwork): open state sizing unified with closed
  (shared `width:100%; height:auto` rule) — same width, natural proportions.
- Follow-up (presence): envelope wrap widened to `min(84vw,400px)` so both states
  render larger; aspects and matching preserved.

---

## Bottom Wave Flourish (Knights Removed)

Date: 2026-09-10

- Both knight corner pictures removed (markup + CSS gone; files left on disk).
- Provided wave flourish placed along the bottom-right window corner
  (`.corner-wave`: `fixed; bottom:0; right:0`), wide (`width:min(40vw,440px)`,
  56vw mobile), natural proportions, non-interactive.
  Needs `corner-wave.png` saved next to `index.html` + a placement check.

---

## Removal — Corner Wave Taken Off (2026-09-10)

- Bottom-right wave flourish removed (CSS rules + image tag deleted from
  `index.html`); `corner-wave.png` left on disk, unused.

---

## Provided Vinyl Picture on the Recorder (2026-09-10)

- CSS-drawn disc replaced with `vinyl-record.png` in the exact 220px disc slot;
  plinth/tonearm untouched. Existing audio-synced `.spinning`/`.paused` rotation
  reused as-is (play → rotates, pause/end → stops, centered). File now on disk
  (verified 2026-09-10); still needs a real-browser playback pass.
- Follow-up (same date): "A Letter For You" brand line removed from the vinyl page
  top bar (`renderVinyl()`); creator song counter kept right-aligned.

---

## Lace Texture Background

Date: 2026-09-10

- Full-page subtle lace lattice in pure CSS (no new assets): layered radial-gradient
  medallions, dot grain, and ring motifs in muted tan over `#fdedad`, fixed while
  scrolling; `.app` made transparent so it shows through everywhere. Verified via
  headless-Chrome screenshots (two iterations) — delicate doily feel, text stays
  readable. A real lace image file could swap in later with a one-rule change.
- Follow-up: CSS lace removed; provided floral scrollwork picture used as a fixed
  full-viewport overlay instead (`.floral-overlay` tiling `floral-overlay.png`,
  softened to 780px tile at 30% opacity, non-interactive, below all content).
  File now on disk (verified 2026-09-10). The leftover `.app::before` dot grid
  was also removed (2x-screenshot verified).

---

## Doc Sync + Asset Inventory (2026-09-10)

- All 14 image assets verified on disk next to `index.html`: `frame.png`,
  `corner-vine.png`, `corner-vine-left.png`, `cursor-1.png` … `cursor-6.png`,
  `envelope-closed.png`, `envelope-open.png` (181KB portrait replacement),
  `letter-page.png`, `floral-overlay.png`, `vinyl-record.png`. Earlier "NOT in
  the repo / save the file" notes are therefore resolved; unused superseded files
  (`corner-wave.png`, old knight corners) may be deleted if wanted.
- Background is `#fdedad` (not `#eedec8`); envelope/letter/vinyl are all
  picture-based (the old CSS-drawn descriptions elsewhere in this file are
  superseded by the "Prototype implementation" section at the top, which is now
  the source of truth).
- Envelope ring positions (devlog "Fix — Envelope centered + pictures ring" plus
  sun/lady/rabbit follow-ups and the lady/knight swap), letter composer styling
  (label removed, italic pink text + visible placeholder, writing area on the
  white paper, scroll cue removed, small continue button) are all in
  `index.html` but were missing from this plan — now covered in "Prototype
  implementation" above.
- Known stale copy (not fixed, flagged): `renderHome()` still reads "add five or
  more songs" while the enforced rule is 1–10 (`MIN_SONGS = 1`,
  `MAX_SONGS = 10`). Wording kept as-is per 2026-09-16 request; that request
  only made the tagline larger + italic (18px italic `.home-tagline`, scoped
  so the saved-screen paragraph is unaffected). Change that one string when convenient.

---

## Follow-up — Home tagline spacing below frame (2026-09-16)

- Home tagline "Write a personal letter, add five or more songs..." moved a
  bit lower for breathing room below the "My Love For You" frame: `.home-card
  .home-tagline` `margin-top` `28px` → `42px` in `index.html` (kept
  `.title-frame` `margin:0 auto 18px` as-is, so total gap frame→tagline is
  now 18+42=60px vs 46px before; ~14px more, de-cluttered without touching
  font size/style, wording, layout, or other screens).

## Follow-up — Envelope header per role (2026-09-16)

- Closed-envelope screen (`renderEnvelope()` in `index.html:501-531`): removed
  the generic `el('div',{class:'brand',text:'A Letter For You'})` that showed
  for both roles. Creator (`state.mode==='creator'`) now sees
  `text:'Write your letter'` in the same `.brand` style above the envelope
  (envelope-decoration ring + hint unchanged); recipient sees no top brand
  line (only stage + hint "Click to open your gift"). Other screens that
  still use "A Letter For You" (`renderEnterCode()` `index.html:498`, `renderSaved()`
  `index.html:757`, `<title>` `index.html:5`) untouched per request.

## Follow-up — Open envelope stays with click-to-continue (2026-09-16)

- Open-envelope screen (`index.html:351-354,501-532,83-85`): removed auto
  `setTimeout 1250ms` that vanished the open envelope to the letter.
  `openEnvelope()` now only sets `state.envelopeOpen=true` + `render()`.
  When open, envelope stays visible; bottom `env-hint` becomes clickable
  `role=button` + keyboard handler + `cursor:pointer underline` that on click
  does `state.view='letter'; render()`. Closed hint stays
  "Click to begin your letter" (creator) / "Click to open your gift"
  (recipient); open hint is "Click to begin your letter" (creator) /
  "Click to read your letter" (recipient). Envelope wrap itself is also
   clickable when open (`.open.clickable`, hover nudge) for same `goLetter()`.
  No redesign of envelope pictures, ring, or letter page.

## Follow-up — Open envelope size proportionate (2026-09-16)

- Envelope pictures (`index.html:71-81`): closed `577×432` landscape vs open
  `421×593` portrait have different intrinsic ratios, so at equal `400px` width
  the open body looked smaller. `.envelope-wrap` now `min(84vw,400px)` closed
  → `min(90vw,440px)` when `.open` (+10%, `transition: width`) so the open
  envelope renders visibly larger and proportionate to the closed one while
  staying centered in the flex `.screen`. `.env-open` forced to `width:100%`.
  Ring positions (`.env-spot`) unchanged.

---

## Medieval Keepsake Visual Elevation & Interaction Polish (2026-09-16)

- **Envelope Spacing & Overlap Resolution**:
  - Resolved collisions where the top figure (`cursor-2.png`, rabbit) touched the header text and the bottom figure (`cursor-5.png`, sun) overlapped the unsealing prompt.
  - Adjusted `.envelope-stage` vertical clearance (`margin: 110px auto 45px`, `90px auto 35px` on mobile) and `.env-hint` (`margin-top: 95px`, `75px` on mobile), with tuned spot anchors. The six medieval illustrations now form a perfectly balanced decorative ring around the envelope with generous breathing room.
- **Tactile Unsealing Feedback**:
  - Added synthetic Web Audio API acoustic harp chime on envelope opening (pure native Web Audio synthesis, zero dependencies).
  - Added golden stardust sparkle burst animation (`.sparkle-particle`) radiating from the unsealing point.
- **Illuminated Letterhead & Manuscript Typography**:
  - Added medieval illuminated drop-cap initial (`.letter-readonly::first-letter`) in deep burgundy `#4d0e12` with subtle antique gold drop-shadow (`IM Fell English`), transforming the recipient letter into an authentic storybook manuscript.
  - Added parchment writing placeholder: `"Write your letter here upon this parchment..."` for creator composer.
- **Melodic Vinyl & Illuminated Playlist**:
  - Converted track numbering from plain numbers to Roman numerals (`I`, `II`, `III`...) via `toRoman()`.
  - Added animated medieval sound-wave/equalizer bars (`.sound-bars`, `.sound-bar`) beside the active track title during playback.
  - Plinth styled with antique lacquer radial gradient, gold corner filigree brackets, and glowing rim.
  - Added floating music notes emitter (`startNoteEmitter`) drifting upward while audio plays.
  - Neatly framed the creator song counter in an illuminated badge (`.badge`) to prevent crowding the corner vines.
- **Atmospheric Arbor Motion**:
  - Added organic swaying breeze animation to the corner vines (`@keyframes vine-breeze-left` / `right`).
  - Added soft parchment vignette behind main content to enhance contrast and readability over the tiled floral pattern overlay.

---

## Targeted Restoration & Audio Playback Resolution (2026-09-28)

1. **Restore Original 6 Cursor-Following Pictures Behavior**:
   - Kept all 6 original images (`cursor-1.png` to `cursor-6.png`) strictly on the home landing view (`state.view === 'home'`).
   - Restored original trailing lag physics using exact `ccLag = [0.20, 0.16, 0.13, 0.11, 0.09, 0.08]` with individual offsets and tilt angles (`ccTilt = [-6, 4, -3, 5, -5, 3]`).
   - Maintained original natural widths (`cc1` 56px, `cc2` 64px, `cc3` 52px, `cc4` 60px, `cc5` 54px, `cc6` 58px) and removed extra filter drop-shadows.
   - Preserved button hover suppression (`.home-card .btn` mouseover hides cluster) and smooth opacity fade (`.cursor-cluster { transition: opacity .15s ease; }`).

2. **Restore Closed Envelope Exactly As Original Implementation**:
   - Restored original closed envelope appearance (`envelope-closed.png`) with standard `width: min(84vw, 400px)` and centered stage.
   - Restored original hover animation: clean 12px horizontal slide (`transform: translateX(12px)`) with smooth return and zero vertical shift.
   - Restored original unsealing interaction sequence: clicking closed envelope triggers `openEnvelope()` → swaps to `envelope-open.png` with smooth fade (`.env-fade .45s`) → holds for ~1.25s (`1250ms`) pause → automatically unfolds to the letter screen (`state.view = 'letter'`).
   - Removed experimental unseal audio oscillator synthesizer and sparkle burst to maintain exact original design and interaction.

3. **Vinyl Player Audio Playback Logic & Offline Assets**:
   - Preserved 100% of the vinyl player UI, tonearm SVG, turntable plinth, record disc (`vinyl-record.png`), equalizer bars, and controls without alteration.
   - Solved broken playback by bundling three local, lightweight, public-domain classical MP3 files in the project root (`song-1.mp3`, `song-2.mp3`, `song-3.mp3`) and initializing them in `DEFAULT_SONGS`.
   - Wired audio events (`playing`, `pause`, `waiting`, `ended`, `timeupdate`, `loadedmetadata`, `error`) to synchronize `.spinning` vinyl record and tonearm movement strictly with real audio playback.
   - Connected the seek bar to actual audio `currentTime` and `duration`, supporting smooth user scrubbing without glitching during playback.
   - Connected volume slider to `audioEl.volume` for immediate, real-time volume adjustment.


## Songs from device (2026-11-21)
Done: schema + API + UI + tests. Remaining: re-run schema.sql in Supabase, verify >4 MB direct upload on real Supabase.
