import { createGift, getGift, deleteGift } from '../lib/handlers.mjs';
import { json } from '../lib/http.mjs';

export default async (req, context) => {
  if (req.method === 'POST') return createGift(req, context);
  if (req.method === 'GET') return getGift(req, context);
  if (req.method === 'DELETE') return deleteGift(req, context);
  const res = json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST, DELETE' });
  return res;
};

export const config = { path: ['/api/gifts', '/api/gifts/:code'] };
