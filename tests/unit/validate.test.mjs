import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, isCode, CODE_ALPHABET, CODE_LEN, cleanHttpsUrl, validateGiftInput, sniffImage, sniffAudio, LIMITS } from '../../netlify/lib/validate.mjs';

const base = () => ({ message: 'hi', songs: [{ title: 'A', artist: 'B', url: 'builtin:song-1' }], photos: [], manageKey: 'm'.repeat(43), idempotencyKey: 'i'.repeat(24) });

test('gift codes: 20 chars, URL-safe Crockford alphabet', () => {
  for (let i = 0; i < 200; i++) { const c = generateCode(); assert.equal(c.length, CODE_LEN); assert.ok(isCode(c)); assert.match(c, /^[0-9A-Z]+$/); }
  assert.ok(!/[ILOU]/.test(Array.from({ length: 500 }, generateCode).join('')));
});
test('gift codes: no duplicates in 50,000 draws and roughly uniform characters', () => {
  const seen = new Set(); const freq = Object.fromEntries([...CODE_ALPHABET].map((c) => [c, 0]));
  for (let i = 0; i < 50000; i++) { const c = generateCode(); assert.ok(!seen.has(c)); seen.add(c); for (const ch of c) freq[ch]++; }
  const exp = (50000 * CODE_LEN) / 32;
  for (const [ch, n] of Object.entries(freq)) assert.ok(Math.abs(n - exp) / exp < 0.03, `char ${ch} frequency ${n} vs ${exp}`);
});
test('isCode rejects malformed codes', () => {
  for (const bad of ['', 'abc', 'A'.repeat(19), 'A'.repeat(21), 'I'.repeat(20), 'O'.repeat(20), 'a'.repeat(20), "0".repeat(19) + '-', null, undefined, 5]) assert.equal(isCode(bad), false, String(bad));
  assert.equal(isCode('0123456789ABCDEFGHJK'), true);
});
test('cleanHttpsUrl', () => {
  assert.equal(cleanHttpsUrl('https://example.com/a.mp3'), 'https://example.com/a.mp3');
  for (const bad of ['http://example.com/a', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pw@example.com/', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://intranet/a', 'https://x.local/a', 'https://example.com/' + 'a'.repeat(500), '', null, 5]) assert.equal(cleanHttpsUrl(bad), null, String(bad));
});
test('validateGiftInput: accepts 1 and 10 songs, rejects 0 and 11', () => {
  const song = (i) => ({ title: 'T' + i, artist: '', url: 'builtin:song-1' });
  const ok1 = validateGiftInput({ ...base(), songs: [song(1)] }); assert.equal(ok1.songs.length, 1);
  const ok10 = validateGiftInput({ ...base(), songs: Array.from({ length: 10 }, (_, i) => song(i)) }); assert.equal(ok10.songs.length, 10);
  assert.throws(() => validateGiftInput({ ...base(), songs: [] }), /at least one song/);
  assert.throws(() => validateGiftInput({ ...base(), songs: Array.from({ length: 11 }, (_, i) => song(i)) }), /up to 10 songs/);
});
test('validateGiftInput: message limits, newlines and control characters', () => {
  assert.equal(validateGiftInput({ ...base(), message: 'x'.repeat(LIMITS.MAX_MESSAGE) }).message.length, LIMITS.MAX_MESSAGE);
  assert.throws(() => validateGiftInput({ ...base(), message: 'x'.repeat(LIMITS.MAX_MESSAGE + 1) }), /too long/);
  assert.equal(validateGiftInput({ ...base(), message: 'a\r\nb\u0000c' }).message, 'a\nbc');
  assert.throws(() => validateGiftInput({ ...base(), message: 5 }));
});
test('validateGiftInput: photos (0, 5, 6, duplicates, bad ids, external urls)', () => {
  const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  assert.equal(validateGiftInput(base()).photos.length, 0);
  assert.equal(validateGiftInput({ ...base(), photos: [1, 2, 3, 4, 5].map((n) => ({ id: id(n) })) }).photos.length, 5);
  assert.throws(() => validateGiftInput({ ...base(), photos: [1, 2, 3, 4, 5, 6].map((n) => ({ id: id(n) })) }), /up to 5 photos/);
  assert.throws(() => validateGiftInput({ ...base(), photos: [{ id: id(1) }, { id: id(1) }] }));
  assert.throws(() => validateGiftInput({ ...base(), photos: [{ id: 'not-a-uuid' }] }));
  assert.throws(() => validateGiftInput({ ...base(), photos: [{ url: 'http://example.com/a.jpg' }] }));
  assert.deepEqual(validateGiftInput({ ...base(), photos: [{ url: 'https://example.com/a.jpg' }] }).photos, [{ type: 'external', url: 'https://example.com/a.jpg' }]);
});
test('validateGiftInput: song urls and keys', () => {
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: 'x', url: 'builtin:song-9' }] }));
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: 'x', url: 'http://e.com/a.mp3' }] }));
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: '', url: 'builtin:song-1' }] }));
  assert.throws(() => validateGiftInput({ ...base(), manageKey: 'short' }));
  assert.throws(() => validateGiftInput({ ...base(), manageKey: undefined }));
  const v = validateGiftInput(base()); assert.match(v.manageHash, /^[0-9a-f]{64}$/); assert.notEqual(v.manageHash, base().manageKey);
});
test('sniffImage identifies by magic bytes', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).mime, 'image/jpeg');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])).mime, 'image/png');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])).mime, 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('sniffAudio identifies each supported format by magic bytes', () => {
  const pad = (a) => Buffer.concat([Buffer.from(a), Buffer.alloc(16)]);
  assert.equal(sniffAudio(pad(Buffer.from('ID3\x03'))).mime, 'audio/mpeg');
  assert.equal(sniffAudio(pad([0xff, 0xfb, 0x90, 0x00])).mime, 'audio/mpeg');             // MPEG-1 layer III frame
  assert.equal(sniffAudio(pad([0xff, 0xf1, 0x50, 0x80])).mime, 'audio/aac');              // ADTS AAC
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])).mime, 'audio/mp4');
  assert.equal(sniffAudio(pad(Buffer.from('OggS'))).mime, 'audio/ogg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])).mime, 'audio/wav');
  assert.equal(sniffAudio(pad([0x1a, 0x45, 0xdf, 0xa3])).mime, 'audio/webm');
});
test('sniffAudio rejects non-audio content', () => {
  for (const bad of ['<html><body>hi</body></html>', 'GIF89a..........', '#!/bin/sh\nrm -rf /', 'PK\x03\x04 zip data....']) assert.equal(sniffAudio(Buffer.from(bad)), null, bad);
  assert.equal(sniffAudio(Buffer.alloc(4)), null);
  assert.equal(sniffAudio(Buffer.from([0xff, 0xe8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);   // reserved MPEG version
  assert.equal(sniffAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), null); // a PNG is not audio
});
test('validateGiftInput: songs uploaded from a device are referenced by id', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const v = validateGiftInput({ ...base(), songs: [{ title: 'Mine', artist: 'Me', id }, { title: 'A', artist: '', url: 'builtin:song-1' }] });
  assert.deepEqual(v.songs[0], { title: 'Mine', artist: 'Me', id });
  assert.equal(v.songs.length, 2);
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: 'x', id }, { title: 'y', id }] }));          // same upload twice
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: 'x', id: 'not-a-uuid' }] }));
  assert.throws(() => validateGiftInput({ ...base(), songs: [{ title: '', id }] }));
});
