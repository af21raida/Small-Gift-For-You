# Testing & performance report

Date: 2026-11-04. Environment: Linux sandbox, Node 22, Chromium 1243 (headless) via Playwright 1.64.
**Everything below ran against a local server and a local stand-in for Supabase. Nothing here was run against a live Netlify
site or a live Supabase project.** Section 4 lists exactly what is still unverified.

## 1. What was run and what it proves

| Suite | Command | Result | What it actually exercises |
|-------|---------|--------|----------------------------|
| Unit + integration | `npm test` | **39 / 39 pass** | The real function handlers and the real `supabase/schema.sql` executed in PGlite (a real PostgreSQL engine, WASM). Storage is an in-memory fake. |
| Browser end-to-end | `npm run test:e2e` | **76 / 76 pass** (incl. song upload: small + >4 MB, invalid/oversized files, recipient playback) | Built `dist/` served with the `netlify.toml` headers, real functions, PGlite DB, Chromium. |
| Load measurement | `node tests/perf/measure.mjs` | see section 2 | Before vs after, CDP network throttling + 4x CPU slowdown, 3 runs each (median shown). |

### Verified (stand-in backend)
* **Creator flow** Home -> Envelope -> Letter -> 2 photos -> Vinyl -> Save -> Share, with 10 songs.
* **Recipient flow in a separate browser context** (no shared storage): link opens envelope -> exact letter text (HTML escaped) ->
  photos load through signed URLs -> navigation 1/2, 2/2 -> 10 songs, no editing controls. Manual code entry (with dashes) works.
* **Data rules** 1 song OK, 10 songs OK, 11 and 0 rejected (client and server); 0 photos => no postcard section;
  5 photos OK in order, 6 rejected; invalid file type rejected with a friendly message; spoofed type/SVG/empty/>1.5 MB rejected;
  10,000-character letter round-trips, 10,001 rejected; 60-paragraph letter displays fully for the recipient.
* **Gift codes** 20 chars, 100 bits, `crypto.randomBytes`; 50,000 draws: no duplicates, character frequencies within 3 % of uniform;
  collision handled in the database without overwriting; lowercase/dashed input normalised.
* **Reliability** network failure on save shows an error (never "Your gift is ready"), draft survives, retry succeeds and
  creates exactly one gift; 6 simultaneous identical saves create one gift; idempotency key cannot be hijacked; upstream
  outage returns 5xx; missing configuration returns `503 backend_not_configured`.
* **Security** no update endpoint (PUT/PATCH -> 405); delete without key -> 401, wrong key -> 403, correct key wipes row + storage;
  deleted link -> 410; `anon`/`authenticated` roles get *permission denied* on every table and function; RLS enabled+forced with 0 policies;
  manage key stored only as SHA-256; cross-origin API requests rejected; rate limits trigger (create, upload, lookup-miss brute force);
  errors do not leak internals; no secrets in `dist/` (see grep below).
* **Cleanup** orphaned uploads >24 h are purged; fresh and attached uploads are kept; an expired upload cannot be attached.
* **Player** play/pause/next/previous/playlist selection/seek/volume (read back from the real `Audio` element)/duration display; record
  spinning and tonearm follow actual playback and stop on pause and on an audio error; unplayable link shows a friendly error;
  the home page downloads **0** MP3s; before pressing play at most the current track's metadata is fetched (not all three).
* **Responsive** widths 320, 375, 390, 430, 768, 1280: no horizontal scroll on home/envelope/letter/vinyl, long letter grows the paper
  with no nested scrollbar, continue button >= 40 px and on-screen, turntable inside the viewport. *This found and fixed a real bug:* at
  561-914 px the envelope's side illustrations overflowed the viewport by up to 30 px.
* **Animation/behaviour** cursor cluster: six images on a desktop pointer; not created on touch devices or with `prefers-reduced-motion`.
* **Console** no page errors, no console errors, no failed static requests during all flows.

## 2. Performance: before vs after

