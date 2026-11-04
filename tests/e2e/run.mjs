// End-to-end tests (Playwright + Chromium) against the built site, the real Netlify Functions and the
// PGlite-backed fake Supabase. Run:  node scripts/build.mjs && node tests/e2e/run.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startDevServer } from '../../scripts/dev-server.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
await fs.mkdir(OUT, { recursive: true });
const results = []; let ipN = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  -> ' + detail : ''}`); };
async function step(name, fn) { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n')[0]); } }

const srv = await startDevServer({ port: 0, fake: true, quiet: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const newCtx = (extra = {}) => browser.newContext({ extraHTTPHeaders: { 'x-test-ip': `198.51.100.${++ipN}` }, ...extra });
const problems = [];
function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`${label} console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/\/api\//.test(r.url()) && !/\.mp3|nonexistent|127\.0\.0\.1:9/.test(r.url())) problems.push(`${label} requestfailed ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`${label} HTTP ${r.status()} ${r.url()}`); });
}
const photo = async (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function openEnvelope(page) {
  await page.getByRole('button', { name: 'Open the envelope' }).click();
  await page.getByRole('button', { name: 'Continue to letter' }).click();
}
const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: my dearest, ` + 'you are the reason for every quiet joy in my days. '.repeat(3)).join('\n\n').slice(0, 9800);

let shareUrl, shareCode;

// ---------------------------------------------------------------- creator flow
await step('creator flow', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'creator');
  await page.goto(srv.base + '/');
  check('home shows title + corrected 1-10 song wording', (await page.locator('.home-tagline').innerText()).includes('one to ten songs') && !/five or more/i.test(await page.content()));
  await page.getByRole('button', { name: 'Write a Letter' }).click();
  await openEnvelope(page);
  const msg = 'My dearest,\n\nThis is line two — with ünïcode & <b>tags</b>.\n\nForever yours.';
  await page.getByLabel('Your letter').fill(msg);
  // photos: 2 uploads + 1 external link
  await page.setInputFiles('#photo-file', { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await photo(1600, 1200, '#c33') });
  await page.waitForFunction(() => !document.querySelector('.photo-state'), null, { timeout: 15000 });
  await page.setInputFiles('#photo-file', { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await photo(900, 1400, '#36c') });
  await page.waitForFunction(() => !document.querySelector('.photo-state'), null, { timeout: 15000 });
  check('two photos uploaded to private storage', srv.fake.objects.size === 2, 'objects=' + srv.fake.objects.size);
  // invalid upload
  await page.setInputFiles('#photo-file', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  check('invalid file type shows a friendly error', /JPEG, PNG or WebP/.test(await page.locator('#photo-msg').innerText()));
  await page.getByRole('button', { name: 'Continue to the music' }).click();
  check('song counter shows N / 10', (await page.locator('#song-count').innerText()) === '3 / 10 songs');
  // add songs up to 10, then verify the 11th is refused
  for (let i = 0; i < 7; i++) {
    await page.getByLabel('Song title').fill('Extra ' + i);
    await page.getByLabel('Audio URL').fill(`https://cdn.example.com/s${i}.mp3`);
    await page.getByRole('button', { name: '+ Add song' }).click();
  }
  check('10 songs reached, add button disabled', (await page.locator('#song-count').innerText()) === '10 / 10 songs' && await page.getByRole('button', { name: 'Playlist full' }).isDisabled());
  await page.getByRole('button', { name: 'Save gift and get a share link' }).click();
  await page.getByText('Your gift is ready').waitFor({ timeout: 20000 });
  shareUrl = (await page.locator('#share-link').innerText()).trim();
  shareCode = shareUrl.split('/g/')[1];
  check('share link has a 20-char CSPRNG code', /^[0-9A-HJKMNP-TV-Z]{20}$/.test(shareCode), shareUrl);
  const row = (await srv.fake.db.query('select message, jsonb_array_length(songs) s, jsonb_array_length(photos) p from gifts where code=$1', [shareCode])).rows[0];
  check('gift persisted in database with 10 songs / 2 photos, no base64 in JSON', row && row.s === 10 && row.p === 2 && !row.message.includes('data:image'));
  check('draft cleared after a confirmed save', await page.evaluate(() => localStorage.getItem('mlfy:draft:v1') === null));
  await page.screenshot({ path: path.join(OUT, 'creator-saved.png') });
  // manage key kept for later deletion
  check('manage key remembered in this browser', await page.evaluate((c) => !!localStorage.getItem('mlfy:manage:' + c), shareCode));
  await ctx.close();
});

