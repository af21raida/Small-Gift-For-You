// Request handlers for the gift API. Kept separate from the function entry points so tests can call them directly.
import crypto from 'node:crypto';
import { ApiError, json, errorResponse, assertSameOrigin, readJson } from './http.mjs';
import { config, rpc, uploadObject, signObjects, removeObjects } from './supabase.mjs';
import { limit, clientId } from './ratelimit.mjs';
import { LIMITS, generateCode, isCode, sha256, validateGiftInput, sniffImage } from './validate.mjs';

const wrap = (fn) => async (req, context) => {
  try {
    assertSameOrigin(req);
    return await fn(req, context || {}, config());
  } catch (e) {
    return errorResponse(e);
  }
};

/** POST /api/gifts */
export const createGift = wrap(async (req, ctx, c) => {
  if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'gift-create-hour', 3600, 12);
  await limit(c, id, 'gift-create-min', 60, 4);
  const input = validateGiftInput(await readJson(req));

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateCode();
    const [row] = await rpc(c, 'create_gift', {
      p_code: code, p_message: input.message, p_songs: input.songs, p_photos: input.photos,
      p_manage_hash: input.manageHash, p_idem_hash: input.idemHash,
    });
    switch (row && row.status) {
      case 'ok': case 'replay': return json({ code: row.code }, row.status === 'ok' ? 201 : 200);
      case 'collision': continue;                       // astronomically unlikely; try a fresh code
      case 'bad_photo': throw new ApiError(400, 'invalid_input', 'One of the uploaded photos expired or was already used. Please re-add it.');
      case 'photo_limit': throw new ApiError(400, 'photo_limit');
      case 'idem_conflict': throw new ApiError(409, 'invalid', 'This request key was already used.');
      default: throw new ApiError(502, 'upstream_error');
    }
  }
  throw new ApiError(503, 'server_busy', 'Could not allocate a gift code. Please try again.');
});

/** GET /api/gifts/:code */
export const getGift = wrap(async (req, ctx, c) => {
  if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
  const code = String(ctx.params && ctx.params.code || '').toUpperCase();
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'gift-get', 60, 90);
  if (!isCode(code)) { await limit(c, id, 'gift-miss', 600, 20); throw new ApiError(404, 'not_found'); }

  const [row] = await rpc(c, 'get_gift', { p_code: code });
  if (!row || row.status === 'not_found') {
    await limit(c, id, 'gift-miss', 600, 20);        // throttles code-guessing
    throw new ApiError(404, 'not_found');
  }
  if (row.status === 'gone') throw new ApiError(410, 'gone');

  const stored = row.photos.filter((p) => p.type === 'stored' && p.path);
  const signed = await signObjects(c, stored.map((p) => p.path), 3600);
  const photos = [];
  for (const p of row.photos) {
    if (p.type === 'external') photos.push({ url: p.url, external: true });
    else if (signed.has(p.path)) photos.push({ url: signed.get(p.path) });
  }
  return json({ message: row.message, songs: row.songs, photos });
});

/** DELETE /api/gifts/:code   (Authorization: Bearer <manage key>) */
export const deleteGift = wrap(async (req, ctx, c) => {
  if (req.method !== 'DELETE') throw new ApiError(405, 'method_not_allowed');
  const code = String(ctx.params && ctx.params.code || '').toUpperCase();
  const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.get('authorization') || '');
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'gift-delete', 3600, 20);
  if (!isCode(code)) throw new ApiError(404, 'not_found');
  if (!m) throw new ApiError(401, 'unauthorized', 'A management key is required.');
  const [row] = await rpc(c, 'delete_gift', { p_code: code, p_manage_hash: sha256(m[1]) });
  switch (row && row.status) {
    case 'ok': await removeObjects(c, row.paths || []); return json({ ok: true });
    case 'forbidden': throw new ApiError(403, 'forbidden', 'That management key does not match this gift.');
    case 'gone': throw new ApiError(410, 'gone');
    case 'not_found': throw new ApiError(404, 'not_found');
    default: throw new ApiError(502, 'upstream_error');
  }
});

/** POST /api/photos  (raw image bytes; Content-Type image/jpeg|png|webp) */
export const uploadPhoto = wrap(async (req, ctx, c) => {
  if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'photo-hour', 3600, 60);
  await limit(c, id, 'photo-min', 60, 15);

  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > LIMITS.MAX_PHOTO_BYTES + 1024) throw new ApiError(413, 'payload_too_large');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new ApiError(415, 'unsupported_type');
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) throw new ApiError(400, 'invalid_input', 'The photo is empty.');
  if (buf.length > LIMITS.MAX_PHOTO_BYTES) throw new ApiError(413, 'payload_too_large');
  const sniffed = sniffImage(buf);
  if (!sniffed || sniffed.mime !== type) throw new ApiError(415, 'unsupported_type');

  const photoId = crypto.randomUUID();
  const path = `${photoId}.${sniffed.ext}`;
  await uploadObject(c, path, buf, sniffed.mime);
  try {
    await rpc(c, 'register_photo', { p_id: photoId, p_path: path, p_mime: sniffed.mime, p_bytes: buf.length });
  } catch (e) {
    await removeObjects(c, [path]);       // do not leave an unreferenced object behind
    throw e;
  }
  return json({ id: photoId }, 201);
});

/** Scheduled housekeeping: delete unattached uploads older than 24 h. */
export async function cleanup() {
  const c = config();
  const [row] = await rpc(c, 'purge_orphans', {});
  const paths = (row && row.paths) || [];
  await removeObjects(c, paths);
  return paths.length;
}
