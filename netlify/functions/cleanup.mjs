// Scheduled daily: removes photo uploads that were never attached to a saved gift.
import { cleanup } from '../lib/handlers.mjs';

export default async () => {
  try {
    const n = await cleanup();
    console.log(`[cleanup] removed ${n} orphaned upload(s)`);
  } catch (e) {
    console.error('[cleanup] failed:', e && e.message);
  }
};

export const config = { schedule: '@daily' };