// ---------------------------------------------------------------- recipient flow (independent browser context)
await step('recipient flow', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'recipient');
  const reqs = []; page.on('request', (r) => reqs.push(r.url()));
  await page.goto(shareUrl);
  await page.getByRole('button', { name: 'Open the envelope' }).waitFor({ timeout: 15000 });
  check('recipient (new context, no local data) sees the envelope', true);
  check('share page is noindex', (await page.locator('meta[name=robots]').getAttribute('content')) === 'noindex, nofollow');
  await openEnvelope(page);
  const text = await page.locator('.letter-readonly').innerText();
  check('recipient reads the exact letter (escaped, not HTML)', text.includes('ünïcode & <b>tags</b>') && text.includes('Forever yours.'));
  check('recipient cannot edit the letter', (await page.locator('textarea').count()) === 0);
  const imgs = page.locator('.postcard-section img');
  await imgs.first().waitFor();
  await page.waitForFunction(() => { const i = document.querySelector('.postcard-section img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
  check('postcard photo (private signed URL) loads', true);
  check('postcard counter shows 1 / 2', (await page.locator('.postcard-nav .hint').innerText()).trim() === '1 / 2');
  await page.getByRole('button', { name: 'Next photo' }).click();
  await page.waitForFunction(() => { const i = document.querySelector('.postcard-section img'); return i && i.complete && i.naturalWidth > 0; });
  check('postcard navigation works', (await page.locator('.postcard-nav .hint').innerText()).trim() === '2 / 2');
  await page.getByRole('button', { name: 'Continue to the record' }).click();
  check('recipient sees 10 songs, no editing controls', (await page.locator('.track').count()) === 10 && (await page.getByRole('button', { name: 'Remove song' }).count()) === 0 && (await page.locator('#save-btn').count()) === 0);
  await page.screenshot({ path: path.join(OUT, 'recipient-vinyl.png') });
  await ctx.close();
});

// ---------------------------------------------------------------- player
await step('vinyl player', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'player');
  await page.addInitScript(() => { const O = window.Audio; window.__aud = []; window.Audio = function (...a) { const x = new O(...a); window.__aud.push(x); return x; }; });
  const mp3 = []; page.on('request', (r) => { if (/\.mp3(\?|$)/.test(r.url())) mp3.push(r.url()); });
  await page.goto(srv.base + '/');
  await page.waitForTimeout(1500);
  check('home page downloads no MP3s', mp3.length === 0, mp3.join(','));
  await page.getByRole('button', { name: 'Write a Letter' }).click();
  await openEnvelope(page);
  await page.getByRole('button', { name: 'Continue to the music' }).click();
  await page.waitForTimeout(800);
  check('before pressing play at most the current track\'s metadata is fetched (not all 3 MP3s)', new Set(mp3).size <= 1, [...new Set(mp3)].join(','));
  check('record idle and arm up before playing', (await page.locator('.record.paused').count()) === 1 && (await page.locator('.tonearm.playing').count()) === 0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => { const s = document.getElementById('np-status'); return s && s.textContent === 'Now playing'; }, null, { timeout: 15000 });
  check('play: status, spinning record and tonearm all follow real playback', (await page.locator('.record.spinning').count()) === 1 && (await page.locator('.tonearm.playing').count()) === 1);
  const t0 = await page.evaluate(() => document.getElementById('cur-time').textContent);
  await page.waitForTimeout(2200);
  const t1 = await page.evaluate(() => document.getElementById('cur-time').textContent);
  check('time advances while playing', t0 !== t1, `${t0} -> ${t1}`);
  check('duration displayed', (await page.locator('#dur-time').innerText()) !== '0:00', await page.locator('#dur-time').innerText());
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.record.paused').length === 1, null, { timeout: 5000 }).catch(() => {});
  check('pause stops the record and lifts the arm', (await page.locator('.record.paused').count()) === 1 && (await page.locator('.tonearm.playing').count()) === 0);
  await page.getByRole('button', { name: 'Next song' }).click();
  check('next song', (await page.locator('#np-title').innerText()) === 'Acoustic Romance');
  await page.getByRole('button', { name: 'Previous song' }).click();
  check('previous song', (await page.locator('#np-title').innerText()) === 'Harpsichord Keepsake');
  await page.getByRole('button', { name: 'Play Melodic Air for Strings' }).click();
  await page.waitForFunction(() => document.getElementById('np-title').textContent === 'Melodic Air for Strings');
  check('playlist selection', true);
  // seek + volume
  await page.waitForFunction(() => parseFloat(document.getElementById('seek').max) > 10, null, { timeout: 10000 });
  await page.locator('#seek').evaluate((el) => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(400);
  check('seek bar moves playback', (await page.locator('#cur-time').innerText()).startsWith('0:') && (await page.evaluate(() => document.getElementById('seek').value)) !== '0');
  await page.getByLabel('Volume').evaluate((el) => { el.value = '0.2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  check('volume control sets the audio element volume', Math.abs(await page.evaluate(() => window.__aud[0].volume) - 0.2) < 0.01);
  // bad audio link -> friendly error and record stops
  await page.getByLabel('Song title').fill('Broken');
  await page.getByLabel('Audio URL').fill('https://127.0.0.1:9/none.mp3');
  await page.getByRole('button', { name: '+ Add song' }).click();
  await page.getByRole('button', { name: 'Play Broken' }).click();
  await page.waitForFunction(() => /can.t be played|couldn.t be played|couldn.t be loaded|network dropped/.test(document.getElementById('err-slot').textContent), null, { timeout: 20000 }).catch(() => {});
  check('unplayable audio link -> friendly error shown', /can.t be played|couldn.t be played|couldn.t be loaded|network dropped/.test(await page.locator('#err-slot').innerText()), await page.locator('#err-slot').innerText());
  check('record stops spinning after an audio error', (await page.locator('.record.spinning').count()) === 0 && (await page.locator('.tonearm.playing').count()) === 0);
  await ctx.close();
});

// ---------------------------------------------------------------- validation + deletion + errors
await step('validation & errors', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'errors');
  await page.goto(srv.base + '/');
  await page.getByRole('button', { name: 'I received a gift code' }).click();
  await page.getByLabel('Gift code or link').fill('ABC');
  await page.getByRole('button', { name: 'Open my gift' }).click();
  check('short code -> friendly message', /20|prototype/.test(await page.locator('.error').innerText()));
  await page.getByLabel('Gift code or link').fill('0'.repeat(20));
  await page.getByRole('button', { name: 'Open my gift' }).click();
  await page.getByText('No gift found for that code.').waitFor();
  check('unknown gift code -> "No gift found"', true);
  // manual code entry (formatted with dashes) opens the real gift
  const pretty = shareCode.match(/.{1,5}/g).join('-');
  await page.getByLabel('Gift code or link').fill(pretty);
  await page.getByRole('button', { name: 'Open my gift' }).click();
  await page.getByRole('button', { name: 'Open the envelope' }).waitFor({ timeout: 15000 });
  check('manual code entry (dash-formatted) works', true);
  await ctx.close();

  // save failure must not claim success
  const c2 = await newCtx(); const p2 = await c2.newPage(); watch(p2, 'savefail');
  await p2.goto(srv.base + '/'); await p2.getByRole('button', { name: 'Write a Letter' }).click(); await openEnvelope(p2);
  await p2.getByLabel('Your letter').fill('will fail'); await p2.getByRole('button', { name: 'Continue to the music' }).click();
  await p2.route('**/api/gifts', (r) => r.abort('failed'));
  await p2.getByRole('button', { name: 'Save gift and get a share link' }).click();
  await p2.locator('#err-slot .error, .error').first().waitFor();
  check('network failure on save shows an error, never "Your gift is ready"', (await p2.getByText('Your gift is ready').count()) === 0 && /reach the server/.test(await p2.locator('.error').first().innerText()));
  check('unsaved letter survives the failure (draft kept)', await p2.evaluate(() => (localStorage.getItem('mlfy:draft:v1') || '').includes('will fail')));
  await p2.unroute('**/api/gifts');
  await p2.getByRole('button', { name: 'Save gift and get a share link' }).click();
  await p2.getByText('Your gift is ready').waitFor({ timeout: 15000 });
  check('retry after failure succeeds', true);
  const n = (await srv.fake.db.query("select count(*)::int n from gifts where message='will fail'")).rows[0].n;
  check('exactly one gift row after fail + retry', n === 1, 'rows=' + n);
  // double click guard
  await p2.getByRole('button', { name: 'Delete this gift' }).scrollIntoViewIfNeeded().catch(() => {});
  p2.once('dialog', (d) => d.accept());
  await p2.locator('summary').click();
  await p2.getByRole('button', { name: 'Delete this gift' }).click();
  await p2.waitForFunction(() => document.querySelector('.title-frame'), null, { timeout: 10000 });
  const del = (await srv.fake.db.query("select deleted_at from gifts where message='' and deleted_at is not null")).rows.length;
  check('creator can delete their gift from the saved screen', del >= 1);
  await c2.close();
});

