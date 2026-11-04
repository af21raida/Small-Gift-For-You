#!/usr/bin/env node
/**
 * Zero-dependency static build for Netlify.
 *
 *   node scripts/build.mjs        ->  dist/
 *
 * - Fingerprints every image / audio / font / css / js file (content hash in the file name)
 *   and writes them to dist/assets/** so netlify.toml can serve them with
 *   "Cache-Control: public, max-age=31536000, immutable".
 * - Rewrites every reference in the HTML and CSS to the fingerprinted name and embeds a
 *   path -> fingerprinted-path manifest in the page for the (dynamic) references made by app.js.
 * - Expands {{pic ...}} macros into <picture> elements (AVIF -> WebP -> PNG, with srcset).
 * - Produces index.html (pre-rendered home screen => the LCP image is in the HTML) and
 *   g.html (shell for /g/<code> share links; noindex, loading state).
 * - Fails the build if any referenced local asset is missing (asset audit).
 * - Includes Celandine @font-face rules only if the licensed font files exist in src/fonts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const exists = (p) => fs.access(p).then(() => true, () => false);

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
function pngSize(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function main() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(path.join(DIST, 'assets'), { recursive: true });

  const manifest = {}; // 'img/frame-520.avif' -> '/assets/img/frame-520.<hash>.avif'
  const sizes = {};

  async function emitAsset(rel, buf) {
    const ext = path.extname(rel);
    const stem = rel.slice(0, -ext.length);
    const out = `assets/${stem}.${hash(buf)}${ext}`;
    await fs.mkdir(path.dirname(path.join(DIST, out)), { recursive: true });
    await fs.writeFile(path.join(DIST, out), buf);
    manifest[rel] = '/' + out;
    sizes[rel] = buf.length;
  }

  // 1. binary assets
  const pngDims = {};
  for (const rel of await walk(SRC)) {
    if (/^(img|audio|fonts)\//.test(rel) && !/\.(json|txt|md)$/i.test(rel)) {
      const buf = await fs.readFile(path.join(SRC, rel));
      await emitAsset(rel, buf);
      if (rel.startsWith('img/') && rel.endsWith('.png')) pngDims[rel] = pngSize(buf);
    } else if (/^fonts\/.*\.txt$/i.test(rel)) {
      // keep font licences next to the fonts, un-hashed
      await fs.mkdir(path.join(DIST, 'assets/fonts'), { recursive: true });
      await fs.copyFile(path.join(SRC, rel), path.join(DIST, 'assets', rel));
    }
  }

  // 2. CSS
  let css = await fs.readFile(path.join(SRC, 'css/app.css'), 'utf8');
  const hasCelandine = (await exists(path.join(SRC, 'fonts/celandine-regular.woff2'))) && (await exists(path.join(SRC, 'fonts/celandine-bold.woff2')));
  css = css.replace('/*__CELANDINE_FACES__*/', hasCelandine
    ? `@font-face{font-family:'Celandine';src:url('../fonts/celandine-regular.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap;}
  @font-face{font-family:'Celandine';src:url('../fonts/celandine-bold.woff2') format('woff2');font-weight:700;font-style:normal;font-display:swap;}`
    : '/* Celandine files not present: using the Georgia/serif fallback stack. */');
  css = css.replace(/url\((['"]?)\.\.\/([^'")]+)\1\)/g, (m, q, p) => {
    if (!manifest[p]) throw new Error(`CSS references missing asset: ${p}`);
    return `url(${q}${manifest[p]}${q})`;
  });
  await emitAsset('css/app.css', Buffer.from(css));

  // 3. JS (references assets only through the manifest at runtime)
  await emitAsset('js/app.js', await fs.readFile(path.join(SRC, 'js/app.js')));

  // 4. HTML
  const manifestForPage = Object.fromEntries(Object.entries(manifest).filter(([k]) => /^(img|audio)\//.test(k)));
  function picMacro(attrsText) {
    const a = {};
    attrsText.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; });
    const { name } = a;
    const widths = Object.keys(pngDims)
      .map((k) => k.match(new RegExp(`^img/${name}-(\\d+)\\.png$`)))
      .filter(Boolean).map((m) => +m[1]).sort((x, y) => x - y);
    if (!widths.length) throw new Error(`pic macro: no image variants for "${name}"`);
    const set = (ext) => widths.map((w) => `/img/${name}-${w}.${ext} ${w}w`).join(', ');
    const big = pngDims[`img/${name}-${widths[widths.length - 1]}.png`];
    const sz = a.sizes || `${widths[widths.length - 1]}px`;
    const extra = ['fetchpriority', 'loading', 'aria-hidden'].filter((k) => a[k] !== undefined).map((k) => ` ${k}="${a[k]}"`).join('');
    return `<picture><source type="image/avif" srcset="${set('avif')}" sizes="${sz}"><source type="image/webp" srcset="${set('webp')}" sizes="${sz}">` +
      `<img src="/img/${name}-${widths[widths.length - 1]}.png" srcset="${set('png')}" sizes="${sz}" width="${big.w}" height="${big.h}" alt="${a.alt || ''}"` +
      `${a.class ? ` class="${a.class}"` : ''}${extra} decoding="async"></picture>`;
  }
  function renderHtml(tpl, variant) {
    let h = tpl;
    h = h.replace(/<!--@home-only-->([\s\S]*?)<!--@\/home-only-->/g, variant === 'home' ? '$1' : '');
    h = h.replace(/<!--@gift-only-->([\s\S]*?)<!--@\/gift-only-->/g, variant === 'gift' ? '$1' : '');
    h = h.replace(/\{\{pic ([^}]*)\}\}/g, (_, attrs) => picMacro(attrs));
    // rewrite local references (longest keys first so "frame-1040" is never clobbered by "frame-10")
    const keys = Object.keys(manifest).sort((x, y) => y.length - x.length);
    for (const k of keys) h = h.split(`/${k}`).join(manifest[k]);
    h = h.replace('{{manifest}}', JSON.stringify(manifestForPage));
    // asset audit: any remaining un-fingerprinted local reference is a bug
    const stray = h.match(/(?:src|href|srcset)="\/(?:img|css|js|audio|fonts)\/[^"]*"/g);
    if (stray) throw new Error(`Unresolved asset reference(s): ${[...new Set(stray)].join(', ')}`);
    return h;
  }
  const tpl = await fs.readFile(path.join(SRC, 'index.html'), 'utf8');
  await fs.writeFile(path.join(DIST, 'index.html'), renderHtml(tpl, 'home'));
  await fs.writeFile(path.join(DIST, 'g.html'), renderHtml(tpl, 'gift'));
  const nf = await fs.readFile(path.join(SRC, '404.html'), 'utf8');
  await fs.writeFile(path.join(DIST, '404.html'), renderHtml(nf, 'home'));

  // 5. other static files (robots.txt ...)
  if (await exists(path.join(SRC, 'public'))) {
    for (const rel of await walk(path.join(SRC, 'public'))) {
      await fs.copyFile(path.join(SRC, 'public', rel), path.join(DIST, rel));
    }
  }

  // 6. summary
  const total = (re) => Object.entries(sizes).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`built dist/  (${Object.keys(manifest).length} fingerprinted assets)`);
  console.log(`  images ${kb(total(/^img\//))} · audio ${kb(total(/^audio\//))} · fonts ${kb(total(/^fonts\//))} · css ${kb(total(/^css\//))} · js ${kb(total(/^js\//))}`);
  console.log(`  Celandine font: ${hasCelandine ? 'included' : 'not present (fallback stack in use)'}`);
}
main().catch((e) => { console.error('BUILD FAILED:', e.message); process.exit(1); });
