# Deployment guide — My Love For You (Netlify + Supabase)

Everything under "Code" is already in the repo. Everything under "You must do" needs your accounts/credentials and has
**not** been verified against a live Supabase project yet — see the checklist at the end.

## 1. Supabase (one-time, ~10 minutes)

1. Create a project at <https://supabase.com> (free tier is fine). Note the region.
2. **SQL Editor -> New query**, paste the whole of `supabase/schema.sql`, **Run**. It is safe to re-run.
   It creates the tables, locks them down (RLS on, no policies, no grants for `anon`/`authenticated`), creates the
   server-side functions, and creates the **private** `gift-photos` storage bucket.
3. **Storage**: confirm a bucket named `gift-photos` exists and shows as *Private*. (If the SQL could not create it,
   create it by hand: private, 1.5 MB file limit, MIME types `image/jpeg, image/png, image/webp`.) Do **not** add any
   storage policies.
4. **Project Settings -> API**: copy the *Project URL* and the **service_role** key. You do **not** need the anon key —
   the browser never talks to Supabase.
5. (Recommended) **Project Settings -> API -> JWT/API keys**: if your project offers the new secret key format
   (`sb_secret_...`), you can use it as `SUPABASE_SERVICE_ROLE_KEY` instead.

## 2. Netlify

1. Push the repo to GitHub/GitLab and **Add new site -> Import an existing project**. Netlify reads `netlify.toml`:
   build command `node scripts/build.mjs`, publish directory `dist`, functions `netlify/functions`. No other settings needed.
   (Dev dependencies — `sharp`, `playwright`, `@electric-sql/pglite` — are not needed for the build; the optimized images
   are committed in `src/img/`.)
2. **Site configuration -> Environment variables**, add the three variables from `.env.example`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` as a *secret*, `RATE_LIMIT_SALT`). Redeploy.
3. Open the site. Before the variables are set the API answers `503 backend_not_configured` and the app shows
   "The gift service isn't set up yet" — it never pretends a gift was saved.
4. Scheduled function `cleanup` runs daily and removes photo uploads that were never attached to a saved gift (>24 h old).
   Check **Logs -> Functions -> cleanup** after the first day.

## 3. Verify on the live site (please do these — they are the tests I could not run)

| # | Check | Expected |
|---|-------|----------|
| 1 | Device A: write letter, add 2 photos + songs, Save | "Your gift is ready" with a link `https://<site>/g/<20 chars>` |
| 2 | Supabase -> Table editor `gifts` | one row; `photos` contains ids, no `data:` strings; `manage_key_hash` is 64 hex chars |
| 3 | Device B (phone, mobile data): open the link | envelope -> letter -> photos -> record plays |
| 4 | Device B: home -> "I received a gift code" -> paste the code (with or without dashes) | opens the gift |
| 5 | Storage -> `gift-photos` | objects exist; opening an object URL without a token fails |
| 6 | Browser DevTools -> Network on the share page | photo URLs are `.../object/sign/gift-photos/...?token=` (https) |
| 7 | Device A: "Manage this gift" -> Delete | link now says "deleted"; storage objects gone |
| 8 | `curl -i https://<site>/api/gifts/AAAAAAAAAAAAAAAAAAAA` | `404 {"error":"not_found"}` |
| 9 | `curl -i -X DELETE https://<site>/api/gifts/<code>` | `401` |
| 10 | Response headers of `/assets/css/*.css` | `cache-control: public, max-age=31536000, immutable` |
| 11 | Response headers of `/` | `cache-control: public, max-age=0, must-revalidate` |
| 12 | Lighthouse (mobile) on the home page | record the numbers in `docs/TEST-REPORT.md` |

## 4. Day-to-day

| Task | Command |
|------|---------|
| Install dev tools | `npm install` |
| Re-generate optimized images from `originals/img/*.png` | `npm run images` |
| Build | `npm run build` (writes `dist/`) |
| Local preview, no accounts needed (fake backend) | `npm run build && FAKE_BACKEND=1 npm run dev` -> <http://127.0.0.1:8888> |
| Local preview against your real Supabase | `export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RATE_LIMIT_SALT=...; npm run dev` |
| Unit + integration tests | `npm test` |
| Browser tests | `CHROMIUM_PATH=/path/to/chrome npm run test:e2e` (omit `CHROMIUM_PATH` if `npx playwright install chromium` was run) |
| Before/after load measurement | `node tests/perf/measure.mjs` |

## 5. Security model in one paragraph

Gift links are **bearer secrets** (100 bits of CSPRNG entropy, generated server-side): anyone who has the link can read the
gift, so share it only with the recipient. Nobody can edit a saved gift — there is no update endpoint. The creator's browser
holds a separate 256-bit *manage key* (only its SHA-256 is stored) that is required to delete; it is shown on the "Manage this
gift" panel so it can be copied to another device. If the manage key is lost, delete the row in the Supabase dashboard.
Photos are stored in a private bucket and handed to recipients as 1-hour signed URLs; each page view fetches fresh ones.
Rate limits (per hashed IP, stored in Postgres): create 4/min & 12/h, photo upload 15/min & 60/h, lookups 90/min, and 20 failed
lookups per 10 min.

## 6. Known limits

* No creator accounts: a lost manage key means deletion must be done from the Supabase dashboard.
* External (pasted) photo and audio links are fetched directly by the recipient's browser: they can disappear, may
  track the recipient (the site sends `Referrer-Policy: no-referrer` to limit this), and many streaming pages
  (YouTube, Spotify, ...) are not playable in an HTML audio element. Uploaded photos are the reliable, private option.
* Signed photo URLs expire after 1 hour; the viewer silently re-requests them if one fails ("Try again").
* Netlify Function request bodies are limited to ~6 MB; photos are capped at 1.5 MB after in-browser compression.
* Prototype gifts saved only in a browser's localStorage cannot become cross-device automatically; opening an old 6-character
  code in the same browser offers to re-publish it.
* The licensed Celandine font is not bundled; the Georgia/serif fallback is used. Drop licensed `celandine-regular.woff2` and
  `celandine-bold.woff2` into `src/fonts/` and rebuild to enable it.


## Update: songs from the creator's device, medieval photo tray, animated figures

**You must do this once for song uploads to work in production**
1. Supabase → SQL Editor → paste the whole updated `supabase/schema.sql` → Run. It is safe to re-run; it adds the `audio_files` table, new functions and the private `gift-audio` bucket. Check Storage shows `gift-audio`.
2. Push the updated project to GitHub `main` (Netlify redeploys by itself).

Limits: 10 MB per song, 30 MB of uploaded songs per gift, MP3/M4A/AAC/OGG/WAV/WebM (checked by content, not by name). Supabase free plan: 50 MB per file and 1 GB storage in total.
Songs up to 4 MB go through the Netlify function; larger ones upload straight to Supabase Storage with a one-time link and are verified afterwards.
**Not yet verified against real Supabase:** the direct (>4 MB) path. After deploying, test once with an ~8 MB MP3; if it fails with a network error, the Supabase Storage CORS/limits are the first place to look.
