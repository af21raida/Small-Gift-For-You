// A local stand-in for Supabase used ONLY by tests / the local dev server.
//   * Database: PGlite (a real PostgreSQL engine in WASM) running the project's real supabase/schema.sql,
//     exposed through a minimal PostgREST-style  POST /rest/v1/rpc/<fn>  endpoint.
//   * Storage : in-memory objects with the same REST shape the functions use (upload / sign / remove)
//     and a GET endpoint that serves signed URLs so images can actually be displayed in browser tests.
// It does NOT prove anything about the real Supabase service (auth keys, quotas, limits) — see docs/TEST-REPORT.md.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startFakeSupabase({ serviceKey = 'test-service-role-key', port = 0 } = {}) {
  const db = new PGlite();
  // Roles that exist on real Supabase (needed so schema.sql's REVOKE/GRANT/RLS sections really run).
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
                 create schema if not exists storage;`);
  await db.exec(await fs.readFile(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  // run twice: the schema must be idempotent
  await db.exec(await fs.readFile(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));

  const objects = new Map();          // "<bucket>/<path>" -> {bytes, type}
  const tokens = new Map();           // download token -> "<bucket>/<path>"
  const upTokens = new Map();         // one-time upload token -> {bucket, path}
  const stats = { uploads: 0, removes: 0, rpcCalls: 0, directUploads: 0 };
  let base = '';
  // Same limits as the buckets created by supabase/schema.sql
  const BUCKETS = {
    'gift-photos': { limit: 1500000, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
    'gift-audio': { limit: 10000000, mimes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm'] },
  };
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-upsert, cache-control, x-client-info, range, x-test-ip', 'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges' };

  const readBody = (req) => new Promise((res) => { const a = []; req.on('data', (d) => a.push(d)); req.on('end', () => res(Buffer.concat(a))); });
  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isBuf ? (headers['Content-Type'] || 'application/octet-stream') : 'application/json', ...CORS, ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };
  /** Serve an object, honouring a single Range header (needed for audio seeking and for the server-side "peek"). */
  const serve = (req, res, o) => {
    const total = o.bytes.length; const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const h = { 'Content-Type': o.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    if (!m) return send(res, 200, o.bytes, h);
    let a = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]); let b = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    if (a >= total) return send(res, 416, { error: 'range' }, { 'Content-Range': `bytes */${total}` });
    return send(res, 206, o.bytes.subarray(a, b + 1), { ...h, 'Content-Range': `bytes ${a}-${b}/${total}` });
  };
  /** Pull the file part out of a multipart/form-data body (what supabase-js sends for signed uploads). */
  const parseMultipart = (buf, ctype) => {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || ''); if (!m) return null;
    const delim = Buffer.from('--' + (m[1] || m[2]));
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const next = buf.indexOf(delim, pos + delim.length); if (next === -1) break;
      const part = buf.subarray(pos + delim.length + 2, next - 2);               // strip CRLF around the part
      const sep = part.indexOf('\r\n\r\n');
      if (sep !== -1) {
        const head = part.subarray(0, sep).toString('latin1');
        if (/filename=/i.test(head) || /name=""/.test(head)) return { bytes: part.subarray(sep + 4), type: ((/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || 'text/plain').trim() };
      }
      pos = next;
    }
    return null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') return send(res, 204, Buffer.alloc(0), { 'Access-Control-Max-Age': '600' });
      // Signed-URL download (no auth header, token in the query string — like real Supabase)
      const dl = /^\/storage\/v1\/object\/sign\/(gift-photos|gift-audio)\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && dl) {
        const key = dl[1] + '/' + decodeURIComponent(dl[2]);
        const tok = url.searchParams.get('token');
        if (!tok || tokens.get(tok) !== key || !objects.has(key)) return send(res, 400, { error: 'InvalidJWT' });
        return serve(req, res, objects.get(key));
      }
      // Direct browser upload to a one-time signed URL (no auth header; the token is the credential)
      const upl = /^\/storage\/v1\/object\/upload\/sign\/(gift-photos|gift-audio)\/(.+)$/.exec(url.pathname);
      if (req.method === 'PUT' && upl) {
        const bucket = upl[1], p = decodeURIComponent(upl[2]); const t = upTokens.get(url.searchParams.get('token') || '');
        if (!t || t.bucket !== bucket || t.path !== p) return send(res, 400, { error: 'InvalidJWT', message: 'invalid upload token' });
        const part = parseMultipart(await readBody(req), req.headers['content-type']);
        if (!part) return send(res, 400, { error: 'invalid_multipart' });
        const B = BUCKETS[bucket];
        if (part.bytes.length > B.limit) return send(res, 413, { error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        if (!B.mimes.includes(part.type)) return send(res, 415, { error: 'invalid_mime_type', message: `mime type ${part.type} is not supported` });
        if (objects.has(bucket + '/' + p)) return send(res, 409, { error: 'Duplicate' });
        upTokens.delete(url.searchParams.get('token'));                          // single use
        objects.set(bucket + '/' + p, { bytes: part.bytes, type: part.type }); stats.directUploads++;
        return send(res, 200, { Key: bucket + '/' + p });
      }
      const auth = req.headers.authorization === 'Bearer ' + serviceKey && req.headers.apikey === serviceKey;
      if (!auth) return send(res, 401, { message: 'Invalid API key' });

      const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
      if (req.method === 'POST' && rpc) {
        stats.rpcCalls++;
        const args = JSON.parse((await readBody(req)).toString() || '{}');
        const keys = Object.keys(args);
        const sql = `select * from public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
        try {
          const r = await db.query(sql, keys.map((k) => args[k]));
          const cols = r.fields.map((f) => f.name);
          if (cols.length === 1 && cols[0] === rpc[1]) return send(res, 200, r.rows[0][rpc[1]]);   // scalar function
          return send(res, 200, r.rows);
        } catch (e) { return send(res, 400, { message: e.message }); }
      }

      const up = /^\/storage\/v1\/object\/(gift-photos|gift-audio)\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && up) {
        const bucket = up[1], key = bucket + '/' + decodeURIComponent(up[2]);
        if (objects.has(key)) return send(res, 409, { error: 'Duplicate' });
        const bytes = await readBody(req);
        if (bytes.length > BUCKETS[bucket].limit) return send(res, 413, { error: 'Payload too large' });
        objects.set(key, { bytes, type: req.headers['content-type'] });
        stats.uploads++;
        return send(res, 200, { Key: key });
      }
      const usign = /^\/storage\/v1\/object\/upload\/sign\/(gift-photos|gift-audio)\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && usign) {                                       // authorise one direct upload
        const t = crypto.randomBytes(16).toString('hex'); upTokens.set(t, { bucket: usign[1], path: decodeURIComponent(usign[2]) });
        return send(res, 200, { url: `/object/upload/sign/${usign[1]}/${usign[2]}?token=${t}` });
      }
      const sign = /^\/storage\/v1\/object\/sign\/(gift-photos|gift-audio)$/.exec(url.pathname);
      if (req.method === 'POST' && sign) {
        const { paths } = JSON.parse((await readBody(req)).toString());
        return send(res, 200, paths.map((p) => {
          const key = sign[1] + '/' + p;
          if (!objects.has(key)) return { path: p, signedURL: null, error: 'Object not found' };
          const t = crypto.randomBytes(16).toString('hex'); tokens.set(t, key);
          return { path: p, signedURL: `/object/sign/${sign[1]}/${encodeURIComponent(p)}?token=${t}`, error: null };
        }));
      }
      const authGet = /^\/storage\/v1\/object\/authenticated\/(gift-photos|gift-audio)\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && authGet) {
        const key = authGet[1] + '/' + decodeURIComponent(authGet[2]);
        if (!objects.has(key)) return send(res, 400, { error: 'not_found', message: 'Object not found' });
        return serve(req, res, objects.get(key));
      }
      const rm = /^\/storage\/v1\/object\/(gift-photos|gift-audio)$/.exec(url.pathname);
      if (req.method === 'DELETE' && rm) {
        const { prefixes } = JSON.parse((await readBody(req)).toString());
        for (const p of prefixes) { objects.delete(rm[1] + '/' + p); stats.removes++; }
        return send(res, 200, prefixes.map((name) => ({ name })));
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { message: String(e && e.message) }); }
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base, serviceKey, db, objects, stats,
    env: { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: serviceKey, RATE_LIMIT_SALT: 'test-salt' },
    async close() { await new Promise((r) => server.close(r)); await db.close(); },
  };
}
