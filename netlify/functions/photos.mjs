import { uploadPhoto } from '../lib/handlers.mjs';

export default (req, context) => uploadPhoto(req, context);

export const config = { path: '/api/photos' };
