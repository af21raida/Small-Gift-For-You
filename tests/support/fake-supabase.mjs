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

  const objects = new Map();          // path -> {bytes, type}
  const tokens = new Map();           // token -> path
  const stats = { uploads: 0, removes: 0, rpcCalls: 0 };
  let base = '';

  const readBody = (req) => new Promise((res) => { const a = []; req.on('data', (d) => a.push(d)); req.on('end', () => res(Buffer.concat(a))); });
  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isBuf ? (headers['Content-Type'] || 'application/octet-stream') : 'application/json', ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      // Signed-URL download (no auth header, token in the query string — like real Supabase)
      const dl = /^\/storage\/v1\/object\/sign\/gift-photos\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && dl) {
        const p = decodeURIComponent(dl[1]);
        const tok = url.searchParams.get('token');
        if (!tok || tokens.get(tok) !== p || !objects.has(p)) return send(res, 400, { error: 'InvalidJWT' });
        const o = objects.get(p);
        return send(res, 200, o.bytes, { 'Content-Type': o.type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=3600' });
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

      const up = /^\/storage\/v1\/object\/gift-photos\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && up) {
        const p = decodeURIComponent(up[1]);
        if (objects.has(p)) return send(res, 409, { error: 'Duplicate' });
        const bytes = await readBody(req);
        if (bytes.length > 1500000) return send(res, 413, { error: 'Payload too large' });
        objects.set(p, { bytes, type: req.headers['content-type'] });
        stats.uploads++;
        return send(res, 200, { Key: 'gift-photos/' + p });
      }
      if (req.method === 'POST' && url.pathname === '/storage/v1/object/sign/gift-photos') {
        const { paths } = JSON.parse((await readBody(req)).toString());
        return send(res, 200, paths.map((p) => {
          if (!objects.has(p)) return { path: p, signedURL: null, error: 'Object not found' };
          const t = crypto.randomBytes(16).toString('hex'); tokens.set(t, p);
          return { path: p, signedURL: `/object/sign/gift-photos/${encodeURIComponent(p)}?token=${t}`, error: null };
        }));
      }
      if (req.method === 'DELETE' && url.pathname === '/storage/v1/object/gift-photos') {
        const { prefixes } = JSON.parse((await readBody(req)).toString());
        for (const p of prefixes) { objects.delete(p); stats.removes++; }
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
