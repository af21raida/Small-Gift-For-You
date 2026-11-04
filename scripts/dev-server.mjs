#!/usr/bin/env node
/**
 * Local server that mimics the Netlify deployment: serves dist/, applies the [[headers]] and
 * [[redirects]] from netlify.toml, and runs netlify/functions/* behind /api/*.
 *
 *   node scripts/build.mjs && node scripts/dev-server.mjs            # real env vars (SUPABASE_*) from the shell
 *   FAKE_BACKEND=1 node scripts/dev-server.mjs                       # in-process fake Supabase (PGlite) — no account needed
 *   PORT=8888 ...                                                    # default 8888
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };

/** Minimal netlify.toml reader: only [[headers]] (for + values) and [[redirects]] (from/to/status). */
export function parseToml(text) {
  const headers = [], redirects = []; let cur = null, inValues = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[[headers]]') { cur = { for: '', values: {} }; headers.push(cur); inValues = false; continue; }
    if (line === '[headers.values]') { inValues = true; continue; }
    if (line === '[[redirects]]') { cur = { from: '', to: '', status: 301 }; redirects.push(cur); inValues = false; continue; }
    if (line.startsWith('[')) { cur = null; inValues = false; continue; }
    const m = /^([\w-]+)\s*=\s*(.+)$/.exec(line); if (!m || !cur) continue;
    const v = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (inValues) cur.values[m[1]] = v; else if (m[1] === 'for') cur.for = v; else if (m[1] === 'from') cur.from = v; else if (m[1] === 'to') cur.to = v; else if (m[1] === 'status') cur.status = +v;
  }
  return { headers, redirects };
}
const globToRe = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export async function startDevServer({ port = Number(process.env.PORT || 8888), fake = process.env.FAKE_BACKEND === '1', quiet = false } = {}) {
  const cfg = parseToml(await fs.readFile(path.join(ROOT, 'netlify.toml'), 'utf8'));
  let fakeSb = null;
  if (fake) {
    const { startFakeSupabase } = await import('../tests/support/fake-supabase.mjs');
    fakeSb = await startFakeSupabase(); Object.assign(process.env, fakeSb.env);
  }
  const fnGifts = (await import(pathToFileURL(path.join(ROOT, 'netlify/functions/gifts.mjs')))).default;
  const fnPhotos = (await import(pathToFileURL(path.join(ROOT, 'netlify/functions/photos.mjs')))).default;

  const headersFor = (p) => {
    const h = {}; for (const r of cfg.headers) if (globToRe(r.for).test(p)) Object.assign(h, r.values);
    // test stand-in storage lives on another localhost origin: let the CSP allow its images
    if (fakeSb && h['Content-Security-Policy']) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace('img-src', `img-src ${fakeSb.url}`);
    return h;
  };
  const finish = (req, res, status, body, type, p) => {
    const h = { ...headersFor(p), 'Content-Type': type };
    let out = body;
    if (/^(text|application\/json|image\/svg)/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 800) {
      out = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding';
    }
    h['Content-Length'] = out.length;
    res.writeHead(status, h); res.end(req.method === 'HEAD' ? undefined : out);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(url.pathname);
      if (p.startsWith('/api/')) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const hdrs = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') hdrs.set(k, v);
        const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, { method: req.method, headers: hdrs, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const ip = req.headers['x-test-ip'] || req.socket.remoteAddress;
        let r;
        const m = /^\/api\/gifts\/([^/]+)$/.exec(p);
        if (p === '/api/gifts') r = await fnGifts(request, { ip, params: {} });
        else if (m) r = await fnGifts(request, { ip, params: { code: m[1] } });
        else if (p === '/api/photos') r = await fnPhotos(request, { ip, params: {} });
        else r = new Response('{"error":"not_found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
        const out = Buffer.from(await r.arrayBuffer()); const h = { ...headersFor(p) };
        r.headers.forEach((v, k) => { h[k] = v; }); h['Content-Length'] = out.length;
        res.writeHead(r.status, h); return res.end(out);
      }
      let file = p === '/' ? '/index.html' : p;
      for (const r of cfg.redirects) if (r.status === 200 && globToRe(r.from).test(p)) file = r.to;
      const abs = path.join(DIST, path.normalize(file));
      if (!abs.startsWith(DIST)) return finish(req, res, 400, Buffer.from('bad path'), 'text/plain', p);
      try {
        const buf = await fs.readFile(abs);
        return finish(req, res, 200, buf, MIME[path.extname(abs)] || 'application/octet-stream', p);
      } catch {
        const nf = await fs.readFile(path.join(DIST, '404.html'));
        return finish(req, res, 404, nf, MIME['.html'], p);
      }
    } catch (e) { res.writeHead(500); res.end('dev-server error: ' + e.message); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (!quiet) console.log(`dev server: ${base}   backend: ${fake ? 'FAKE (PGlite + in-memory storage)' : (process.env.SUPABASE_URL || 'NOT CONFIGURED -> API answers 503')}`);
  return { base, fake: fakeSb, async close() { await new Promise((r) => server.close(r)); if (fakeSb) await fakeSb.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startDevServer();