// ---------------------------------------------------------------- responsive + long letter
for (const w of [320, 375, 390, 430, 768, 1280]) {
  await step('responsive ' + w, async () => {
    const ctx = await newCtx({ viewport: { width: w, height: w >= 768 ? 900 : 760 }, hasTouch: w < 768, isMobile: w < 768 }); const page = await ctx.newPage(); watch(page, 'w' + w);
    const bad = [];
    await page.goto(srv.base + '/'); if (await hOverflow(page) > 1) bad.push('home');
    await page.screenshot({ path: path.join(OUT, `w${w}-home.png`) });
    await page.getByRole('button', { name: 'Write a Letter' }).click();
    if (await hOverflow(page) > 1) bad.push('envelope');
    await page.screenshot({ path: path.join(OUT, `w${w}-envelope.png`) });
    await openEnvelope(page);
    const ta = page.getByLabel('Your letter');
    await ta.fill(LONG);
    if (await hOverflow(page) > 1) bad.push('long-letter');
    const taBox = await ta.evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, ov: getComputedStyle(e).overflowY }));
    const nested = taBox.sh > taBox.ch + 2; // textarea itself scrolling = nested scrolling
    await page.screenshot({ path: path.join(OUT, `w${w}-letter-long.png`), fullPage: true });
    check(`w${w}: long letter grows the paper (no nested scrollbar)`, !nested, JSON.stringify(taBox));
    const btn = page.getByRole('button', { name: 'Continue to the music' }); await btn.scrollIntoViewIfNeeded();
    const bb = await btn.boundingBox();
    check(`w${w}: continue button visible and >=40px tall`, bb && bb.height >= 40 && bb.x >= 0 && bb.x + bb.width <= w + 1, JSON.stringify(bb));
    await ta.fill('Short note.');
    await btn.click();
    if (await hOverflow(page) > 1) bad.push('vinyl');
    await page.screenshot({ path: path.join(OUT, `w${w}-vinyl.png`), fullPage: true });
    const tt = await page.locator('.turntable').boundingBox();
    check(`w${w}: turntable fits viewport`, tt && tt.x >= -1 && tt.x + tt.width <= w + 1, JSON.stringify(tt));
    check(`w${w}: no horizontal scroll on any screen`, bad.length === 0, bad.join(','));
    await ctx.close();
  });
}

