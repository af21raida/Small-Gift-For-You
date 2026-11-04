// Small HTTP helpers shared by the Netlify Functions.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...extra },
  });
}

export function errorResponse(err) {
  if (err instanceof ApiError) {
    const extra = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
    return json({ error: err.code, message: err.message === err.code ? undefined : err.message }, err.status, extra);
  }
  // Never leak internals (connection strings, stack traces, upstream bodies) to the browser.
  console.error('[api] unexpected error:', err && err.message);
  return json({ error: 'server_error' }, 500);
}

/** The API is same-origin only. Reject cross-origin browser requests that carry an Origin header. */
export function assertSameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return;
  let ok = false;
  try { ok = new URL(origin).host === new URL(req.url).host; } catch { ok = false; }
  if (!ok) throw new ApiError(403, 'forbidden', 'Cross-origin requests are not allowed.');
}

export function allow(req, methods) {
  if (!methods.includes(req.method)) {
    throw Object.assign(new ApiError(405, 'method_not_allowed'), { allow: methods.join(', ') });
  }
}

export async function readJson(req, maxBytes = 64 * 1024) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new ApiError(413, 'payload_too_large');
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new ApiError(415, 'invalid', 'Expected a JSON request body.');
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw new ApiError(413, 'payload_too_large');
  try {
    const v = JSON.parse(new TextDecoder().decode(buf));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new ApiError(400, 'invalid', 'The request body is not valid JSON.');
  }
}
