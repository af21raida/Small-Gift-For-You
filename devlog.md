# Devlog — Interactive Digital Letter & Vinyl Gift

This log covers the front-end prototype built in a sandboxed chat environment (no network
egress, no persistent server). See `plan.md` for what a full production build still needs
and the recommended phase order for that work.

---

## Phase P0 — Prototype: envelope, letter, vinyl, share-by-code

Date: 2026-09-10

Status: Complete (prototype scope only)

What was implemented:
- Single-file `index.html`, vanilla JS (no build step, no framework), state-machine style
  render loop (`state` object → `render()` re-draws the active screen).
- Home screen with two entry points: "Create a letter" (creator flow) and "I received a
  gift code" (recipient flow).
- Envelope screen: CSS 3D flap flip + paper slide-out animation, triggered on click.
  Keyboard-accessible (tab focus + Enter/Space), `aria-live` status text.
- Letter screen: `<textarea>` for the creator, read-only `<div>` for the recipient. Visual
  paper texture via repeating-linear-gradient "ruled lines".
- Vinyl screen: CSS-animated spinning record (`.spinning` class toggled by `<audio>`
  play/pause state), a tonearm that swings onto the record when playing, transport controls
  (prev/play/pause/next), seek bar bound to `currentTime`/`duration`, volume, and a playlist
  with reorder (up/down) and remove for the creator.
- Songs: creator adds title/artist + a direct audio URL (anything the browser's `<audio>`
  tag can play — no file upload in this environment, see Known limitations).
- Share mechanism: on save, the letter + playlist JSON is written to the artifact's built-in
  persistent key-value store (`window.storage`) under a random 6-character code
  (`letter:<CODE>`, shared scope). The recipient flow reads the same key back by code. This
  stands in for a real database + routable share link.

Files changed:
- `index.html` (created)
- `plan.md` (created)

Important architectural decisions:
- No framework/build step — kept as a single static HTML file so it can be opened directly
  or dropped into any static host without tooling, given the sandbox has no npm/network.
- `window.storage` (shared scope) used as a stand-in database. It is scoped to this artifact
  only; it is not a general-purpose backend and has no real auth/authorization model.
- Recipient "read-only" mode is a UI-layer flag (`state.mode === 'recipient'`) only — there is
  no server enforcing this. Documented as a known limitation, not silently glossed over.

Tests performed:
- Manual: created a letter, added songs, saved, copied the code, loaded it back via
  "I received a gift code," confirmed the letter renders read-only and songs play.
- Manual: verified play/pause toggles the record spin and tonearm position via real
  `<audio>` events (`playing`/`pause`/`waiting`/`error`), not just button state.
- Manual: checked keyboard-only navigation of the envelope (Tab + Enter/Space).
- No automated tests — there is no test runner in this environment.

Problems encountered:
- Initial `disabled` attribute handling in the `el()` DOM helper set `disabled="false"` as a
  literal attribute (which HTML treats as present/disabled regardless of the string value),
  so the "Add song" button stayed disabled even when the playlist wasn't full.

Problems fixed:
- Updated `el()` to treat boolean props specially: `true` sets the attribute with an empty
  value, `false` omits it entirely, instead of stringifying it.

Known limitations:
- No file upload / object storage — audio must be a reachable URL.
- No real routable share URL (`/l/<token>`) — recipients paste a code back into the same UI.
- No server-side authorization — the read-only boundary is UI-only.
- No external music service embeds (Spotify/YouTube/etc.).
- No automated test suite, CI, or deployment target.

Next steps:
- If continuing as a prototype: nicer letter typography, drag-and-drop playlist reorder,
  a lightweight "preview as recipient" toggle for the creator before saving.
- If moving to production: follow the phase order in `plan.md` starting from Phase 0
  (repo discovery) in a real, persistent repo — this prototype does not need to be preserved
  as-is; it's a reference for the interaction design, not a codebase to build on top of.

---

## Phase P1 — Song count rule change

Date: 2026-09-10

Status: Complete

What was implemented:
- Removed the 5-song minimum. Creator can now save with as few as 1 song.
- Added a maximum of 10 songs; the "Add song" button disables and reads "Playlist full"
  once the cap is hit, with an inline message if the creator tries to add past it.
- Updated the "X / N songs" counter and the save-blocked message text to match.

Files changed:
- `index.html` (`MIN_SONGS`/`MAX_SONGS` constants added; `addSong`, save button, and
  playlist counter updated; `el()` boolean-attribute fix — see Problems fixed above)
- `plan.md` (song-count language updated from "5+" to "1–10")

Important architectural decisions:
- Min/max are named constants (`MIN_SONGS = 1`, `MAX_SONGS = 10`) at the top of the script
  rather than hardcoded numbers scattered through the render functions, so the limits are a
  one-line change if they need to move (e.g. to a max of 5).

Tests performed:
- Manual: saved a letter with exactly 1 song, confirmed it's accepted.
- Manual: added 10 songs, confirmed the 11th is blocked and the button reads
  "Playlist full".

Problems encountered / fixed: none beyond the `el()` boolean fix noted in Phase P0.

Known limitations: same as Phase P0.

Next steps: none pending from this change; open items are the same production-build gaps
listed in `plan.md`.

---

## Phase P2 — Optional postcard photos

Date: 2026-09-10

Status: Complete

What was implemented:
- New optional field: creator can attach postcard photos to a letter, 1–5 of them
  (0 is also valid — the feature is fully optional).
- Two ways to add a photo: upload an image file, or paste an external image URL.
- Uploaded files are read client-side with `FileReader`, decoded into an `<img>`, downscaled
  on a `<canvas>` to a max 900px edge, and re-encoded as JPEG at quality 0.75 before being
  stored — keeps each photo to roughly 100-300KB so a handful of them stay well inside the
  storage layer's per-key size limit.
- Creator view: thumbnail grid with a remove button per photo, a "N / 5 photos" counter, and
  an upload/URL row that disables itself once 5 photos are attached ("Postcard full").
- Recipient view: if the letter has any photos, a postcard-style viewer appears on the letter
  screen (rotated photo with a white border, prev/next arrows and a "1 of N" counter when
  there's more than one). If the letter has zero photos, nothing related to photos renders —
  no empty state, no placeholder.
- Photos are stored as part of the same letter JSON blob as the message and playlist, so the
  existing save/share/load-by-code flow covers them with no changes to that mechanism.

Files changed:
- `index.html` (`state.letter.photos` array added; `MAX_PHOTOS`/`PHOTO_MAX_DIM`/
  `PHOTO_QUALITY` constants; `compressImage`, `addPhotoFile`, `addPhotoUrl`, `removePhoto`,
  and `renderPostcard` functions added; `renderLetter` updated to include the postcard
  section and any photo-related error; backward-compat guard added when loading an older
  saved letter that predates this field, so `photos` defaults to `[]` instead of throwing)
- `plan.md` (product goal, core flows, prototype implementation, and out-of-scope sections
  updated to describe the photo feature and its storage tradeoffs)

Important architectural decisions:
- No enforced minimum beyond "at least one, if you choose to add any at all" — since adding
  a single photo already satisfies "at least one," no separate minimum-count validation was
  needed; the cap only needs an upper bound (`MAX_PHOTOS = 5`).
- Chose client-side downscaling over storing the original file size, given the storage layer
  used for this prototype (`window.storage`) caps how much can be written per key and has no
  concept of separate binary/object storage — this is explicitly called out in `plan.md` as
  something a production build should replace with real object storage instead of inlining
  images as base64.

Tests performed:
- Manual: created a letter with 0 photos, saved, reloaded by code as recipient — confirmed no
  postcard section appears anywhere on the letter screen.
- Manual: added 1 photo via file upload, confirmed it appears for the recipient with no
  prev/next controls (single photo).
- Manual: added photos up to 5, confirmed the 6th is blocked and the upload control shows
  "Postcard full" and disables.
- Manual: removed a photo as creator and confirmed the counter and thumbnail grid update.
- Manual: added a photo via pasted URL alongside an uploaded file, confirmed both display
  correctly for the recipient.

Problems encountered: none.

Known limitations:
- Same as Phase P0/P1, plus: photos are base64-inlined in the same JSON blob as the rest of
  the letter, so very large source images (before downscaling) could still be slow to
  process in-browser, and there's no server-side validation of file type/size beyond the
  client-side check.

Next steps: none pending from this change; open items remain the production-build gaps in
`plan.md` (real object storage, routable share URLs, server-side authorization).

---

## Phase P3 — Local/VS Code portability fix

Date: 2026-09-10

Status: Complete

What was implemented:
- The save/share mechanism called `window.storage` directly, which only exists inside
  Claude's own artifact preview. Opened as a plain file or through a local dev server (the
  VS Code use case), `window.storage` is undefined and saving a gift threw an error.
- Added a small `storage` wrapper at the top of the script: it uses `window.storage` when
  present, and otherwise falls back to an equivalent implementation backed by
  `localStorage` (same `get`/`set`/`delete`/`list` shape, wrapped in Promises to match).
  All calls in the app now go through `storage.*` instead of `window.storage.*` directly.

Files changed:
- `index.html` (`storage` wrapper added near the top of the script; the two direct
  `window.storage.get`/`window.storage.set` call sites updated to use it)
- `plan.md` (share-mechanism description updated to mention the fallback and its limits)

