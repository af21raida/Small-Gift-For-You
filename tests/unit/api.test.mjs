// Integration tests: the real Netlify Function handlers + the real supabase/schema.sql (PGlite) + a storage fake.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import gifts from '../../netlify/functions/gifts.mjs';
import photos from '../../netlify/functions/photos.mjs';
import { cleanup } from '../../netlify/lib/handlers.mjs';
import { startFakeSupabase } from '../support/fake-supabase.mjs';

let fake; let ipN = 0;
const JPEG = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 1)]);
const newIp = () => `203.0.113.${++ipN}`;
const token = (n = 43) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256))).toString('base64url').slice(0, n);
const songs = (n = 1) => Array.from({ length: n }, (_, i) => ({ title: 'Song ' + i, artist: 'X', url: 'builtin:song-1' }));

async function call(fn, method, path, { body, headers = {}, ip = newIp(), params = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fn(new Request('https://site.test' + path, init), { ip, params });
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
const upload = (buf, type = 'image/jpeg', ip) => call(photos, 'POST', '/api/photos', { raw: buf, headers: { 'content-type': type }, ip });
const create = (over = {}, ip) => call(gifts, 'POST', '/api/gifts', { body: { message: 'Hello my love', songs: songs(), photos: [], manageKey: token(), idempotencyKey: token(24), ...over }, ip });
const get = (code, ip) => call(gifts, 'GET', '/api/gifts/' + code, { params: { code }, ip });
const del = (code, key, ip) => call(gifts, 'DELETE', '/api/gifts/' + code, { params: { code }, headers: key ? { authorization: 'Bearer ' + key } : {}, ip });

before(async () => { fake = await startFakeSupabase(); Object.assign(process.env, fake.env); });
after(async () => { await fake.close(); });

test('backend not configured -> 503 backend_not_configured (never a fake success)', async () => {
  const saved = { ...process.env }; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await create(); assert.equal(r.status, 503); assert.equal(r.data.error, 'backend_not_configured');
    assert.equal((await get('0'.repeat(20))).status, 503);
  } finally { Object.assign(process.env, saved); }
});

test('create + read: zero photos, one song -> 20-char code, recipient gets exact content', async () => {
  const r = await create({ message: 'Line1\nLine2', songs: songs(1) });
  assert.equal(r.status, 201); assert.match(r.data.code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  const g = await get(r.data.code);
  assert.equal(g.status, 200); assert.equal(g.data.message, 'Line1\nLine2'); assert.equal(g.data.songs.length, 1); assert.deepEqual(g.data.photos, []);
  assert.equal(g.headers.get('cache-control'), 'no-store');
});
test('lowercase code in the URL still resolves', async () => {
  const { data } = await create(); assert.equal((await get(data.code.toLowerCase())).status, 200);
});
test('ten songs ok; eleven and zero rejected server-side', async () => {
  assert.equal((await create({ songs: songs(10) })).status, 201);
  const r11 = await create({ songs: songs(11) }); assert.equal(r11.status, 400); assert.equal(r11.data.error, 'invalid_input');
  assert.equal((await create({ songs: [] })).status, 400);
});
test('long letter (10,000 chars) round-trips; 10,001 rejected', async () => {
  const msg = ('Dearest, ' + 'x'.repeat(90) + '\n').repeat(100).slice(0, 10000);
  const r = await create({ message: msg }); assert.equal(r.status, 201);
  assert.equal((await get(r.data.code)).data.message, msg);
  assert.equal((await create({ message: msg + 'y' })).status, 400);
});
test('idempotency: a retried save returns the SAME code and creates one gift', async () => {
  const body = { message: 'once', manageKey: token(), idempotencyKey: token(24) }; const ip = newIp();
  const a = await create(body, ip), b = await create(body, ip);
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.data.code, b.data.code);
  assert.equal((await fake.db.query("select count(*)::int n from gifts where message='once'")).rows[0].n, 1);
});
test('idempotency: 6 simultaneous identical saves -> one gift', async () => {
  const body = { message: 'parallel', manageKey: token(), idempotencyKey: token(24) };
  const rs = await Promise.all(Array.from({ length: 6 }, () => create(body, newIp())));
  assert.equal(new Set(rs.map((r) => r.data.code)).size, 1);
  assert.equal((await fake.db.query("select count(*)::int n from gifts where message='parallel'")).rows[0].n, 1);
});
test('idempotency key reused with a different manage key is rejected (no hijack)', async () => {
  const k = token(24); await create({ idempotencyKey: k, manageKey: token() });
  const r = await create({ idempotencyKey: k, manageKey: token() }); assert.equal(r.status, 409);
});
test('manage key is stored only as a SHA-256 hash', async () => {
  const mk = token(); const { data } = await create({ manageKey: mk });
  const row = (await fake.db.query('select manage_key_hash h from gifts where code=$1', [data.code])).rows[0];
  assert.match(row.h, /^[0-9a-f]{64}$/); assert.notEqual(row.h, mk);
});
test('code collision is handled by the database (no overwrite)', async () => {
  const { data } = await create({ message: 'original' });
  const r = await fake.db.query("select * from create_gift($1,'overwrite','[]'::jsonb,'[]'::jsonb,'h',null)", [data.code]);
  assert.equal(r.rows[0].status, 'collision');
  assert.equal((await get(data.code)).data.message, 'original');
});

test('invalid / unknown codes -> 404; unknown valid-format code -> 404', async () => {
  assert.equal((await get('short')).status, 404);
  assert.equal((await get('0'.repeat(20))).status, 404);
  assert.equal((await call(gifts, 'GET', '/api/gifts', { params: {} })).status, 404);
});
test('brute-force guessing is throttled (429 after repeated misses from one client)', async () => {
  const ip = newIp(); let last;
  for (let i = 0; i < 25; i++) last = await get('Z'.repeat(20), ip);
  assert.equal(last.status, 429);
});
test('gift creation is rate limited (5th create within a minute -> 429)', async () => {
  const ip = newIp(); const st = [];
  for (let i = 0; i < 5; i++) st.push((await create({ idempotencyKey: token(24) }, ip)).status);
  assert.deepEqual(st, [201, 201, 201, 201, 429]);
});
test('cross-origin browser requests are rejected', async () => {
  const res = await gifts(new Request('https://site.test/api/gifts', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }), { ip: newIp() });
  assert.equal(res.status, 403);
});
test('malformed JSON / wrong content-type / oversize body', async () => {
  assert.equal((await call(gifts, 'POST', '/api/gifts', { raw: '{nope', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await call(gifts, 'POST', '/api/gifts', { raw: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(gifts, 'POST', '/api/gifts', { raw: JSON.stringify({ message: 'x'.repeat(70000) }), headers: { 'content-type': 'application/json' } })).status, 413);
});
test('errors never leak internals', async () => {
  const r = await create({ songs: 'nope' }); assert.ok(!JSON.stringify(r.data).includes('SUPABASE'));
});

test('photo upload: valid JPEG and PNG accepted and stored privately', async () => {
  const a = await upload(JPEG()); assert.equal(a.status, 201); assert.match(a.data.id, /^[0-9a-f-]{36}$/);
  const b = await upload(PNG(), 'image/png'); assert.equal(b.status, 201);
  assert.equal((await fake.db.query('select mime from photos where id=$1', [a.data.id])).rows[0].mime, 'image/jpeg');
});
test('photo upload validation: wrong type, spoofed type, empty, >1.5 MB, html/svg', async () => {
  assert.equal((await upload(JPEG(), 'application/pdf')).status, 415);
  assert.equal((await upload(JPEG(), 'image/png')).status, 415);               // declared PNG, bytes are JPEG
  assert.equal((await upload(Buffer.from('<svg onload=alert(1)>'), 'image/jpeg')).status, 415);
  assert.equal((await upload(Buffer.alloc(0), 'image/jpeg')).status, 400);
  const big = await upload(JPEG(1500001), 'image/jpeg'); assert.equal(big.status, 413); assert.equal(big.data.error, 'payload_too_large');
  assert.equal((await upload(JPEG(1499990), 'image/jpeg')).status, 201);
});
test('gift with five uploaded photos: ordered, signed URLs actually download', async () => {
  const ids = []; for (let i = 0; i < 5; i++) ids.push((await upload(JPEG(1000 + i))).data.id);
  const r = await create({ photos: ids.map((id) => ({ id })) }); assert.equal(r.status, 201);
  const g = await get(r.data.code); assert.equal(g.data.photos.length, 5);
  for (let i = 0; i < 5; i++) {
    const res = await fetch(g.data.photos[i].url); assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 1004 + i);              // order preserved
  }
  assert.equal(fake.db && (await fake.db.query('select count(*)::int n from photos where gift_id is not null')).rows[0].n >= 5, true);
});
test('six photos rejected; photo reuse across gifts rejected; unknown id rejected', async () => {
  const ids = []; for (let i = 0; i < 6; i++) ids.push((await upload(JPEG())).data.id);
  assert.equal((await create({ photos: ids.map((id) => ({ id })) })).data.error, 'photo_limit');
  const one = ids[0]; assert.equal((await create({ photos: [{ id: one }] })).status, 201);
  const again = await create({ photos: [{ id: one }] }); assert.equal(again.status, 400);
  assert.equal((await create({ photos: [{ id: '11111111-1111-4111-8111-111111111111' }] })).status, 400);
});
test('external photo links: https accepted and flagged external; http/localhost rejected', async () => {
  const ok = await create({ photos: [{ url: 'https://images.example.com/p.jpg' }] }); assert.equal(ok.status, 201);
  assert.deepEqual((await get(ok.data.code)).data.photos, [{ url: 'https://images.example.com/p.jpg', external: true }]);
  assert.equal((await create({ photos: [{ url: 'http://images.example.com/p.jpg' }] })).status, 400);
  assert.equal((await create({ photos: [{ url: 'https://localhost/p.jpg' }] })).status, 400);
});
test('photo upload is rate limited', async () => {
  const ip = newIp(); let last; for (let i = 0; i < 16; i++) last = await upload(JPEG(), 'image/jpeg', ip);
  assert.equal(last.status, 429);
});

test('deletion: needs the manage key; wrong key / missing key cannot delete; storage + rows wiped', async () => {
  const pid = (await upload(JPEG())).data.id; const mk = token();
  const { data } = await create({ manageKey: mk, photos: [{ id: pid }], message: 'secret words' });
  assert.equal((await del(data.code, null)).status, 401);
  assert.equal((await del(data.code, token())).status, 403);
  assert.equal((await get(data.code)).status, 200, 'still readable after failed deletes');
  const before = fake.objects.size;
  assert.equal((await del(data.code, mk)).status, 200);
  assert.equal(fake.objects.size, before - 1);
  const g = await get(data.code); assert.equal(g.status, 410); assert.equal(g.data.error, 'gone');
  const row = (await fake.db.query('select message, songs, photos, deleted_at from gifts where code=$1', [data.code])).rows[0];
  assert.equal(row.message, ''); assert.deepEqual(row.songs, []); assert.ok(row.deleted_at);
  assert.equal((await del(data.code, mk)).status, 410);
});
test('a gift cannot be modified through the API (no update route)', async () => {
  const { data } = await create();
  for (const m of ['PUT', 'PATCH']) assert.equal((await call(gifts, m, '/api/gifts/' + data.code, { params: { code: data.code }, body: { message: 'hacked' } })).status, 405);
  assert.notEqual((await get(data.code)).data.message, 'hacked');
});

test('database lockdown: anon / authenticated roles can read and execute nothing', async () => {
  const { data } = await create();
  for (const role of ['anon', 'authenticated']) {
    await fake.db.exec(`set role ${role}`);
    try {
      await assert.rejects(fake.db.query('select * from public.gifts'), /permission denied/i);
      await assert.rejects(fake.db.query('select * from public.photos'), /permission denied/i);
      await assert.rejects(fake.db.query('select * from public.rate_limits'), /permission denied/i);
      await assert.rejects(fake.db.query("select * from public.get_gift($1)", [data.code]), /permission denied/i);
      await assert.rejects(fake.db.query("select * from public.delete_gift($1,'x')", [data.code]), /permission denied/i);
    } finally { await fake.db.exec('reset role'); }
  }
  await fake.db.exec('set role service_role');
  try { assert.equal((await fake.db.query('select status from public.get_gift($1)', [data.code])).rows[0].status, 'ok'); } finally { await fake.db.exec('reset role'); }
});
test('RLS is enabled and forced on every table, with zero policies', async () => {
  const r = await fake.db.query("select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('gifts','photos','rate_limits') and relkind='r'");
  assert.equal(r.rows.length, 3); for (const x of r.rows) { assert.equal(x.relrowsecurity, true); assert.equal(x.relforcerowsecurity, true); }
  assert.equal((await fake.db.query("select count(*)::int n from pg_policies where schemaname='public'")).rows[0].n, 0);
});
test('database constraints reject bad codes and oversized arrays directly', async () => {
  await assert.rejects(fake.db.query("insert into gifts (code,manage_key_hash) values ('lowercase-code-bad!!','h')"), /gifts_code_format/);
  await assert.rejects(fake.db.query("insert into gifts (code,manage_key_hash,songs) values ('0000000000000000000A','h','[1,2,3,4,5,6,7,8,9,10,11]')"), /gifts_songs_array/);
});

test('cleanup removes unattached uploads older than 24 h, keeps fresh ones and attached ones', async () => {
  const old = (await upload(JPEG())).data.id, fresh = (await upload(JPEG())).data.id;
  const att = (await upload(JPEG())).data.id; await create({ photos: [{ id: att }] });
  await fake.db.query("update photos set created_at = now() - interval '25 hours' where id = $1", [old]);
  const before = fake.objects.size; await cleanup();
  const left = (await fake.db.query('select id from photos where id = any($1::uuid[])', [[old, fresh, att]])).rows.map((r) => r.id);
  assert.ok(!left.includes(old)); assert.ok(left.includes(fresh)); assert.ok(left.includes(att));
  assert.equal(fake.objects.size, before - 1);
});
test('an expired unattached upload can no longer be attached to a gift', async () => {
  const id = (await upload(JPEG())).data.id;
  await fake.db.query("update photos set created_at = now() - interval '25 hours' where id = $1", [id]);
  assert.equal((await create({ photos: [{ id }] })).status, 400);
});
test('upstream outage surfaces as a 5xx error, never as success', async () => {
  const saved = process.env.SUPABASE_URL; process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  try { const r = await create(); assert.ok(r.status >= 500, 'status ' + r.status); assert.ok(!r.data.code); }
  finally { process.env.SUPABASE_URL = saved; }
});
