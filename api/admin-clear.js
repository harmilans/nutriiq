// api/admin-clear.js — Master user only: deletes all scans from the DB
// Protected by ADMIN_SECRET env var with timing-safe comparison

import { setSecurityHeaders, safeCompare, isRateLimited, getIp } from './_security.js';

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Hard rate-limit the admin endpoint: 5 attempts per 15 minutes per IP
  const ip = getIp(req);
  if (isRateLimited(`admin:${ip}`, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts' });
  }

  const { secret, _check_only } = req.body || {};

  if (!secret || !process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Timing-safe comparison prevents brute-force timing attacks
  if (!safeCompare(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Auth-check only — used by feed tab to verify secret without deleting
  if (_check_only) return res.status(200).json({ ok: true, authed: true });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { error, count } = await supabase
      .from('scans')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (error) throw error;

    console.log(`[admin-clear] ${count} scans deleted by ${ip} at ${new Date().toISOString()}`);
    return res.status(200).json({ ok: true, deleted: count });
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
