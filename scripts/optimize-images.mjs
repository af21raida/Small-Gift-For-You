#!/usr/bin/env node
/**
 * Image optimisation pipeline.
 *
 *   npm run images           # regenerate src/img from originals/img
 *
 * Reads the untouched artwork in originals/img/*.png and writes, for every image and
 * every srcset width, three *really converted* files with transparency preserved:
 *   - AVIF  (primary; ~35% smaller than WebP at higher PSNR on this artwork),
 *   - WebP  (fallback for Safari 14-16.3 and other browsers without AVIF),
 *   - PNG   (palette-optimised last resort for browsers without WebP).
 * The browser picks the first format it supports via <picture>/<source type=...>.
 * Widths are chosen from the CSS size each image is actually rendered at (x2 for
 * high-density screens) and are never larger than the original's native width.
 *
 * The originals are never modified or deleted.
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, 'originals/img');
const OUT = path.join(ROOT, 'src/img');

const AVIF = { quality: 60, effort: 6, chromaSubsampling: '4:4:4' };
const WEBP = { quality: 82, alphaQuality: 92, effort: 6, smartSubsample: true };
const PNG = { palette: true, quality: 88, effort: 10, compressionLevel: 9 };

/** name -> output widths (CSS px x DPR, capped at native width). */
const SPEC = {
  // title frame renders at <=520 css px
  frame: [520, 1040],
  // right vine: native is only 374x666, rendered <=460 px tall
  'corner-vine': [280, 374],
  // left vine: native 940x1672 but rendered at the same <=460 px height
  'corner-vine-left': [360, 520],
  // cursor trail (<=64 px) and envelope decorations (60-128 px)
  'cursor-1': [128, 256],
  'cursor-2': [128, 256],
  'cursor-3': [128, 256],
  'cursor-4': [128, 256],
  'cursor-5': [128, 256],
  'cursor-6': [128, 256],
  // envelope renders at 400-440 px wide
  'envelope-closed': [400, 577],
  'envelope-open': [421],
  // vinyl disc renders at 172-220 px
  'vinyl-record': [256, 440],
  angel: [240, 360],
  minstrel: [260, 390]
};

// Letter paper is cut into pieces so it can grow with the text (see plan.md):
// top = rows [0,M), bottom = rows [M,H), ext = mirror/normal band of H_BAND rows around M.
const LETTER = { M: 296, H_BAND: 64 };
// Page background colour. The floral overlay used `mix-blend-mode:multiply`; because the
// page behind it is (almost) this one flat colour, multiplying once at build time gives the
// same pixels with a plain, GPU-cheap normal blend.
const BG = [0xfd, 0xed, 0xad];

const report = [];
const fmtKB = (n) => (n / 1024).toFixed(1) + ' KB';

async function writeBoth(base, buf, width, origBytes, extra = {}) {
  const img = sharp(buf);
  const avif = await img.clone().avif(AVIF).toBuffer();
  const webp = await img.clone().webp(WEBP).toBuffer();
  const png = await img.clone().png(extra.fullPng ? { compressionLevel: 9, effort: 10 } : PNG).toBuffer();
  const f = `${base}-${width}`;
  await fs.writeFile(path.join(OUT, `${f}.avif`), avif);
  await fs.writeFile(path.join(OUT, `${f}.webp`), webp);
  await fs.writeFile(path.join(OUT, `${f}.png`), png);
  report.push({ file: f, width, original: origBytes, avif: avif.length, webp: webp.length, pngFallback: png.length });
  console.log(
    `${f.padEnd(26)} avif ${fmtKB(avif.length).padStart(9)}  webp ${fmtKB(webp.length).padStart(9)}  png ${fmtKB(png.length).padStart(9)}`
  );
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  for (const [name, widths] of Object.entries(SPEC)) {
    const file = path.join(IN, `${name}.png`);
    const origBytes = (await fs.stat(file)).size;
    const meta = await sharp(file).metadata();
    for (const w of widths) {
      const width = Math.min(w, meta.width);
      const buf =
        width === meta.width
          ? await sharp(file).png().toBuffer()
          : await sharp(file).resize({ width, kernel: 'lanczos3' }).png().toBuffer();
      await writeBoth(name, buf, width, origBytes);
    }
  }

  // floral overlay: bake the multiply against the flat page colour
  {
    const file = path.join(IN, 'floral-overlay.png');
    const origBytes = (await fs.stat(file)).size;
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.round((data[i] * BG[0]) / 255);
      data[i + 1] = Math.round((data[i + 1] * BG[1]) / 255);
      data[i + 2] = Math.round((data[i + 2] * BG[2]) / 255);
    }
    const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    await writeBoth('floral-tile', buf, info.width, origBytes);
  }

  // letter paper pieces
  {
    const file = path.join(IN, 'letter-page.png');
    const origBytes = (await fs.stat(file)).size;
    const { width: W, height: H } = await sharp(file).metadata();
    const { M, H_BAND } = LETTER;
    const top = await sharp(file).extract({ left: 0, top: 0, width: W, height: M }).png().toBuffer();
    const bot = await sharp(file).extract({ left: 0, top: M, width: W, height: H - M }).png().toBuffer();
    const band = await sharp(file).extract({ left: 0, top: M - H_BAND, width: W, height: H_BAND }).png().toBuffer();
    const flipped = await sharp(band).flip().toBuffer();
    // extension tile = [mirrored band, normal band]; stacked k times it is seamless against the
    // top piece (which ends with the band) and against the bottom piece (which follows the band).
    const ext = await sharp({ create: { width: W, height: H_BAND * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: flipped, left: 0, top: 0 }, { input: band, left: 0, top: H_BAND }])
      .png()
      .toBuffer();
    await writeBoth('letter-top', top, W, origBytes, { fullPng: true });
    await writeBoth('letter-bottom', bot, W, origBytes, { fullPng: true });
    await writeBoth('letter-ext', ext, W, origBytes, { fullPng: true });
    await fs.writeFile(
      path.join(OUT, 'letter-meta.json'),
      JSON.stringify({ width: W, height: H, split: M, band: H_BAND })
    );
  }

  // favicon from the sun illustration (stops the browser requesting a missing /favicon.ico)
  await sharp(path.join(IN, 'cursor-5.png')).resize({ width: 64, height: 64, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png(PNG).toFile(path.join(OUT, 'favicon-64.png'));

  await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'docs/image-report.json'), JSON.stringify(report, null, 2));
  const tot = report.reduce((a, r) => a + r.avif, 0);
  console.log(`\nTotal generated AVIF: ${fmtKB(tot)} across ${report.length} variants (x3 formats)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