// ---------------------------------------------------------------- recipient long letter + reduced motion + cursor cluster
await step('long letter round trip & reduced motion', async () => {
  const ctx = await newCtx({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); watch(page, 'long');
  const r = await page.request.post(srv.base + '/api/gifts', { headers: { 'x-test-ip': '198.51.100.250' }, data: { message: LONG, songs: [{ title: 'T', artist: '', url: 'builtin:song-1' }], photos: [], manageKey: 'k'.repeat(43), idempotencyKey: 'z'.repeat(24) } });
  const { code } = await r.json();
  await page.goto(srv.base + '/g/' + code); await openEnvelope(page);
  const shown = await page.locator('.letter-readonly').innerText();
  check('recipient sees the complete long letter', shown.replace(/\s+/g, ' ').trim() === LONG.replace(/\s+/g, ' ').trim());
  check('zero photos -> no postcard section for recipient', (await page.locator('.postcard-section').count()) === 0);
  await ctx.close();
  const c2 = await newCtx({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }); const p2 = await c2.newPage();
  await p2.goto(srv.base + '/'); await p2.mouse.move(300, 300); await p2.mouse.move(420, 360);
  check('reduced motion: cursor cluster not created', (await p2.locator('#cursorCluster').count()) === 0);
  await c2.close();
  const c3 = await newCtx({ viewport: { width: 1280, height: 800 } }); const p3 = await c3.newPage();
  await p3.goto(srv.base + '/'); await p3.mouse.move(300, 300); await p3.mouse.move(500, 400); await p3.waitForTimeout(800);
  check('desktop: six cursor illustrations created and visible', (await p3.locator('#cursorCluster img.cc').count()) === 6 && (await p3.locator('#cursorCluster.on').count()) === 1);
  await c3.close();
  const c4 = await newCtx({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true }); const p4 = await c4.newPage();
  await p4.goto(srv.base + '/'); await p4.waitForTimeout(500);
  check('touch device: cursor cluster not created', (await p4.locator('#cursorCluster').count()) === 0);
  await c4.close();
});

check('no console errors / page errors / failed static requests', problems.length === 0, problems.slice(0, 5).join(' | '));
await browser.close(); await srv.close();
const failed = results.filter((r) => !r.ok);
await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
