// api/persist.js — Persist pre-computed barcode scan data to Supabase

import { setSecurityHeaders, isRateLimited, getIp, hashIp, sanitizeText } from './_security.js';

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: false, reason: 'storage_not_configured' });
  }

  const ip = getIp(req);
  if (isRateLimited(`persist:${ip}`, 30, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }

  const {
    product_name, nutri_iq_score, protein_per_100kcal,
    sugar_per_100g, calories_per_100g, fibre_per_100g,
    has_artificial_additives, ingredients_count, image_url, source
  } = req.body || {};

  if (!product_name || nutri_iq_score == null) {
    return res.status(400).json({ error: 'product_name and nutri_iq_score are required' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const ipHash = hashIp(ip);
    const safeProductName = sanitizeText(product_name, 120);
    const score = Math.round(Number(nutri_iq_score));

    // Dedup: skip if same ip_hash + product within last 5 minutes
    const { data: recent } = await supabase
      .from('scans')
      .select('id')
      .eq('ip_hash', ipHash)
      .eq('product_name', safeProductName)
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .limit(1);
    if (recent && recent.length > 0) {
      return res.status(200).json({ ok: true, deduped: true });
    }

    await supabase.from('scans').insert({
      product_name: safeProductName,
      nutri_iq_score: score,
      tier_label: getTierLabel(score),
      protein_per_100kcal: protein_per_100kcal ?? null,
      sugar_per_100g: sugar_per_100g ?? null,
      calories_per_100g: calories_per_100g ?? null,
      fibre_per_100g: fibre_per_100g ?? null,
      has_artificial_additives: has_artificial_additives ?? null,
      ingredients_count: ingredients_count ?? null,
      ip_hash: ipHash,
      image_url: image_url || null,
      city: null
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Persist error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function getTierLabel(score) {
  if (score < 10) return 'BIOLOGICAL_HAZARD';
  if (score < 22) return 'EATING_REGRET';
  if (score < 36) return 'SLOW_SURRENDER';
  if (score < 48) return 'DAMAGE_CONTROL';
  if (score < 58) return 'MEDIOCRE_FUEL';
  if (score < 68) return 'ACCEPTABLE_HUMAN';
  if (score < 78) return 'BODY_APPROVED';
  if (score < 88) return 'GUT_APPROVED';
  return 'PEAK_HUMAN_FUEL';
}
