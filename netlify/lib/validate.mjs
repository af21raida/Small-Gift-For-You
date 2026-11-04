// Server-side validation + secure identifier generation. Mirrors the limits in src/js/app.js.
import crypto from 'node:crypto';
import { ApiError } from './http.mjs';

export const LIMITS = {
  MIN_SONGS: 1, MAX_SONGS: 10, MAX_PHOTOS: 5, MAX_MESSAGE: 10000,
  MAX_TITLE: 120, MAX_URL: 500, MAX_PHOTO_BYTES: 1500000,
};

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32 (no I L O U)
export const CODE_LEN = 20;                                         // 20 x 5 bits = 100 bits of entropy
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CSPRNG gift code. 256 is divisible by 32, so `byte & 31` is perfectly uniform (no modulo bias). */
export function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b & 31];
  return s;
}
export const isCode = (s) => typeof s === 'string' && CODE_RE.test(s);
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** https URL, no credentials, no localhost / IP literal / single-label host. Returns the normalised href or null. */
export function cleanHttpsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.MAX_URL) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null;
  if (u.href.length > LIMITS.MAX_URL) return null;
  return u.href;
}

const stripControl = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export function validateGiftInput(body) {
  const bad = (msg) => new ApiError(400, 'invalid_input', msg);

  if (typeof body.message !== 'string') throw bad('The letter text is missing.');
  const message = stripControl(body.message).replace(/\r\n?/g, '\n');
  if (message.length > LIMITS.MAX_MESSAGE) throw bad(`The letter is too long (limit ${LIMITS.MAX_MESSAGE} characters).`);

  if (!Array.isArray(body.songs)) throw bad('The playlist is missing.');
  if (body.songs.length < LIMITS.MIN_SONGS) throw bad('Add at least one song.');
  if (body.songs.length > LIMITS.MAX_SONGS) throw bad(`You can add up to ${LIMITS.MAX_SONGS} songs.`);
  const songs = body.songs.map((s, i) => {
    if (!s || typeof s !== 'object') throw bad(`Song ${i + 1} is not valid.`);
    const title = typeof s.title === 'string' ? stripControl(s.title).trim() : '';
    const artist = typeof s.artist === 'string' ? stripControl(s.artist).trim() : '';
    if (!title || title.length > LIMITS.MAX_TITLE) throw bad(`Song ${i + 1} needs a title (up to ${LIMITS.MAX_TITLE} characters).`);
    if (artist.length > LIMITS.MAX_TITLE) throw bad(`Song ${i + 1} has a very long artist name.`);
    let url = typeof s.url === 'string' ? s.url : '';
    if (/^builtin:song-[1-3]$/.test(url)) { /* bundled track */ }
    else { url = cleanHttpsUrl(url); if (!url) throw bad(`Song ${i + 1} needs a valid https:// audio link.`); }
    return { title, artist, url };
  });

  const rawPhotos = body.photos === undefined ? [] : body.photos;
  if (!Array.isArray(rawPhotos)) throw bad('The photos list is not valid.');
  if (rawPhotos.length > LIMITS.MAX_PHOTOS) throw new ApiError(400, 'photo_limit', `You can add up to ${LIMITS.MAX_PHOTOS} photos.`);
  const seen = new Set();
  const photos = rawPhotos.map((p, i) => {
    if (!p || typeof p !== 'object') throw bad(`Photo ${i + 1} is not valid.`);
    if (typeof p.id === 'string') {
      if (!UUID_RE.test(p.id) || seen.has(p.id.toLowerCase())) throw bad(`Photo ${i + 1} is not valid.`);
      seen.add(p.id.toLowerCase());
      return { type: 'stored', id: p.id.toLowerCase() };
    }
    const url = cleanHttpsUrl(p.url);
    if (!url) throw bad(`Photo ${i + 1} needs a valid https:// link.`);
    return { type: 'external', url };
  });

  if (typeof body.manageKey !== 'string' || !TOKEN_RE.test(body.manageKey)) throw bad('Missing management key.');
  let idem = null;
  if (body.idempotencyKey !== undefined) {
    if (typeof body.idempotencyKey !== 'string' || !TOKEN_RE.test(body.idempotencyKey)) throw bad('Invalid request key.');
    idem = sha256('idem:' + body.idempotencyKey);
  }
  return { message, songs, photos, manageHash: sha256(body.manageKey), idemHash: idem };
}

/** Identify image bytes by magic number (never trust the declared Content-Type alone). */
export function sniffImage(buf) {
  const b = buf;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}