Important architectural decisions:
- The `localStorage` fallback is scoped to one browser on one machine — a code created
  while testing locally will only resolve in that same browser, not across devices. This is
  intentional and documented, not a bug: it exists purely so the file is runnable/testable
  outside claude.ai, not as a substitute for real shared storage.

Tests performed:
- Manual: verified JS syntax parses cleanly after the change (`new Function(...)` on the
  extracted script contents).
- Manual reasoning check: confirmed both `window.storage` and the `localStorage` fallback
  are called with the same argument shape and return shape, so no other code needed to
  change.

Known limitations: same as Phase P0–P2, plus the `localStorage` fallback's single-device
scope noted above.

Next steps: none pending from this change.

---

## Visual Theme Update — Color Palette & Typography

Date: 2026-09-09

Status: Completed

Changes implemented:

- Background changed to #eedec8
- Main text changed to #606c38 and made bold
- Secondary text changed to #ac6b73
- Buttons changed to #4d0e12
- Accent elements changed to #a5bcd6
- Main font changed to Celandine

Files changed:

- `index.html` (only file with code changes: `<style>` theme tokens and color rules,
  `body`/input `font-family` stacks, two inline `h3` color strings, tonearm SVG
  fill/stroke colors, plus `@font-face` rules for `fonts/celandine-regular.woff2` and
  `fonts/celandine-bold.woff2`)
- `plan.md` (added "Visual Theme Update" section; existing plan content preserved)
- `devlog.md` (this entry)

Testing performed:

- Verified no legacy palette hex remains: searched for all old tokens
  (`#cbb794`, `#e6d9c2`, `#b7a887`, `#8a7a63`, `#f0e5d0`, `#3a3226`, `#6b5b4a`,
  `#2a241c`, `#241f18`, `#c98a5e`, `#b23a2e`, `#8f2c22`, `#141210`, `#e7c88a`,
  `#c9a24a`, `#1b1712`, `#fdf3e7`, `#e08a7a`, `#fffaf0`) — zero matches.
- Verified new palette is applied: `#eedec8` (7 uses), `#606c38` (16), `#ac6b73` (18),
  `#4d0e12` (6), `#a5bcd6` (10), `Celandine` (6 references).
- JS syntax check passed: extracted the inline `<script>` and parsed it with
  `new Function(...)` via Node — no errors (logic untouched, only color strings edited).
- Confirmed no layout/functionality edits: diff limited to color values, `font-family`
  stacks, `@font-face` addition, and `font-weight` bold on main-text selectors
  (`h1/h2/h3`, `.brand`, `.now-playing .title`, `.track .meta .t`, `.letter-readonly`,
  share-code); sizes, spacing, positioning, animations, and JS logic unchanged.
- Button readability: button backgrounds `#4d0e12` keep light `#eedec8` text; ghost
  buttons use `#606c38` text on transparent with `#ac6b73` borders.
- No test runner/linter exists in this repo (single static file), so no automated suite
  was run. No live browser pass was available in this environment.

Issues encountered:

- None from the recolor itself. The old theme was dark-mode (dark backgrounds, light
  text); every light-on-dark rule had to be remapped to dark-on-light (`#606c38` /
  `#ac6b73`) since the new background is light, otherwise text would have been
  unreadable. Dark card surfaces (`#241f18`, `#2a241c`) were moved to `#fbf4e2` with
  `#a5bcd6` borders to preserve hierarchy.

Known limitations:

- Celandine font file is NOT bundled: the repo contains no font assets, and Celandine
  is a commercial font not available on Google Fonts or any reliable free CDN (web
  search confirmed paid/blackletter and handwritten listings only, no trustworthy
  hotlinkable source). The site declares `font-family: 'Celandine', Georgia, serif` plus
  `@font-face` rules for `fonts/celandine-regular.woff2` /
  `fonts/celandine-bold.woff2`, so placing licensed files there enables the real font
  with no code change — but until then browsers render the Georgia/serif fallback. This
  is a documented limitation, not a silent substitution.
- `fonts/` directory does not exist yet; it is only referenced by the `@font-face`
  `src` URLs above.

Next steps:

- Drop licensed Celandine files into `fonts/` (or wire a licensed webfont URL) and do a
  visual pass in a real browser across home → code → envelope → letter → vinyl → saved
  screens, checking headings, subtext, buttons, links, forms, and console errors.

---

## Letter Frame & Title Update

Date: 2026-09-10

Status: Completed (code complete; one manual asset step remains — see Known issues)

Changes:
- Removed both existing "A Letter For You" text lines.
- Added the provided frame image.
- Added "My Love For You" inside the frame.
- Applied IM FELL English font.
- Applied bold + italic styling.
- Preserved the existing website structure and functionality.

Files changed:
- `index.html` (head: Google Fonts links for `IM Fell English` italic; style: new
  `.title-frame` / `.title-frame-img` / `.title-frame-text` rules; `renderHome()`
  rewritten to render the frame image + overlaid title instead of the `.brand` div and
  `h1`; no other screens or logic touched)
- `plan.md` (added "Letter Frame & Title Update" section; existing plan preserved)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed: extracted inline `<script>`, parsed with `new Function(...)`
  via Node — no errors.
- Grep of the `renderHome()` block: no remaining "A Letter For You" / "A letter for you"
  (both lines gone); `frame.png` referenced once; "My Love For You" present.
- Grep of whole file: remaining "A Letter For You" hits are only the `<title>` tab text
  and other screens' labels (enter-code, envelope, vinyl top-bar, saved) plus the
  recipient letter's small `readonly-tag` — all intentionally preserved as outside the
  target section.
- Confirmed CSS keeps frame proportions (`width:100%; height:auto`, no cropping) and the
  title is centered inside the frame (absolute `inset:0` flex overlay with 15% side
  padding); text color `#606c38` matches the site's main-text palette for readability.
- No test runner/linter exists in this repo; no live browser pass was available here, so
  visual rendering, webfont download, and console-error checks still need a real browser.

Known issues:
- `frame.png` is NOT in the repo (verified: project dir contains only `index.html`,
  `plan.md`, `devlog.md`). The attached frame picture could not be written to disk from
  this session, so the `<img src="frame.png">` will 404 until the provided frame picture
  is saved as `frame.png` next to `index.html`. No CSS recreation of the frame was made,
  per instructions.
- `IM Fell English` on Google Fonts ships only regular 400 + italic 400 (no bold
  weight), so `font-weight:bold` renders as browser-synthesized bold on top of the real
  italic. The typeface itself is the genuine IM FELL English webfont, not a substitute;
  it requires internet access to load.

---

## Follow-up — Center home description paragraph

Date: 2026-09-10

Status: Completed

Changes:
- Home screen description paragraph ("Write a personal letter...") is now horizontally
  centered with the framed title: added `margin-left:auto; margin-right:auto` to
  `.home-card p` in `index.html` (one-line CSS change; the `max-width:440px` box was
  previously left-aligned inside the centered card).

Files changed:
- `index.html` (single CSS rule)

Testing:
- Verified the rule text and re-parsed the inline script via Node — no errors.

---

## Corner vine picture (top-right)

Date: 2026-09-10

Status: Completed (code complete; one manual asset step remains — see Known issues)

Changes:
- Added the provided vine/flower picture to the top-right corner of the website.
- Used the provided picture as-is (referenced file, not a recreation).
- Positioned fixed top-right on all screens; sized down (max 168px, 76px on mobile)
  with `height:auto` so proportions are preserved and existing content is not covered.
- Made it non-interactive (`pointer-events:none`, decorative `alt=""`) so text,
  buttons, navigation, and animations are unaffected.
- Preserved everything else (layout, colors, fonts, content, functionality).

Files changed:
- `index.html` (one `<img>` tag after `#app`; new `.corner-vine` CSS rule + one small
  mobile media query; no JS or other rules touched)
- `plan.md` (added "Corner Vine Picture" section; existing content preserved)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — untouched, no errors).
- Confirmed the `<img>` tag, CSS rule, and `corner-vine.png` reference are present.
- Confirmed placement logic: `position:fixed; top:0; right:0`, `height:auto` (no
  distortion), `pointer-events:none` (no overlap interference), `z-index:2` above the
  background dot pattern but non-blocking.
- No test runner/linter exists in this repo; no live browser pass was available here,
  so on-screen rendering and console-error checks still need a real browser once the
  image file is in place.

Known issues:
- `corner-vine.png` is NOT in the repo (verified via `Test-Path`: False). The attached
  picture could not be written to disk from this session, so the image will 404 until
  the provided vine picture is saved as `corner-vine.png` next to `index.html`.

---

## Follow-up — Larger corner vine fitted to the corner

Date: 2026-09-10

Status: Completed

Changes:
- Enlarged the corner vine and anchored it flush to the window corner: `.corner-vine`
  in `index.html` is now sized by height (`height:min(52vh,460px); width:auto`, 32vh on
  screens ≤560px wide) instead of the previous small width cap, so the tall vine drapes
  down from the top-right corner at natural proportions (`top:0; right:0; margin:0`).
  Still non-interactive (`pointer-events:none`).

Files changed:
- `index.html` (one CSS rule + media query updated)

Testing:
- Verified the updated rule text and re-parsed the inline script via Node — no errors.
  Visual check still needs a real browser once `corner-vine.png` is in place.

---

## Follow-up — Corner vine back to 0 degrees

Date: 2026-09-10

