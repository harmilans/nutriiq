// api/feed.js — Live scan feed with security hardening

import { setSecurityHeaders, isRateLimited, getIp } from './_security.js';

export default async function handler(req, res) {
  setSecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const ip = getIp(req);
  if (isRateLimited(`feed:${ip}`, 60, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('scans')
      .select('id, created_at, city, product_name, nutri_iq_score, tier_label, protein_per_100kcal, sugar_per_100g, calories_per_100g, fibre_per_100g, has_artificial_additives, ingredients_count, image_url')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error('Feed error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
