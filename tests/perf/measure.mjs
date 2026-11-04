// Before/after load measurements under mobile-network throttling (Chromium + CDP).
//   BEFORE = the original prototype (originals/index.original.html + the original full-size PNGs at the site root,
//            served the way a plain Netlify deploy without a netlify.toml serves them: no immutable caching).
//   AFTER  = dist/ served by scripts/dev-server.mjs with the real netlify.toml headers.
// Local server, so numbers reflect byte counts + simulated bandwidth/latency, NOT a live Netlify CDN (no TLS/DNS/edge).
import fs from 'node:fs/promises';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startDevServer } from '../../scripts/dev-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS = Number(process.env.RUNS || 3);

// ---- build the "before" site in a scratch dir
const before = await fs.mkdtemp(path.join(os.tmpdir(), 'mlfy-before-'));
await fs.copyFile(path.join(ROOT, 'originals/index.original.html'), path.join(before, 'index.html'));
for (const f of await fs.readdir(path.join(ROOT, 'originals/img'))) await fs.copyFile(path.join(ROOT, 'originals/img', f), path.join(before, f));
for (const n of [1, 2, 3]) await fs.copyFile(path.join(ROOT, `src/audio/song-${n}.mp3`), path.join(before, `song-${n}.mp3`));
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const beforeSrv = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  try {
    let buf = await fs.readFile(path.join(before, path.normalize(p)));
    // Netlify sends an ETag for every file and answers revalidation with 304: mimic that so the baseline is fair.
    const etag = '"' + (await import('node:crypto')).createHash('md5').update(buf).digest('hex') + '"';
    const h = { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
    if (p.endsWith('.html') && /gzip/.test(req.headers['accept-encoding'] || '')) { buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; }
    res.writeHead(200, h); res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => beforeSrv.listen(0, '127.0.0.1', r));
const beforeUrl = `http://127.0.0.1:${beforeSrv.address().port}/`;
const after = await startDevServer({ port: 0, fake: false, quiet: true });

// External hosts (e.g. Google Fonts in the old prototype) fail identically for both versions. Done with a resolver rule, not
// page.route(), because request interception would disable the HTTP cache and invalidate the repeat-visit test.
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const NET = { // Lighthouse "Slow 4G" / "Fast 3G"-class profiles (bytes per second)
  'Slow 4G (1.6 Mbps, 150 ms RTT)': { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  'Fast 3G (0.8 Mbps, 300 ms RTT)': { latency: 300, downloadThroughput: (0.8 * 1024 * 1024) / 8, uploadThroughput: (330 * 1024) / 8 },
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function load(url, net, mobile, warmCtx) {
  const ctx = warmCtx || await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: !warmCtx });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...net });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const reqs = new Map(); let bytes = 0;
  cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0, fromCache: false }));
  cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.fromCache = true; });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; bytes += e.encodedDataLength; } });
  await page.addInitScript(() => {
    window.__m = { lcp: 0, lcpEl: '', cls: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__m.lcp = e.startTime; window.__m.lcpEl = (e.element && (e.element.tagName + '.' + (e.element.className || ''))) || e.url || ''; } }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => window.__m);
  const fcp = await page.evaluate(() => (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0);
  const all = [...reqs.values()]; const img = all.filter((r) => /\.(png|webp|avif)(\?|$)/.test(r.url) || r.type === 'Image');
  const out = {
    lcpMs: Math.round(m.lcp), lcpElement: m.lcpEl, fcpMs: Math.round(fcp), cls: +m.cls.toFixed(4), loadEventMs: loadMs,
    requests: all.length, transferKB: +(bytes / 1024).toFixed(1),
    imageRequests: img.length, imageKB: +(img.reduce((a, r) => a + r.bytes, 0) / 1024).toFixed(1),
    audioRequests: all.filter((r) => /\.mp3/.test(r.url)).length, fontRequests: all.filter((r) => /\.woff2?/.test(r.url)).length,
    failed: all.filter((r) => r.bytes === 0 && !r.fromCache && /\.(woff2?|png)/.test(r.url)).map((r) => r.url.split('/').slice(-2).join('/')),
    imageList: img.map((r) => r.url.split('/').pop().replace(/\.[0-9a-f]{10}\./, '.') + ' ' + (r.bytes / 1024).toFixed(1) + 'KB'),
  };
  if (!warmCtx) await ctx.close(); else await page.close();
  return out;
}

const REPORT_PATH = path.join(ROOT, 'docs/perf-report.json');
const ONLY_REPEAT = process.env.ONLY_REPEAT === '1';
const old = process.env.SKIP_BEFORE === '1' ? JSON.parse(await fs.readFile(REPORT_PATH, 'utf8')) : { results: {} };
const report = ONLY_REPEAT ? JSON.parse(await fs.readFile(REPORT_PATH, 'utf8')) : { generatedAt: new Date().toISOString(), runs: RUNS, note: 'Local server + CDP throttling + 4x CPU slowdown; not a live Netlify test.', results: {} };
const MATRIX = [['Slow 4G (1.6 Mbps, 150 ms RTT)', true], ['Slow 4G (1.6 Mbps, 150 ms RTT)', false], ['Fast 3G (0.8 Mbps, 300 ms RTT)', true]];
for (const [netName, mobile] of (ONLY_REPEAT ? [] : MATRIX)) {
  const net = NET[netName];
  {
    const key = `${netName} | ${mobile ? 'mobile 390x844@2x' : 'desktop 1280x800'}`; report.results[key] = {};
    for (const [label, url] of [['before', beforeUrl], ['after', after.base + '/']]) {
      if (label === 'before' && process.env.SKIP_BEFORE === '1' && old.results[key]) { report.results[key].before = old.results[key].before; continue; }
      const runs = []; for (let i = 0; i < RUNS; i++) runs.push(await load(url, net, mobile));
      const pick = runs.sort((a, b) => a.lcpMs - b.lcpMs)[Math.floor(runs.length / 2)];   // median run by LCP
      report.results[key][label] = { ...pick, lcpMsAllRuns: runs.map((r) => r.lcpMs) };
      console.log(key, label, 'LCP', pick.lcpMs, 'ms  CLS', pick.cls, ' transfer', pick.transferKB, 'KB  img', pick.imageRequests, 'req /', pick.imageKB, 'KB  mp3', pick.audioRequests);
    }
  }
}
// repeat visit (warm HTTP cache) on mobile Slow 4G
{
  const net = NET['Slow 4G (1.6 Mbps, 150 ms RTT)']; report.results.repeatVisit = {};
  for (const [label, url] of [['before', beforeUrl], ['after', after.base + '/']]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await load(url, net, true, ctx); const second = await load(url, net, true, ctx); await ctx.close();
    report.results.repeatVisit[label] = second; console.log('repeat visit', label, second.transferKB + ' KB', second.requests + ' requests');
  }
}
await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'docs/perf-report.json'), JSON.stringify(report, null, 2));
await browser.close(); await after.close(); beforeSrv.close(); await fs.rm(before, { recursive: true, force: true });
