import { uploadAudio, signAudio, commitAudio } from '../lib/handlers.mjs';
import { json } from '../lib/http.mjs';

// /api/audio         POST raw audio (<= ~4 MB) through the function
// /api/audio/sign    POST {type, bytes} -> one-time direct-upload URL (larger songs)
// /api/audio/commit  POST {id} -> verify the directly uploaded file
export default (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (path === '/api/audio') return uploadAudio(req, context);
  if (path === '/api/audio/sign') return signAudio(req, context);
  if (path === '/api/audio/commit') return commitAudio(req, context);
  return json({ error: 'not_found' }, 404);
};

export const config = { path: ['/api/audio', '/api/audio/sign', '/api/audio/commit'] };