Status: Completed

Changes:
- Straightened the corner vine back to 0 degrees (was 30): `transform:rotate(0deg)` on
  `.corner-vine`, so it hangs straight down from the corner.
- Bottom leaf clipped by the window's right edge: tilt increased to `rotate(20deg)`
  (still pivoting on the stem tip), swinging the lower vine further left into the
  viewport so the whole vine, including the bottom leaf, is fully visible.
- Rooted the vine in the corner: offset to `top:-26px; right:-34px` so the stem tip
  slides behind the window edge and the vine reads as growing out of the corner.
- Corrected the anchor point: the stem tip sits near the top-center of the image, not
  its top-right corner, so the image is now shifted right with
  `transform:translate(40%,0)` (plus `top:-34px`) to place the marked stem tip itself
  exactly in the window's top-right corner.
- Untucked the stem tip per request: `top` back to `0` so the marked tip stays fully
  visible, sitting right at the window corner rather than hidden behind the edge.
- Slight clockwise tilt so the whole vine shows: `rotate(12deg)` pivoting on
  `transform-origin:55% 0` (the stem tip itself), so the tip stays pinned in the
  corner while the vine body swings left into full view.
- Closed the corner gap (spotted at 100% zoom): the picture has transparent padding
  above the visible stem, so `top` is now `-16px` (hides only empty padding, stem
  fully visible) and the horizontal shift nudged to `translate(45%,0)` to seat the
  stem tip flush in the window corner.
- Reverted the `-16px` lift: it hid the stem tip (the tip sits at the image's top
  edge, no padding there), so `top` is back to `0` and the full stem is visible.

---

## Corner vine picture (top-left, mirrored)

Date: 2026-09-10

Status: Completed (code complete; one manual asset step remains — see Known issues)

Changes:
- Added the second provided vine picture to the top-left corner as a mirror of the
  right vine: same sizing, same decorative non-interactive treatment, flipped tilt
  (`rotate(-20deg)` pivoting on the new stem tip at `transform-origin:45% 0`) so the
  tip sits in the top-left corner and the body swings into full view.

Files changed:
- `index.html` (one new `<img>` referencing `corner-vine-left.png`; new
  `.corner-vine-left` CSS rule; shared mobile sizing already covered by `.corner-vine`)
- `plan.md` (added "Corner Vine Picture (Top-Left, Mirrored)" section)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — untouched, no errors).
- Confirmed both `<img>` tags and both CSS rules are present; mobile `32vh` sizing
  applies to the left vine through the shared `.corner-vine` class.
- No live browser pass was available here; on-screen check needs a real browser once
  the image file is in place.

Known issues:
- `corner-vine-left.png` is NOT in the repo (verified via `Test-Path`: False). Save
  the second provided vine picture as `corner-vine-left.png` next to `index.html`.

---

## Cursor-following image cluster (landing page)

Date: 2026-09-10

Status: Completed (code complete; manual asset step remains — see Known issues)

Changes:
- Added a 6-image cursor-following cluster shown only on the landing view before
  either option ("Create a letter" / "I received a gift code") is selected.
- 6 separate `<img>` tags (`cursor-1.png` … `cursor-6.png`, exact provided pictures,
  not placeholders, not combined), each with natural proportions and its own offset
  within the cluster; smooth lagged follow plus a subtle staggered float.
- Cluster hides immediately on hover over either landing button and never appears on
  subsequent screens or transitions.
- Existing website untouched (layout, colors, fonts, buttons, flows, backend).

Files changed:
- `index.html` (CSS: `.cursor-cluster`/`.cc1`–`.cc6` rules reusing the `bob` keyframe;
  HTML: static `#cursorCluster` div after the corner vines; JS: rAF lerp loop +
  delegated hover listeners reading `state.view` — no existing functions modified)
- `plan.md` (added "Cursor-Following Image Cluster" section; existing content preserved)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no errors).
- Verified: cluster div present, 6 `cursor-N.png` references, all `.cc1`–`.cc6` rules,
  both landing button labels intact, `.home-card .btn` hover hook present.
- Logic trace (no live browser available here): loop toggles `.on` only when
  `state.view==='home'` + mouse seen + no button hover; any navigation changes the
  view so the cluster hides on destination screens. `pointer-events:none` throughout,
  so buttons stay clickable; `prefers-reduced-motion` hides the cluster.
- Needs a real-browser pass once images are in place: smooth trailing, separation of
  the 6 pictures, hide-on-hover for both buttons, no console errors.

Known issues:
- `cursor-1.png` … `cursor-6.png` are NOT in the repo (verified: no `cursor-*.png`
  files on disk). The 6 attached pictures could not be written from this session, so
  the cluster renders empty until they are saved as `cursor-1.png` … `cursor-6.png`
  next to `index.html`, in the order shown in the request (knight-errant,
  rabbit-trumpeter, mounted knight, lady, sun, bow).

---

## Follow-up — Cascading trail motion

Date: 2026-09-10

Status: Completed

Changes:
- Reworked the follow motion from a rigid cluster into a cascading trail: each picture
  now lerps toward the previous picture's live position (`ccChain` order 0→1→2→5→4→3
  with per-link lag 0.20→0.08), so the six images snake behind the cursor like a trail
  while moving and settle into a spread formation (min 79px apart, all 52–64px wide —
  verified separated, never stacked) at rest. Slight per-image tilts (-6°…+5°) kept.
- Removed the CSS `bob` float from cluster images (it animates `transform` and would
  fight the per-frame JS positioning); motion is now purely JS-driven.
- Hover-hide, home-view gating, reduced-motion handling, and all existing code paths
  unchanged.

Files changed:
- `index.html` (`.cc` CSS rules; `ccOff`/`ccChain` cascade in the `ccLoop`)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no errors).
- Ran a Node motion simulation of the exact loop math (cursor jump, 150 frames): trail
  snakes smoothly behind the cursor with no jumps, and settles with 79px minimum
  pairwise separation. An earlier offset set collapsed two images to ~19px apart and
  was replaced before shipping.

---

## Envelope decorative pictures (marked spots + hover slide)

Date: 2026-09-10

Status: Completed (code complete; same pending image-file step as the landing cluster)

Changes:
- Placed the 6 provided pictures at the six screenshot-marked spots around the
  envelope (top-left/center/right, bottom-left/center/right), reusing the exact
  `cursor-1.png` … `cursor-6.png` files — no placeholders, no combining, proportions
  preserved, each visually separate.
- Added an independent per-picture hover slide: +12px sideways on hover, smooth
  quarter-second return on leave; no disappearing, rotating, or distortion.
- Applies to the shared envelope screen (creator and recipient flows).

Files changed:
- `index.html` (`renderEnvelope()` appends six `span.env-spot` anchors; new
  `.env-spot`/`.env-pic` CSS incl. hover rule, mobile size, reduced-motion guard)
- `plan.md` (added "Envelope Decorative Pictures" section; existing content preserved)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no errors).
- Verified: 6 spots wired in `renderEnvelope()` using `cursor-1..6.png`, envelope
  open/hint logic intact, 6 `pos-*` CSS rules + hover rule present, no other render
  functions modified.
- Needs a real-browser pass once images are in place: exact spot alignment vs the
  screenshot, smooth per-picture slide and return, no overlap with the envelope tap
  target, no console errors.

Known issues:
- Same as the landing cluster: `cursor-1.png` … `cursor-6.png` are still not on disk,
  so both the landing trail and these envelope pictures render empty until the 6
  provided pictures are saved next to `index.html`.

---

## Follow-up — Envelope pictures larger + envelope-anchored alignment

Date: 2026-09-10

Status: Completed

Changes:
- Enlarged the six envelope pictures from ~56–88px to ~88–128px
  (`width:clamp(88px,14vw,128px)`, proportions preserved).
- Fixed alignment properly: pictures were positioned against the full screen so they
  drifted relative to the envelope on different window sizes; they are now anchored
  to the envelope itself through a relatively positioned `.envelope-stage` wrapper
  (pixel offsets from the envelope's edges: sides ±120px, top/bottom centers 104px
  out), keeping the screenshot's 3-over-3 arrangement on any viewport.
- Small screens (≤560px): tighter offsets, 60px pictures, and an `overflow-x:clip`
  guard on `.screen` so edge pictures never cause sideways scrolling. Hover slide,
  reduced-motion guard, and envelope behavior unchanged.

Files changed:
- `index.html` (stage wrapper in `renderEnvelope()`; `.envelope-stage`/`.env-spot`/
  `.env-pic` CSS reworked)
- `plan.md` (follow-up noted; existing content preserved)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no errors).
- Verified: stage wraps envelope + 6 spots, envelope open/hint logic intact, new
  sizes/offsets and hover rule present.
- Needs a real-browser pass: size balance and alignment around the envelope at
  desktop and mobile widths, no console errors.

---

## Background color change to #fdedad

Date: 2026-09-10

Status: Completed

Changes:
- Website background changed from `#eedec8` to `#fdedad` (`--bg` and `--paper` tokens
  in `index.html`, covering page, app container, letter sheet, and envelope peek).
- `--paper-dark` (ruled-line shade) adjusted to `#dfd198` to match the new background.
- Light-on-dark accents keep the old `#eedec8` cream (button text, play button, seal,
  photo-remove, record hole) to preserve contrast — backgrounds only, nothing else.

