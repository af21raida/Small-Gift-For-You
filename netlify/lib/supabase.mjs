// Zero-dependency Supabase client for the Netlify Functions (server side only).
// Uses the PostgREST RPC endpoint and the Storage REST API with the SERVICE-ROLE key.
// That key must only ever exist in Netlify environment variables — never in browser code.

import { ApiError } from './http.mjs';

export const BUCKET = 'gift-photos';

export function config(env = process.env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!/^https?:\/\//.test(url) || !key) throw new ApiError(503, 'backend_not_configured');
  return { url, key, salt: env.RATE_LIMIT_SALT || '' };
}

function headers(c, extra = {}) {
  return { apikey: c.key, Authorization: 'Bearer ' + c.key, ...extra };
}

async function upstream(promise) {
  try {
    return await promise;
  } catch (e) {
    throw new ApiError(502, 'upstream_unreachable');
  }
}

/** Call a SQL function through PostgREST. Returns the array of rows. */
export async function rpc(c, fn, args) {
  const res = await upstream(fetch(`${c.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(c, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(args || {}),
  }));
  if (!res.ok) {
    console.error(`[supabase] rpc ${fn} -> HTTP ${res.status}`);
    throw new ApiError(502, 'upstream_error');
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export async function uploadObject(c, path, bytes, contentType) {
  const res = await upstream(fetch(`${c.url}/storage/v1/object/${BUCKET}/${encPath(path)}`, {
    method: 'POST',
    headers: headers(c, { 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=3600' }),
    body: bytes,
  }));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[supabase] storage upload -> HTTP ${res.status}`);
    if (res.status === 413 || /exceed|quota|limit/i.test(text)) throw new ApiError(507, 'quota_exceeded');
    throw new ApiError(502, 'upstream_error');
  }
}

/** Returns Map(path -> absolute signed URL) for the paths that could be signed. */
export async function signObjects(c, paths, expiresIn = 3600) {
  const out = new Map();
  if (!paths.length) return out;
  const res = await upstream(fetch(`${c.url}/storage/v1/object/sign/${BUCKET}`, {
    method: 'POST',
    headers: headers(c, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn, paths }),
  }));
  if (!res.ok) { console.error(`[supabase] storage sign -> HTTP ${res.status}`); throw new ApiError(502, 'upstream_error'); }
  const rows = await res.json();
  for (const r of rows || []) {
    if (r && r.path && r.signedURL && !r.error) {
      const rel = r.signedURL.startsWith('/storage/v1') ? r.signedURL.slice('/storage/v1'.length) : r.signedURL;
      out.set(r.path, `${c.url}/storage/v1${rel}`);
    }
  }
  return out;
}

export async function removeObjects(c, paths) {
  if (!paths || !paths.length) return;
  const res = await upstream(fetch(`${c.url}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: headers(c, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  }));
  if (!res.ok) console.error(`[supabase] storage remove -> HTTP ${res.status}`);
}
