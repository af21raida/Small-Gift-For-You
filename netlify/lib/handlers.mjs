// Request handlers for the gift API. Kept separate from the function entry points so tests can call them directly.
import crypto from 'node:crypto';
import { ApiError, json, errorResponse, assertSameOrigin, readJson } from './http.mjs';
import { config, rpc, uploadObject, signObjects, removeObjects, createSignedUpload, peekObject, AUDIO_BUCKET } from './supabase.mjs';
import { limit, clientId } from './ratelimit.mjs';
import { LIMITS, AUDIO_TYPES, generateCode, isCode, sha256, validateGiftInput, sniffImage, sniffAudio } from './validate.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      case 'bad_audio': throw new ApiError(400, 'invalid_input', 'One of the uploaded songs expired or didn’t finish uploading. Please add it again.');
      case 'audio_too_big': throw new ApiError(400, 'audio_too_big', 'Uploaded songs can total up to 30 MB per gift.');
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
  const storedSongs = row.songs.filter((s) => s.type === 'stored' && s.path);
  const signedAudio = await signObjects(c, storedSongs.map((s) => s.path), 21600, AUDIO_BUCKET);   // 6 h: long enough to listen
  const songs = [];
  for (const s of row.songs) {
    if (s.type === 'stored') { if (signedAudio.has(s.path)) songs.push({ title: s.title, artist: s.artist, url: signedAudio.get(s.path), stored: true, id: s.id }); }
    else songs.push(s);
  }
  return json({ message: row.message, songs, photos });
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
    case 'ok': await removeObjects(c, row.paths || []); await removeObjects(c, row.audio_paths || [], AUDIO_BUCKET); return json({ ok: true });
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

/** POST /api/audio  (raw audio bytes, up to ~4 MB; larger songs use /api/audio/sign) */
export const uploadAudio = wrap(async (req, ctx, c) => {
  if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'audio-hour', 3600, 30);
  await limit(c, id, 'audio-min', 60, 8);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > LIMITS.MAX_AUDIO_PROXY_BYTES + 1024) throw new ApiError(413, 'payload_too_large');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES[type]) throw new ApiError(415, 'unsupported_type');
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) throw new ApiError(400, 'invalid_input', 'The song file is empty.');
  if (buf.length > LIMITS.MAX_AUDIO_PROXY_BYTES) throw new ApiError(413, 'payload_too_large');
  const sniffed = sniffAudio(buf);
  if (!sniffed || sniffed.mime !== type) throw new ApiError(415, 'unsupported_type');

  const audioId = crypto.randomUUID();
  const path = `${audioId}.${sniffed.ext}`;
  await uploadObject(c, path, buf, sniffed.mime, AUDIO_BUCKET);
  try {
    await rpc(c, 'register_audio', { p_id: audioId, p_path: path, p_mime: sniffed.mime, p_bytes: buf.length, p_committed: true });
  } catch (e) {
    await removeObjects(c, [path], AUDIO_BUCKET);
    throw e;
  }
  return json({ id: audioId }, 201);
});

/** POST /api/audio/sign  {type, bytes} -> {id, uploadUrl}: authorise ONE direct browser upload to Supabase Storage. */
export const signAudio = wrap(async (req, ctx, c) => {
  if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  const id = clientId(req, ctx, c.salt);
  await limit(c, id, 'audio-sign-hour', 3600, 30);
  await limit(c, id, 'audio-sign-min', 60, 8);
  const body = await readJson(req, 2048);
  const type = String(body.type || '').toLowerCase();
  const bytes = body.bytes;
  if (!AUDIO_TYPES[type]) throw new ApiError(415, 'unsupported_type');
  if (!Number.isInteger(bytes) || bytes < 1) throw new ApiError(400, 'invalid_input', 'Missing file size.');
  if (bytes > LIMITS.MAX_AUDIO_BYTES) throw new ApiError(413, 'payload_too_large');
  const audioId = crypto.randomUUID();
  const path = `${audioId}.${AUDIO_TYPES[type]}`;
  await rpc(c, 'register_audio', { p_id: audioId, p_path: path, p_mime: type, p_bytes: bytes, p_committed: false });
  let uploadUrl;
  try { uploadUrl = await createSignedUpload(c, AUDIO_BUCKET, path); }
  catch (e) { await rpc(c, 'discard_audio', { p_id: audioId }).catch(() => {}); throw e; }
  return json({ id: audioId, uploadUrl }, 201);
});

/** POST /api/audio/commit  {id}: the browser finished the direct upload; verify the stored file before it can be used. */
export const commitAudio = wrap(async (req, ctx, c) => {
  if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
  const cid = clientId(req, ctx, c.salt);
  await limit(c, cid, 'audio-commit-hour', 3600, 60);
  const body = await readJson(req, 1024);
  const id = typeof body.id === 'string' ? body.id.toLowerCase() : '';
  if (!UUID_RE.test(id)) throw new ApiError(400, 'invalid_input', 'Missing upload id.');
  const [info] = await rpc(c, 'audio_info', { p_id: id });
  if (!info || info.attached) throw new ApiError(404, 'not_found', 'That upload was not found or has expired.');
  if (info.committed) return json({ id });                                   // idempotent retry

  const peek = await peekObject(c, AUDIO_BUCKET, info.path);
  if (!peek) throw new ApiError(400, 'upload_missing', 'The song didn’t finish uploading. Please try again.');
  const sniffed = sniffAudio(peek.head);
  const bad = !sniffed || sniffed.mime !== info.mime || !peek.size || peek.size > LIMITS.MAX_AUDIO_BYTES;
  if (bad) {                                                                   // never keep a file that failed verification
    await rpc(c, 'discard_audio', { p_id: id }).catch(() => {});
    await removeObjects(c, [info.path], AUDIO_BUCKET);
    throw peek.size > LIMITS.MAX_AUDIO_BYTES ? new ApiError(413, 'payload_too_large') : new ApiError(415, 'unsupported_type');
  }
  const [ok] = await rpc(c, 'commit_audio', { p_id: id, p_bytes: peek.size });
  if (ok !== true && !(ok && Object.values(ok)[0] === true)) throw new ApiError(409, 'invalid', 'That upload was already used.');
  return json({ id, bytes: peek.size });
});

/** Scheduled housekeeping: delete unattached uploads older than 24 h. */
export async function cleanup() {
  const c = config();
  const [row] = await rpc(c, 'purge_orphans', {});
  const paths = (row && row.paths) || [], audio = (row && row.audio_paths) || [];
  await removeObjects(c, paths);
  await removeObjects(c, audio, AUDIO_BUCKET);
  return paths.length + audio.length;
}