Files changed:
- `index.html` (two theme tokens + one derived shade)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — untouched, no errors).
- Confirmed `#fdedad` flows into body/app/letter via the tokens; no other rules touched.

---

## Picture-based envelope → letter sequence

Date: 2026-09-10

Status: Completed (code complete; manual asset step remains — see Known issues)

Changes:
- Replaced the CSS-drawn envelope (flap/seal/peek divs + related CSS, all removed)
  with the 3 provided pictures: closed state shows `envelope-closed.png`, click swaps
  to `envelope-open.png` with a smooth fade, the open state holds for the existing
  brief ~1.25s pause, then the existing `unfold` transition leads to the letter page —
  full sequence: Closed → Click → Open → Pause → Letter.
- Letter page: `letter-page.png` renders as the paper (natural aspect ratio) with the
  writing area (composer textarea / read-only message + existing labels) in a
  `.letter-writing` overlay inside the lace frame's inner area. Applies to creator
  and recipient views.
- Hover preserved: envelope hover is now a 12px max horizontal slide (`.35s`, smooth
  return, no vertical motion) per the existing pictures' spec; the 6 decorative
  pictures' 12px hover is untouched. Click/keyboard/focus behavior and all other
  flows unchanged.

Files changed:
- `index.html` (envelope CSS replaced with `.env-img` states + `env-fade`;
  `renderEnvelope()` renders the two picture states; `.letter-sheet` CSS reworked to
  picture + `.letter-writing` overlay; `renderLetter()` builds picture + overlay)
- `plan.md` (added "Picture-Based Envelope → Letter Sequence" section)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no errors).
- Verified: closed/open/letter-page refs present, dead CSS-drawing selectors gone,
  1250ms open-state pause intact, 12px horizontal hovers intact, composer/read-only
  labels and flow texts intact.
- Needs a real-browser pass once images are in place: closed→open→pause→letter
  sequence, writing-area fit inside the lace frame, proportions, hover smoothness,
  no console errors.

Known issues:
- `envelope-closed.png`, `envelope-open.png`, `letter-page.png` are NOT in the repo
  (nothing to save them from in this session). Save the 3 supplied pictures next to
  `index.html` using exactly these names: closed = the embossed-flap envelope (3rd
  picture), open = the envelope with the lace card (2nd picture), letter page = the
  lace frame (1st picture).
- Background note: in the supplied previews the open-envelope and lace-frame pictures
  appear on black. If the actual files have transparent backgrounds, they will blend
  with the site as intended; if the black is baked into the files, it will show as
  black boxes and transparent versions will be needed — flagged for the browser pass.

---

## Bugfix — Open envelope vanishing + empty letter page

Date: 2026-09-10

Status: Fixed and verified with headless-Chrome screenshots

Root causes found (reproduced end-to-end in headless Chrome, real app render path):
1. `letter-page.png` 404: the file was saved on disk as `lace frame.png` (with a
   space), so the paper image never loaded. With the image collapsed to zero height,
   the absolutely positioned writing overlay had no box to sit in — the entire
   letter content was invisible. After the 1.25s open-envelope pause the user landed
   on an apparently empty page, i.e. "the whole open envelope disappears". Fixed by
   renaming `lace frame.png` → `letter-page.png`.
2. Weak open-state composition: the open picture (421×593, mostly transparent padding)
   rendered small inside a tall box-shadow rectangle, looking like a fading ghost
   next to the bold closed envelope. Fixed with an alpha-following
   `filter:drop-shadow()` (shadow hugs the artwork, no empty box) and compact
   centered sizing (`max-height:46vh`, `width:auto`, `margin:auto`).
3. Polish: writing overlay top inset 6% → 8% so the "Your letter" label clears the
   lace border.

Files changed:
- `index.html` (`.env-img` shadow → drop-shadow; open-state sizing; overlay inset)
- `letter-page.png` (renamed from `lace frame.png`; same bytes, no content change)
- `plan.md` / `devlog.md` (this entry)

Testing:
- JS syntax check passed (inline script re-parsed via Node — no logic changes).
- Pixel-checked all three PNGs (magic bytes + alpha sampling): open/letter files are
  properly transparent, closed is full-bleed opaque — artwork files themselves are good.
- Headless-Chrome screenshots of the real render path, before and after: open state
  now shows a compact centered envelope with artwork-hugging shadow; letter state
  now shows the lace paper with the writing box inside the frame.
- Temp repro/test pages used for verification were deleted; project dir is clean.

---

## Follow-up — New open envelope matched to closed size

Date: 2026-09-10

Status: Completed and verified with headless-Chrome screenshots

Changes:
- New `envelope-open.png` detected on disk (181KB, 421×593 portrait, transparent
  corners intact, artwork now fills the frame edge-to-edge vs the old version's
  padding-heavy composition).
- Removed the previous compact constraint on the open state (`max-height:46vh`,
  `width:auto`, auto margins): both envelope states now share the identical sizing
  rule (`width:100%; height:auto` from `.env-img`), so open renders at the same
  width as closed with each keeping its natural aspect ratio — same size,
  proportionate, no distortion, no width jump on click.

Files changed:
- `index.html` (one CSS rule simplified)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshots of both states side by side: closed (landscape) and
  open (portrait) render at equal width, both prominent and balanced with the
  decorative pictures; fade, pause, hover, and letter flow untouched.
- Temp comparison page deleted; project dir clean.

---

## Follow-up — Larger envelope (400px)

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot

Changes:
- Envelope wrap widened `min(80vw,320px)` → `min(84vw,400px)`: both closed and open
  states scale up together (shared sizing rule, natural aspects kept), so the
  envelope now has real presence instead of looking small/far. Decorative spots stay
  anchored via the stage; mobile grows only slightly (84vw) with the existing
  overflow guard.

Files changed:
- `index.html` (one CSS width value)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot of the open state: envelope prominent and centered,
  shadow hugging the artwork, decorative pictures balanced around it.
- Temp test page deleted.

---

## Floral pattern overlay (replaces CSS lace)

Date: 2026-09-10

Status: Code complete; needs the image file + a visual pass (see Known issues)

Changes:
- Removed the CSS lace gradient stack from `body` (plain `var(--bg)` background again).
- Added the provided floral scrollwork picture as a true overlay: a fixed
  full-viewport `.floral-overlay` div (direct `<body>` child) tiling
  `floral-overlay.png` at 560px wide, `opacity:.45`, `pointer-events:none`,
  `z-index:0` — above the background, below all content (screens z-1, vines z-2,
  cluster z-3), so it textures the page without touching readability or clicks.

Files changed:
- `index.html` (body rule reverted; `.floral-overlay` CSS + div)
- `plan.md` / `devlog.md` (this entry)

Testing:
- JS syntax check passed (no JS changes). Verified lace gone, overlay wired below
  content and non-interactive.
- No screenshot possible yet: `floral-overlay.png` is not on disk, so the overlay
  renders nothing until the file is saved.

Known issues:
- `floral-overlay.png` NOT in the repo. Save the provided floral picture as
  `floral-overlay.png` next to `index.html`. After that, check density/scale in a
  real browser — if the tile seams show or it feels too strong/large, the fix is
  one line (`background-size` / `opacity` in `.floral-overlay`); tell me what you see.

---

## Follow-up — Overlay softened (larger tile, lower opacity)

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot

Changes:
- Floral overlay softened as approved: tile `560px` → `780px` wide (larger,
  sparser motif), `opacity` `.45` → `.30`. Paragraph and ghost-button readability
  confirmed improved against the pattern; motif still clearly present.

Files changed:
- `index.html` (one `.floral-overlay` rule)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot of the home screen: texture calm, text/buttons
  readable, vines/frame/pictures intact. Temp test page deleted.

---

## Removal — Leftover dot-grain overlay

Date: 2026-09-10

Status: Completed and verified with a 2x-scale headless-Chrome screenshot

Changes:
- Removed the `.app::before` 3px dot grid (a film-grain leftover from the old dark
  theme, remapped to faint olive during the palette change). Invisible at 100% but
  showing as dotted pixels when zoomed in. Deletion only; nothing else touched.

Files changed:
- `index.html` (one CSS rule removed)
- `devlog.md` / `plan.md` (this entry)

Testing:
- 2x-scale headless-Chrome screenshot: dot grid gone, floral overlay smooth, text
  crisp. Temp test page deleted.

---

## Fix — Envelope centered + pictures ring (sun off the hint text)

Date: 2026-09-10

Status: Fixed and verified with rect measurements + headless-Chrome screenshot

Root causes:
1. The six pictures sat too tight (±120/±104px), so the sun overlapped the
   "Click to begin your letter" hint. Spread to a wider symmetric ring (sides
   ±160px, top −90/−140px, bottom −90/−160px).
2. Real bug: `.env-spot` anchors had size (they shrink-wrapped the in-flow image),
   so `bottom:`/`right:`-anchored pictures were offset by the span size — measured
   the sun 105px above its intended point. Fixed with `width:0;height:0` on the
   spots so every picture centers exactly on its anchor point.
3. Safety: `.screen` uses `justify-content:safe center` so a taller-than-viewport
   composition can never clip its top out of reach (falls back to top-aligned
   where unsupported).

Verification (1280×900 headless Chrome, live rects): envelope x 432–832 (page
center 632 ✓ dead-center); side pictures 96px clear of the envelope, symmetric;
sun y 652–758 vs hint ending y 573 (79px clear ✓). Final screenshot confirms a
balanced ring with the envelope in the middle.