*Before* = the original prototype (original full-size PNGs, plain Netlify-style headers with ETag revalidation).
*After* = `dist/` with `netlify.toml` headers. Local server; throttle: Slow 4G = 1.6 Mbps / 150 ms RTT, Fast 3G = 0.8 Mbps / 300 ms RTT; CPU 4x.
External hosts (Google Fonts, used only by the old prototype) were blocked for both. Raw data: `docs/perf-report.json`.

| Scenario | LCP before | LCP after | Transfer before | Transfer after | Image requests (bytes) before | after | CLS before | after |
|----------|-----------:|----------:|----------------:|---------------:|-------------------------------|-------|-----------:|------:|
| Mobile 390x844 @2x, Slow 4G | 28.7 s | **2.0 s** | 5,787 KB | **451 KB** | 10 (5,771 KB) | 7 (360 KB) | 0.049 | **0** |
| Desktop 1280x800, Slow 4G | 28.7 s | **1.2 s** | 5,787 KB | **434 KB** | 10 (5,771 KB) | 13 (342 KB) | 0.030 | **0** |
| Mobile, Fast 3G | 57.2 s | **3.9 s** | 5,787 KB | **451 KB** | 10 (5,771 KB) | 7 (360 KB) | 0.049 | **0** |
| Repeat visit (warm cache), mobile Slow 4G | 0.83 s | 0.44 s | 2.5 KB (304s) | 3.4 KB (cache) | | | | |

* The LCP element in both versions is the title frame. Before, it was a 1.46 MB PNG; now a ~80 KB AVIF (~31 KB at 520 px) that is in the HTML
  with `fetchpriority=high` and explicit width/height.
* First-load image weight: **-94 %** on mobile. The 16 original PNGs total 8.08 MB (kept in `originals/img/`).
* Off-screen/unneeded assets at load: no MP3s, no letter/vinyl/postcard art, and (after the final fix) **no cursor images on touch devices**.
  After `load`, idle-time warm-up fetches the open/closed envelope and, on desktop pointers only, the six cursor images.
* Per-image sizes (original -> AVIF/WebP/PNG at display width) are in `docs/image-report.json`; e.g. `frame.png` 1,464,094 B ->
  31,674 B AVIF / 44,466 B WebP / 46,482 B PNG at 520 px; `cursor-2.png` 1,410,891 B -> 4,131 B AVIF at 128 px.
* Not measured: **INP** (needs real interaction traces on real hardware), Lighthouse score, real CDN latency/TLS/Brotli.

## 3. Secret scan
`grep -ri "service_role\|SUPABASE_SERVICE" dist/ src/` returns nothing: the key exists only in Netlify environment variables read by the functions.

## 4. NOT verified — please do these
1. **Live Supabase**: the SQL was run on PGlite (PostgreSQL), not on Supabase. Possible differences: PostgREST handling of the RPC argument
   types, Storage signed-URL response shape (the code accepts both relative and `/storage/v1`-prefixed `signedURL`), bucket creation via SQL,
   the `service_role` key format, free-tier limits. Follow the 12-point checklist in `docs/DEPLOYMENT.md`.
2. **Cross-device sharing on the live site** (the main goal) — only proven between two independent browser contexts on the local stand-in.
3. **Real Netlify behaviour**: `_headers` via `netlify.toml`, Brotli, function cold starts, `context.ip`, scheduled function execution.
4. **Lighthouse / live LCP / INP** from the deployed URL.
5. **Safari / iOS / Firefox**: only Chromium was available. Specific risks: WebP encoding via canvas (code falls back to JPEG), `createImageBitmap`
   orientation, `<input type=file>` on iOS, AVIF support on older iOS (PNG fallback exists).
6. **Real phones**: touch targets, file picker, and smoothness were checked with emulation only.
7. **Visual regression**: no pixel-diff against the original; appearance was reviewed by eye on screenshots (`tests/e2e/out/`, git-ignored). The six
   cursor illustrations, vines, envelope art, letter paper and vinyl player are the same artwork and code paths, but have not been pixel-compared.
8. **Audio over real networks** and external audio links (many streaming URLs will not play in an `<audio>` element).
9. **Quota exhaustion** behaviour (`quota_exceeded`) is mapped but was not triggered against real Supabase.
