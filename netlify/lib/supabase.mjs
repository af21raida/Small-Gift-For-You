// Zero-dependency Supabase client for the Netlify Functions (server side only).
// Uses the PostgREST RPC endpoint and the Storage REST API with the SERVICE-ROLE key.
// That key must only ever exist in Netlify environment variables — never in browser code.

import { ApiError } from './http.mjs';

export const BUCKET = 'gift-photos';            // photos
export const AUDIO_BUCKET = 'gift-audio';       // songs uploaded from the creator's device

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

export async function uploadObject(c, path, bytes, contentType, bucket = BUCKET) {
  const res = await upstream(fetch(`${c.url}/storage/v1/object/${bucket}/${encPath(path)}`, {
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
export async function signObjects(c, paths, expiresIn = 3600, bucket = BUCKET) {
  const out = new Map();
  if (!paths.length) return out;
  const res = await upstream(fetch(`${c.url}/storage/v1/object/sign/${bucket}`, {
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

export async function removeObjects(c, paths, bucket = BUCKET) {
  if (!paths || !paths.length) return;
  const res = await upstream(fetch(`${c.url}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: headers(c, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  }));
  if (!res.ok) console.error(`[supabase] storage remove -> HTTP ${res.status}`);
}

/**
 * One-time signed upload URL: lets the browser send a large file straight to Supabase Storage (Netlify Functions
 * cannot accept request bodies above ~6 MB). The URL carries its own token and is valid for ONE object path only;
 * the bucket's own file-size and MIME limits still apply, and the server re-verifies the file before it is usable.
 */
export async function createSignedUpload(c, bucket, path) {
  const res = await upstream(fetch(`${c.url}/storage/v1/object/upload/sign/${bucket}/${encPath(path)}`, {
    method: 'POST',
    headers: headers(c, { 'Content-Type': 'application/json' }),
    body: '{}',
  }));
  if (!res.ok) { console.error(`[supabase] storage upload-sign -> HTTP ${res.status}`); throw new ApiError(502, 'upstream_error'); }
  const data = await res.json();
  const rel = data && (data.url || data.signedURL);
  if (typeof rel !== 'string') throw new ApiError(502, 'upstream_error');
  if (/^https?:\/\//.test(rel)) return rel;
  return `${c.url}/storage/v1${rel.startsWith('/storage/v1') ? rel.slice('/storage/v1'.length) : rel}`;
}

/** Read the first bytes (and total size) of a stored object with the service key. Returns null if it does not exist. */
export async function peekObject(c, bucket, path, n = 64) {
  const res = await upstream(fetch(`${c.url}/storage/v1/object/authenticated/${bucket}/${encPath(path)}`, {
    headers: headers(c, { Range: `bytes=0-${n - 1}` }),
  }));
  if (res.status === 404 || res.status === 400) { try { await res.body.cancel(); } catch {} return null; }
  if (!res.ok) { console.error(`[supabase] storage peek -> HTTP ${res.status}`); throw new ApiError(502, 'upstream_error'); }
  const reader = res.body.getReader();
  const parts = []; let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
  }
  try { await reader.cancel(); } catch {}
  const head = Buffer.concat(parts.map((p) => Buffer.from(p))).subarray(0, n);
  const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  const size = cr ? Number(cr[1]) : Number(res.headers.get('content-length') || 0);
  return { head, size };
}