Files changed:
- `index.html` (spot offsets, zero-size anchors, `safe center`)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshots (two iterations) + DOM rect measurement. Temp test
  pages deleted; project dir clean.

---

## Follow-up — Sun raised into 100%-zoom view

Date: 2026-09-10

Status: Completed and verified (rects + screenshot at 1280×720)

Changes:
- Sun (`pos-bc`) raised `bottom:-160px` → `-110px`: it was falling below the fold
  on 100%-zoom laptop windows. Now sits ~29px below the hint text (measured:
  hint ends y483, sun spans y512–618) — fully visible, still clearly separated.

Files changed:
- `index.html` (one offset value)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Live rect measurement + headless-Chrome screenshot at 1280×720: sun fully
  on-screen, daylight between it and the hint, ring and centering otherwise
  unchanged. Temp test page deleted.

---

## Follow-up — Lady raised into 100%-zoom view

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot at 1280×720

Changes:
- Lady (`pos-bl`) raised `bottom:-90px` → `-70px` so she sits fully inside a
  100%-zoom window. Ring balance and clearances otherwise unchanged.

Files changed:
- `index.html` (one offset value)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot at 1280×720: lady fully visible, composition
  balanced. Temp test page deleted.

---

## Follow-up — Rabbit lowered into 100%-zoom view

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot at 1280×720

Changes:
- Rabbit trumpeter (`pos-tc`) lowered `top:-140px` → `-120px`, clear of the brand
  above and the envelope below.

Files changed:
- `index.html` (one offset value)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot at 1280×720: rabbit whole and clear. Temp test page
  deleted.

---

## Follow-up — Lady and mounted knight swapped

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot at 1280×720

Changes:
- Traded places: lady (`cursor-4.png`) now top-right, mounted knight (`cursor-3.png`)
  now bottom-left. Spot positions/sizes unchanged.

Files changed:
- `index.html` (two `src` values in `renderEnvelope()`)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot: lady top-right, knight bottom-left, both whole,
  ring balanced. Temp test page deleted.

---

## Follow-up — "Your letter" label removed + italic composer

Date: 2026-09-10

Status: Completed

Changes:
- Removed the "Your letter" meta label from the creator's letter page (element
  deleted from `renderLetter()`; recipient's "A letter for you" tag untouched).
- Creator's writing now italic: `font-style:italic` on `.letter-sheet textarea`.

Files changed:
- `index.html` (one element removed, one CSS declaration added)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed. Confirmed no "Your letter" text remains in `index.html`
  and the textarea rule carries `font-style:italic`.

---

## Follow-up — Pink composer text + visible placeholder

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot

Changes:
- Composer font color → pink accent `#ac6b73` (was main-text olive).
- Placeholder was browser-default gray at half opacity, washing out on the lace —
  added `.letter-sheet textarea::placeholder{color:#ac6b73;opacity:1}` so "Write
  your letter here..." sits clearly on top of the paper. Writing overlay was
  already stacked above the paper image (absolute over static); color was the
  visibility blocker.

Files changed:
- `index.html` (textarea color + new `::placeholder` rule)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot of the creator letter page: pink placeholder crisp
  and readable inside the lace frame. Temp test page deleted.

---

## Follow-up — Writing area moved onto the white paper

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot

Changes:
- Pixel-sampled `letter-page.png`: center-top lace detail settles to plain paper
  around y≈60–75 of 593, so the overlay top moved `8%` → `15%` (past the central
  medallion) and bottom `6%` → `8%` for margin — writing now starts and stays on
  the plain white inner area, not the lace. Sides unchanged at 19%.

Files changed:
- `index.html` (`.letter-writing` insets)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot: placeholder fully on the white inner paper, clear
  of the lace border. Temp test page deleted.

---

## Removal — "Scroll down" cue

Date: 2026-09-10

Status: Completed

Changes:
- Removed the "scroll down" cue from the letter screen (`renderLetter()` element
  plus its now-unused `.scroll-cue` CSS, `::before` arrow, `bob` keyframes, and
  reduced-motion line). Continue button and everything else untouched.

Files changed:
- `index.html` (element + dead styles removed)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed. Confirmed zero `scroll-cue`/`scroll down` references
  remain in `index.html`.

---

## Follow-up — Smaller "Continue to the music" button

Date: 2026-09-10

Status: Completed

Changes:
- Letter-screen continue button downsized via inline style (`font-size:13px`,
  `padding:9px 20px` vs base `15px`/`12px 26px`) plus `margin-top:18px` to keep
  the breathing room the removed scroll cue used to provide. Shared by creator
  ("Continue to the music") and recipient ("Continue to the record") labels.

Files changed:
- `index.html` (one button's style)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed.

---

## Bottom-right corner picture (knight border)

Date: 2026-09-10

Status: Code complete; needs the image file + alignment check (see Known issues)

Changes:
- Added the provided knight-border picture pinned to the bottom-right window corner:
  `.corner-bottom-right` (`position:fixed; bottom:0; right:0`) so the picture's
  corner tip sits exactly in the website corner, sized large like the top vines
  (`height:min(52vh,460px)`, 32vh on ≤560px screens), natural proportions
  (`width:auto`), non-interactive (`pointer-events:none`, decorative `alt=""`),
  `z-index:2` with the vines.

Files changed:
- `index.html` (`.corner-bottom-right` CSS + `<img src="corner-knight.png">`)
- `plan.md` / `devlog.md` (this entry)

Testing:
- JS syntax check passed (no JS changes). Rule and tag verified present.
- No screenshot possible yet: `corner-knight.png` is not on disk.

Known issues:
- `corner-knight.png` NOT in the repo. Save the provided picture as
  `corner-knight.png` next to `index.html`. If the artwork's tip turns out inset
  from the file edge (transparent padding), a small negative offset will seat it
  flush — tell me what you see and I'll nudge it.

---

## Bottom-left corner picture (mirrored knight border)

Date: 2026-09-10

Status: Code complete; needs the image file + alignment check (see Known issues)

Changes:
- Mirrored the bottom-right configuration into the bottom-left corner:
  `.corner-bottom-left` (`position:fixed; bottom:0; left:0`), tip-to-corner, same
  large sizing (`height:min(52vh,460px)`, 32vh mobile), natural proportions,
  non-interactive, `z-index:2`.

Files changed:
- `index.html` (`.corner-bottom-left` CSS + `<img src="corner-knight-left.png">`)
- `plan.md` / `devlog.md` (this entry)

Testing:
- JS syntax check passed (no JS changes). Rule and tag verified present.
- No screenshot possible yet: `corner-knight-left.png` is not on disk.

Known issues:
- `corner-knight-left.png` NOT in the repo. Save the provided (mirrored) picture
  as `corner-knight-left.png` next to `index.html`; same padding caveat as the
  right one — report what you see and I'll seat it flush if needed.

---

## Bottom wave flourish (knights removed)

Date: 2026-09-10

Status: Code complete; needs the image file + placement check (see Known issues)

Changes:
- Removed both knight corner pictures (markup + CSS rules gone).
- Added the provided wave flourish resting along the bottom-right window corner:
  `.corner-wave` (`position:fixed; bottom:0; right:0`), wide sizing
  (`width:min(40vw,440px)`, 56vw on ≤560px screens) with natural proportions
  (`height:auto`), non-interactive, `z-index:2` with the vines.

Files changed:
- `index.html` (knight rules/tags replaced with `.corner-wave` + `<img>`)
- `plan.md` / `devlog.md` (this entry)

Testing:
- JS syntax check passed (no JS changes). Old knight refs confirmed gone, wave rule
  and tag present.
- No screenshot possible yet: `corner-wave.png` is not on disk.

Known issues:
- `corner-wave.png` NOT in the repo. Save the provided wave picture as
  `corner-wave.png` next to `index.html`. The taper tip sits near the file's right
  edge above its bottom — if it doesn't land exactly in the corner, tell me what
  you see and I'll shift it.
- Angled 2026-09-10: `translateY(40%) rotate(-12deg)` about `100% 100%` so the tip
  drops into the corner and the wave sweeps up-left from it. Tip position estimated
  from the preview (~60% file height); needs a screenshot to confirm/fine-tune once
  the file is saved.

---

## Fix — Wave back on-screen, angled from the corner

Date: 2026-09-10

Status: Fixed and verified with a headless-Chrome screenshot

Root cause: the 40% downward shift (meant to pin the taper tip to the corner)
dragged the wave's body — verified by alpha-mapping the real file (666×375, art
spans y 17.6–88%, taper tip at y ~56–63%) — below the viewport, hiding almost the
whole picture. Fix: flush `bottom:0; right:0` seating with a subtle `rotate(-6deg)`
about `100% 100%`, so the full wave stays on-screen, angled, tip essentially at
the corner. Screenshot confirms: wave fully visible bottom-right, sweeping up-left.

Files changed:
- `index.html` (one transform value)
- `devlog.md` / `plan.md` (this entry)

Testing:
- Headless-Chrome screenshot of the home screen: wave fully on-screen and angled;
  overlay, vines, frame, buttons all intact. Temp test page deleted.

---

## Removal — Corner wave taken off

Date: 2026-09-10

Status: Completed

