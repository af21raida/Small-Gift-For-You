// Fixed-window rate limiting backed by Postgres (rate_limit_hit RPC) so it works across
// stateless, concurrent function instances.
import { ApiError } from './http.mjs';
import { rpc } from './supabase.mjs';
import { sha256 } from './validate.mjs';

export function clientId(req, context, salt) {
  const ip = (context && context.ip)
    || req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
  return sha256(`${salt}|${ip}`).slice(0, 24);     // raw IPs are never stored
}

/** Throws 429 when `limit` hits per `windowSeconds` are exceeded for this client + action. */
export async function limit(c, id, action, windowSeconds, max) {
  const rows = await rpc(c, 'rate_limit_hit', { p_bucket: `${action}:${id}`, p_window_seconds: windowSeconds, p_limit: max });
  const allowed = rows[0] === true || (rows[0] && Object.values(rows[0])[0] === true);
  if (!allowed) throw Object.assign(new ApiError(429, 'rate_limited'), { retryAfter: windowSeconds });
}