Changes:
- Removed the bottom-right wave flourish: `.corner-wave` CSS rules and the
  `<img src="corner-wave.png">` tag deleted from `index.html`. No other code
  touched. File `corner-wave.png` left on disk (unused).

Files changed:
- `index.html` (wave rule + tag removed)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed (no JS changes). Confirmed no `corner-wave` references
  remain in `index.html`.
- Superseded knight files were left on disk (unused); safe to delete
  `corner-knight.png` / `corner-knight-left.png` if wanted.

---

## Lace texture background

Date: 2026-09-10

Status: Completed and verified with a headless-Chrome screenshot

Changes:
- Full-page tone-on-tone lace lattice in pure CSS (no new assets): layered
  radial-gradients on `body` — soft light medallions, fine dot grain, and concentric
  ring motifs in muted tan over the existing `#fdedad` background, fixed attachment
  so it stays put while screens scroll. `.app` background made transparent so the
  texture shows through the content column too. First pass read as polka dots;
  rebalanced (smaller/softer lights, stronger layered rings) into a delicate
  doily-like lattice per the mockup. Text and controls verified readable over it.
- If a real lace image file is ever preferred, it can replace the gradient stack
  with a one-rule change (not done — no file provided).

Files changed:
- `index.html` (`body` background stack + `.app` transparent)
- `plan.md` / `devlog.md` (this entry)

Testing:
- Headless-Chrome screenshot of the home screen, iterated twice: confirmed subtle
  lace feel, readable text/buttons, vines/frame/pictures unaffected.
- Temp test page deleted; project dir clean.

---

## Follow-up — Brand removed from music page

Date: 2026-09-10

Status: Completed

Changes:
- Removed the "A Letter For You" brand line from the vinyl page top bar
  (`renderVinyl()`). Creator's song counter kept and held in its right-side
  position via `margin-left:auto`; recipient view otherwise unchanged.

Files changed:
- `index.html` (one element removed, one style added)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed.

---

## Follow-up — Provided vinyl picture on the recorder

Date: 2026-09-10

Status: Code complete; needs the image file + playback pass (see Known issues)

Changes:
- Replaced the CSS-drawn disc with the provided picture: `renderVinyl()` now
  renders `<img src="vinyl-record.png">` in the exact disc slot (same 220px
  geometry on the plinth/tonearm recorder, which is untouched).
- Rotation reuses the existing audio-synced machinery untouched: `.spinning`
  (smooth `spin` 2.6s loop) applies while playing, `.paused` when paused/ended/
  idle, toggled by the existing `<audio>` event wiring (`playing`/`pause`/`error`
  + transport controls). Rotation stays centered (square image, default
  transform-origin) and `border-radius:50%` + `object-fit:cover` keep it circular
  at natural proportions with no distortion.
- Removed the now-dead disc-art CSS (groove/label/hole rules).

Files changed:
- `index.html` (`.record` restyled to the picture; one JS element swapped)
- `devlog.md` / `plan.md` (this follow-up entry)

Testing:
- JS syntax check passed. Verified: picture ref present, spin classes/keyframes
  and audio wiring intact, dead disc-art selectors gone.
- Needs a real-browser pass once the file is saved: picture centered on recorder,
  smooth rotation on play, stop on pause/end, no console errors.

Known issues:
- `vinyl-record.png` NOT in the repo at write time. Save the provided cat-vinyl picture as
  `vinyl-record.png` next to `index.html`. Note: the preview shows it on black —
  if that's baked in (not transparency), `border-radius:50%` still crops it to a
  clean circle since the artwork fills the frame; flag any edge artifacts in the
  browser pass.

---

## Doc sync + asset inventory

Date: 2026-09-10

Status: Completed (docs only; no code changes)

Changes:
- Verified all 14 image assets now on disk next to `index.html`
  (`frame.png`, `corner-vine.png`, `corner-vine-left.png`, `cursor-1..6.png`,
  `envelope-closed.png`, `envelope-open.png`, `letter-page.png`,
  `floral-overlay.png`, `vinyl-record.png`). Every earlier "NOT in the repo /
  save the file" Known-issue note is therefore resolved, except the still-open
  real-browser visual/playback passes.
- `plan.md`: rewrote the "Prototype implementation" section to match `index.html`
  (picture-based envelope/letter/vinyl, `#fdedad` background, floral overlay at
  780px/30%, envelope ring with tuned offsets, composer styling, small continue
  button, brand removed from vinyl page); removed the duplicated "Corner Wave
  Taken Off" section; updated the vinyl + lace sections from "needs the file"
  to "file on disk, visual/playback pass still open"; appended a "Doc Sync +
  Asset Inventory" section as the new source of truth.
- `devlog.md` (this entry): fixed a copy-paste tail on the "Background color
  change to #fdedad" entry (a stray "one CSS rule updated / corner-vine.png"
  block from another entry was appended after its Testing section — deleted).

Files changed:
- `plan.md` (implementation section, vinyl/lace sections, duplicate removed,
  sync section appended)
- `devlog.md` (background-entry tail fix + this entry)

Testing:
- Directory listing confirms 14/14 PNGs present with non-zero sizes.
- No code touched, so no JS re-parse needed.

Known issues / flagged (not fixed):
- `renderHome()` copy still reads "add five or more songs" while the enforced
  rule is 1–10 (`MIN_SONGS = 1`, `MAX_SONGS = 10` in `index.html:231-232`) —
  one-string fix when convenient.
- Still open from earlier entries: real-browser passes for the vinyl picture
  (rotation/centering), floral density, and the full home → code → envelope →
  letter → vinyl → saved flow with no console errors.

---

## Follow-up — Home tagline larger + italic

Date: 2026-09-16

Status: Completed

Changes:
- Home screen tagline ("Write a personal letter, add five or more songs, and
  send a keepsake that opens like an envelope and plays like a record.") is
  now a bit larger and italic: 15px → 18px plus `font-style:italic` via a new
  dedicated `.home-card .home-tagline` rule, with `class:'home-tagline'` added
  to that paragraph in `renderHome()`. Wording unchanged per request.
- Scoped to a class (not the shared `.home-card p` rule) so the saved-screen
  paragraph ("Share this code...") keeps its existing 15px non-italic style.

Files changed:
- `index.html` (one CSS rule added, one paragraph given the new class)
- `devlog.md` / `plan.md` (this entry)

Testing:
- JS syntax check passed (extracted inline `<script>`, parsed via Node — no errors).
- No README in repo, so no README update needed.

---

## Follow-up — Home tagline spacing below frame

Date: 2026-09-16

Status: Completed

Changes:
- Tagline paragraph on the home screen ("Write a personal letter, add five or
  more songs, and send a keepsake that opens like an envelope and plays like
  a record.") lowered for decent space below the "My Love For You" frame so
  it does not look cluttered: `.home-card .home-tagline` `margin-top` in
  `index.html` changed `28px` → `42px`. `.title-frame` bottom margin kept at
  `18px`, so total gap is now 60px (14px more than before). Font size (18px),
  italic style, wording, and all other screens untouched.

Files changed:
- `index.html` (one CSS value: `.home-card .home-tagline` margin-top)
- `plan.md` (added "Home tagline spacing below frame" section)
- `devlog.md` (this entry)

Testing:
- JS syntax check passed (extracted inline script, parsed via Node — no errors).
- Verified: `.home-tagline` 42px rule present, 18px italic rule intact, tagline
  text unchanged, frame rule intact, no other selectors touched.

Known issues / next steps:
- None from this change; open items remain production-build gaps in `plan.md`.

---

## Follow-up — Envelope header per role

Date: 2026-09-16

Status: Completed

Changes:
- `renderEnvelope()` (`index.html:527-530`): replaced always-on
  `el('div',{class:'brand',text:'A Letter For You'})` with role-conditional
  header — creator (`state.mode==='creator'`) gets `text:'Write your letter'`
  (same `.brand` styling: 13px uppercase, #606c38, 28px bottom margin),
  recipient gets no brand line (just envelope stage + hint). Implements
  "remove A Letter For You on closed envelope, put Write your letter for
  creator not recipient".

Files changed:
- `index.html` (3 lines: `envelopeNodes` array + conditional push, `screen(envelopeNodes)`)
- `plan.md` (added "Envelope header per role" section)
- `devlog.md` (this entry)

Testing:
- JS syntax: OK (extracted inline `<script>`, `new Function` parse — no errors).
- Verified: envelope slice no longer contains "A Letter For You"; `Write your letter`
  present once conditional on creator; remaining "A Letter For You" hits = 3
  (`<title>`, `renderEnterCode`, `renderSaved`) as expected.
- No asset/config changes.

Known issues / next steps:
- Done; open-envelope stay behavior now logged below.

---

## Follow-up — Open envelope stays with click-to-continue

Date: 2026-09-16

Status: Completed

Changes:
- `openEnvelope()` (`index.html:351-353`): removed `setTimeout 1250ms` auto
  transition `state.view='letter'`; now only `state.envelopeOpen=true; render()`.
- `renderEnvelope()` (`index.html:501-532`): introduced `isOpen` + `goLetter()`
  (`state.view='letter'; render()`). Closed envelope: hint
  "Click to begin your letter" (creator) / "Click to open your gift" (recipient).
  Open envelope: envelope stays (`.env-open` visible, no vanish); bottom
  `env-hint` becomes `class='env-hint clickable'` with `role=button`,
  `tabindex=0`, underline + pointer, click/Enter/Space → `goLetter()`.
  Open hint text is "Click to begin your letter" (creator) /
  "Click to read your letter" (recipient). Wrap gets `open clickable`
  (cursor pointer, slight hover) so clicking the open envelope also continues.
- CSS (`index.html:83-85`): added `.env-hint.clickable` (underline) and
  `.envelope-wrap.open.clickable` (pointer + hover nudge).

Files changed:
- `index.html` (JS: `openEnvelope` timeout removed, `renderEnvelope` rewrite; CSS: 3 rules)
- `plan.md` (added "Open envelope stays" section)
- `devlog.md` (this entry)

Testing:
- JS syntax: OK (`new Function` on inline `<script>` — no errors).
- Verified: no `setTimeout` in `openEnvelope`; `goLetter` present; closed vs
  open hint texts per role correct; `clickable` class on hint and wrap when
  open; keyboard handlers present.

Known issues / next steps:
- None from this change; open-envelope sizing logged next.

---

## Follow-up — Open envelope size proportionate

Date: 2026-09-16

Status: Completed

Changes:
- CSS (`index.html:71-81`): closed envelope `577×432` vs open `421×593` caused
  open to look smaller at equal width. Changed `.envelope-wrap` base
  `width:min(84vw,400px)` → `.envelope-wrap.open` `width:min(90vw,440px)`
  (+10%, smooth `transition: width`), so open picture renders larger and
  proportionate to closed while staying centered in flex `.screen`. Added
  `width:100%` to `.envelope-wrap.open .env-open` for proper fill.
- No JS/asset changes; ring (`.env-spot`) positions unchanged.

Files changed:
- `index.html` (CSS: `.envelope-wrap`, `.envelope-wrap.open`, `.env-open`)
- `plan.md` (added "Open envelope size proportionate" section)
- `devlog.md` (this entry)

Testing:
- JS syntax: OK (parsed inline `<script>` — no errors).
- Verified: base 400px rule present, open 440px rule present, open img
  width:100% present, width transition present, clickable open still works.

Known issues / next steps:
- None from this change; production gaps remain in `plan.md`.

---

## Follow-up — Medieval Keepsake Visual Elevation & Interaction Polish

Date: 2026-09-16

Status: Completed and verified with headless-Chrome CDP screenshot captures

Changes:
- Envelope Stage Spacing & Overlap Resolution:
  - Resolved text collisions on the envelope screen where the top trumpet rabbit
    (`cursor-2.png`) touched "WRITE YOUR LETTER" and the bottom sun (`cursor-5.png`)
    overlapped the unsealing prompt ("Click to begin your letter").
  - Increased `.envelope-stage` margin to `110px auto 45px` (`90px auto 35px` on mobile),
    gave `.env-hint` a generous `margin-top: 95px` (`75px` on mobile), and calibrated
    the top and bottom anchor spots (`pos-tc` top: -75px, `pos-bc` bottom: -65px).
    The six medieval illustrations now form an unobstructed, balanced decorative ring
    framing both closed and open envelope states.
- Tactile Unsealing Feedback:
  - Added acoustic harp chime synthesis using native browser Web Audio API upon opening
    the envelope (zero external dependencies, completely safe fallback).
  - Added golden sparkle particle burst (`spawnSparkles`) radiating outward when unsealed.
- Letter Screen Manuscript Detailing:
  - Added an illuminated drop-cap initial (`.letter-readonly::first-letter`) in deep burgundy
    `#4d0e12` with subtle antique gold shadow (`IM Fell English`), elevating recipient letters
    into authentic medieval storybook manuscripts.
  - Set composer `<textarea>` placeholder to `"Write your letter here upon this parchment..."`.
  - Added filigree ornaments (`✦ A letter for you ✦`) to the recipient letter tag.
- Melodic Vinyl Player & Illuminated Playlist:
  - Upgraded playlist track numbering from Arabic numerals to illuminated Roman numerals
    (`I`, `II`, `III`, `IV`...) via `toRoman()`.
  - Added lively animated mini equalizer sound waves (`.sound-bars`, `.sound-bar`) beside the
    active track title during audio playback.
  - Added floating music notes loop (`startNoteEmitter`) drifting upward around the cat vinyl record.
  - Styled plinth with antique lacquer radial gradient, brass filigree corner brackets, and warm glow.
  - Styled seek and volume sliders with antique brass tracks and ruby jewel thumbs.
  - Neatly framed the creator song counter in an illuminated badge (`.badge`) with balanced clearance.
- Atmospheric Arbor Motion:
  - Added organic ambient swaying keyframes (`vine-breeze-left` / `right`) to fixed corner vines.
  - Added radial parchment vignette behind main content to ensure readability over the floral pattern.
- Identity & Functionality Guarantee:
  - All 14 original PNG artwork assets preserved and reused.
  - All color tokens, flows (Creator and Recipient), audio playback, and storage mechanics kept intact.

Files changed:
- `index.html` (CSS styling and JS refinements)
- `plan.md` (appended visual elevation section)
- `devlog.md` (this entry)

Testing:
- Node JS syntax check: OK (parsed inline script — no errors).
- Automated headless Chrome CDP capture (`verify_flow.js`):
  - `v3_01_home.png`: Frame, swaying vines, and floating cursor trail verified.
  - `v3_02_enter_code.png`: Code redemption box with vintage paper styling.
  - `v3_03_envelope_closed.png`: Closed envelope with 6 ring illustrations, zero overlap.
  - `v3_04_envelope_open.png`: Open envelope with card, zero overlap, unseal hint clear.
  - `v3_05_letter_creator.png`: Lace paper sheet with vintage handwriting placeholder.
  - `v3_06_letter_recipient.png`: Recipient letter displaying burgundy/gold illuminated drop-cap.
  - `v3_07_vinyl_playing.png`: Cat vinyl spinning, tonearm playing, Roman numerals, animated equalizer bars.
  - `v3_08_saved.png`: Gift code display with clipboard copy toast.
- All visual inspections confirmed clean typography, balanced spacing, and zero layout defects.

Known issues / next steps:
- Production backend roadmap remains documented in `plan.md`.

---

## Targeted Restoration — Original Cursor Follow, Envelope Behavior, & Music Playback

Date: 2026-09-28

Status: Completed and verified

What was implemented:
- **Targeted Fix 1: Restored Original 6 Cursor-Following Pictures Behavior**:
  - Maintained all 6 images (`cursor-1.png` to `cursor-6.png`) strictly on the home landing screen.
  - Restored original smooth trailing physics via `ccLag = [0.20, 0.16, 0.13, 0.11, 0.09, 0.08]` chaining.
  - Reverted to original natural image dimensions (`cc1` 56px, `cc2` 64px, `cc3` 52px, `cc4` 60px, `cc5` 54px, `cc6` 58px) with zero extra filter drop-shadows.
  - Verified hover disappearance on landing buttons (`.home-card .btn`) and smooth 0.15s opacity fade.
- **Targeted Fix 2: Restored Closed Envelope Exactly As Original Implementation**:
  - Restored original closed envelope appearance (`envelope-closed.png`) at `min(84vw, 400px)` width and standard centered position.
  - Restored original hover effect: crisp 12px horizontal translation (`transform: translateX(12px)`) with smooth return and zero vertical shift.
  - Restored complete click interaction sequence: closed envelope → open envelope (`envelope-open.png` fade) → holds for ~1.25s (`1250ms`) → automatically transitions into letter screen.
  - Removed recent synthetic audio chimes and particle sparkle explosions.
- **Targeted Fix 3: Fixed Music/Vinyl Player Audio Playback Logic**:
  - Retained the complete vinyl player aesthetic, cat vinyl record disc, tonearm SVG, and turntable plinth without altering layout or styling.
  - Bundled three offline public-domain classical audio files (`song-1.mp3`, `song-2.mp3`, `song-3.mp3`) in the project root to guarantee reliable, instant playback without CORS or 403 errors.
  - Initialized default playlist with these three classical songs.
  - Re-anchored HTML5 `Audio` events (`playing`, `pause`, `waiting`, `ended`, `timeupdate`, `loadedmetadata`, `error`).
  - Synchronized record spinning (`.spinning`) and tonearm engagement strictly with real audio playback status.
  - Wired seek bar input and time indicators (`#seek`, `#cur-time`, `#dur-time`) to audio `duration` and `currentTime`.
  - Linked volume slider directly to `audioEl.volume`.

Files changed:
- `index.html` (CSS adjustments for cursor cluster and envelope; JS audio playback logic & event listeners; default songs)
- `song-1.mp3`, `song-2.mp3`, `song-3.mp3` (bundled local classical audio tracks)
- `plan.md` (documented restoration phase)
- `devlog.md` (this entry)

Testing:
- Script syntax validated with Node `new Function()` — 0 errors.
- Audio files validated for size and readability in the filesystem.
- All 14 PNG artwork files intact and verified.
- Flow integrity confirmed across Home, Envelope, Letter, and Vinyl screens.

Known issues / next steps:
- Ready for user testing. Production backend roadmap remains in `plan.md`.

---

## Bugfix — Storage Definition for Gift Saving & Sharing

Date: 2026-09-28

Status: Completed and verified

Problem:
- On the music/vinyl page, clicking "Save gift and get a share code" triggered the error: `"Couldn't save the gift. Try again."`.
- Cause: The `storage` variable was referenced in `saveLetter()` and `loadLetter()` (`storage.set(...)` / `storage.get(...)`) but was undefined in the script scope, causing a `ReferenceError` when attempting to save the gift JSON.

Solution:
- Re-implemented the resilient `storage` client wrapper in `index.html`:
  - Prioritizes `window.storage` if running in an environment with persistent artifact storage.
  - Automatically falls back to browser `localStorage` under key prefix `'gift-letter:'`.
  - Backed with an in-memory `Map` fallback (`memStore`) if `localStorage` is restricted or unavailable (e.g., restricted file iframe or private mode).
  - Explicitly clears `state.loadError = ''` upon successful save so previous errors disappear when navigating to the saved code screen.

Files changed:
- `index.html` (defined `storage` wrapper with `localStorage` and `memStore` fallbacks; cleared `loadError` on save)
- `devlog.md` (this entry)

Testing:
- Validated JavaScript parsing syntax with Node `new Function()` — 0 errors.
- Verified saving and retrieving gift data via `storage.set` and `storage.get` programmatically.

---

## Enhancement — Simple Medieval Design on the Vinyl Turntable Plinth

Date: 2026-09-28

Status: Completed and verified

What was implemented:
- Added a simple, authentic medieval manuscript and antique music-box design to the blue plinth (the turntable base) underneath the vinyl record:
  - **Medieval Diaper Lattice Pattern**: Decorated the blue surface with a subtle medieval diaper trellis (`#plinth-lattice`) featuring fine diagonal gold lattice linework and miniature florets.
  - **Corner Fleur-de-lis Spandrels**: Placed four ornate medieval corner brackets (`#corner-fleur`) in all four corners of the plinth, featuring gothic framing arcs, central fleur-de-lis / trefoil buds, and radiating antique gold accents (`#d4af37`) with deep burgundy jewel stops (`#4d0e12`).
  - **Concentric Astrolabe Framing Rings**: Rendered delicate concentric beaded and solid gold rings (`r="115"`, `r="118"`, `r="121"`) framing the circular vinyl record disc, with four cardinal florets at the 12, 3, 6, and 9 o'clock marks.
- Preserved all existing record animations (`.spinning`), tonearm movements, playback audio logic, and surrounding page elements.

Files changed:
- `index.html` (added SVG vector artwork to `.plinth`; added `.plinth-svg` CSS styling rule)
- `devlog.md` (this entry)

Testing:
- Validated JavaScript parsing syntax with Node `new Function()` — 0 errors.





---

## Production hardening — performance, Supabase backend, tests (2026-11-02 → 2026-11-04)

Status: **Code complete and tested locally. NOT yet deployed or verified against live Supabase / Netlify.**
(Earlier entries above describe the single-file prototype; where they mention `window.storage`, 6-character `Math.random()` codes,
base64 photos in the gift JSON, "five or more songs" wording or the root-level `index.html`/PNGs, they are superseded by this entry.)

### Problems investigated and root causes
1. **Slow PNGs on Netlify** — the 11 original PNGs used on the first screens were multi-megabyte artwork drawn tiny (e.g. `frame.png` 1.46 MB shown at
   520 px, `cursor-2.png` 1.41 MB shown at ~60 px, `corner-vine-left.png` 1.07 MB, `floral-overlay.png` 0.53 MB). 8.08 MB total across 16 files; the
   home page pulled 5.77 MB of images, no responsive variants, no modern formats, no cache headers, no width/height (CLS 0.03–0.05), and
   every decorative image was requested immediately. Measured LCP on Slow 4G: 28.7 s.
2. **Gift codes not working across devices** — gifts lived in `window.storage`/`localStorage`/memory of the creating browser only, so no other device
   could ever resolve a code. Codes were 6 characters from `Math.random()` (guessable, collision-prone).
3. **Photos as base64 inside letter JSON** — large records, no limits, nothing private.
4. **Stale copy** — homepage still said "five or more songs" while the rule is 1–10.
5. **Letter text area** with its own scroll region on small screens.
6. **Missing assets** — Celandine font referenced but unlicensed/not bundled => two failing requests per load.
7. **Envelope illustrations overflowed the viewport at 561–914 px** (found by the new responsive test).
8. **Touch devices pre-downloaded the six cursor images** they never show (found by the perf image list).

### Fixes implemented
* Image pipeline (`scripts/optimize-images.mjs`): AVIF + WebP + PNG fallback at display widths; originals preserved in `originals/img/`.
  Build (`scripts/build.mjs`): content-fingerprinted `dist/assets/**`, `<picture>` macros with srcset/sizes, pre-rendered home (LCP image in HTML),
  `g.html` shell for share links, asset audit that fails the build on a missing file, Celandine rules only when licensed files exist.
* `netlify.toml`: publish `dist`, immutable 1-year cache for `/assets/*`, revalidating HTML, noindex share links, `/api/*` no-store, security headers + CSP.
* Frontend (`src/js/app.js`, `src/css/app.css`): idle-time image warming, vanilla-JS `<picture>` helper, cursor cluster rAF loop that sleeps when idle/hidden,
  not created for touch or reduced motion; adaptive letter paper (no nested scroll); draft autosave; duplicate-submit guard; idempotent save; retry/
  error/loading states; photo resize+EXIF+upload states; manage key + delete; legacy 6-char prototype codes offer re-publish in the same browser.
* **Backend** (this session): `supabase/schema.sql`; `netlify/functions/{gifts,photos,cleanup}.mjs`; `netlify/lib/{http,supabase,validate,ratelimit,handlers}.mjs`.
  Zero-dependency Supabase REST client; CSPRNG 20-char codes; server-side validation of every field; photo magic-byte check; rate limiting in Postgres;
  signed URLs; deletion with hashed manage key; scheduled orphan cleanup.
* Song-count wording fixed to "one to ten songs" everywhere (home copy, counters, validation messages, button states, DB check, docs).
* This session's two bug fixes: envelope-art overflow at 561–914 px (CSS); cursor images no longer fetched on touch/reduced-motion (JS).
* `scripts/dev-server.mjs`: local Netlify-like server (applies `netlify.toml` headers/redirects, runs functions; `FAKE_BACKEND=1` for no-account testing).
* Client change for tests only: plain-http `localhost`/`127.0.0.1` media URLs are accepted when (and only when) the page itself is on localhost.

### Files
Added: `src/**`, `scripts/{optimize-images,build,dev-server}.mjs`, `netlify.toml`, `netlify/**`, `supabase/schema.sql`, `tests/**`, `docs/{DEPLOYMENT,TEST-REPORT}.md`,
`docs/{image-report,perf-report}.json`, `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `originals/**`.
Modified: `plan.md` (new production-architecture section; history kept), `devlog.md` (this entry).
Moved: root PNGs -> `originals/img/`; root MP3s -> `src/audio/`. Root `index.html` (old prototype) is unchanged and no longer deployed
(`originals/index.original.html` is an identical copy). Removed: nothing. `gift-letter-project - Copy/` is an old duplicate; left untouched.

### Commands run
`node scripts/build.mjs` · `npm install --save-dev @electric-sql/pglite` · `node --test tests/unit/*.test.mjs` ·
`CHROMIUM_PATH=<chrome> node tests/e2e/run.mjs` · `node tests/perf/measure.mjs` (+ `ONLY_REPEAT=1`, `SKIP_BEFORE=1` re-runs).

### Test results (local stand-in backend)
Unit/integration 39/39; browser 69/69; details and limits in `docs/TEST-REPORT.md`. Test-script issues fixed along the way: `node --test <dir>` needs a glob on
Node 22; the project's Playwright wants a newer Chromium build than the sandbox had (`CHROMIUM_PATH` override); weak assertions (hard-coded `true`, `|| true`) replaced with real ones;
repeat-visit measurement was first invalid (request interception disables the HTTP cache; baseline server lacked ETags) and was redone.

### Performance (Slow 4G, mobile 390x844@2x, 4x CPU, median of 3)
LCP 28.7 s -> 2.0 s · transfer 5,787 KB -> 451 KB · image requests 10 (5,771 KB) -> 7 (360 KB) · CLS 0.049 -> 0 · MP3s at load 0 -> 0.
Desktop Slow 4G LCP 28.7 s -> 1.2 s; mobile Fast 3G 57.2 s -> 3.9 s. Local server + throttling, not a live CDN.

### Unresolved / not done
Live Supabase and Netlify setup and verification (docs/DEPLOYMENT.md checklist); Lighthouse and INP on the deployed site; Safari/iOS/Firefox and real-device testing;
pixel-level visual regression; Celandine font (licensed, not bundled, serif fallback in use); no creator accounts (manage key only).

## 2026-11-21 — Songs from devices, medieval photo tray, moving figures
- Creators can upload songs from their device (MP3/M4A/AAC/OGG/WAV/WebM, ≤10 MB each, ≤30 MB per gift). Stored in private bucket `gift-audio`; small files via `/api/audio`, large via one-time signed upload + `/api/audio/commit` verification. Recipients get 6 h signed links, refreshed automatically if they expire mid-listen.
- Photo background is now a medieval tray (crimson rim with rivets, gold corner ornaments, parchment floor).
- The two figures beside the vinyl sway/float only while the record plays (CSS animation-play-state); disabled under reduced motion.
- Tests: 58 unit, 76 e2e pass. Real Supabase not exercised; schema.sql must be re-run.
