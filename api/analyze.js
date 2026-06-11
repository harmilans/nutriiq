// api/analyze.js — Claude Vision proxy with security hardening + photo storage

import { setSecurityHeaders, validateImageInput, sanitizeText, isRateLimited, getIp, hashIp } from './_security.js';

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 20 requests per hour per IP (hard — no silent skip)
  const ip = getIp(req);
  if (isRateLimited(`analyze:${ip}`, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { imageBase64, imageType, city, productName } = req.body || {};

  // Validate image inputs
  const imgErr = validateImageInput(imageBase64, imageType);
  if (imgErr) return res.status(400).json({ error: imgErr });

  // Sanitize text inputs — strip HTML/script characters, enforce max lengths
  const safeCity = sanitizeText(city, 60);
  const safeProductName = sanitizeText(productName, 120);

  const SYSTEM_PROMPT = `You are NutriIQ, a nutritional intelligence engine built by Phab (an Indian protein bar brand).
Analyse nutrition labels with scientific rigour. Tone in body_impact must match the score: celebrate good products, warn about bad ones.
Always return valid JSON only — no markdown, no backticks, no preamble.`;

  const USER_PROMPT = `Analyse this nutrition label image and return ONLY a valid JSON object.

IMPORTANT: The label may be rotated, sideways, upside-down, or at an angle — rotate it mentally and read it anyway. Do not refuse due to orientation.
${safeProductName ? `The user has identified this product as: "${safeProductName}". Use this as the product_name and as context when reading the label.` : ''}
If the label is partially visible, estimate missing values from what is visible.
Only set "not_a_food_label": true if the image contains NO food packaging whatsoever.

NOTE on per_100g: ALL numeric values must be normalised to per-100g basis regardless of serving size printed on label.
Also extract the actual serving size (e.g. 40g) and per-serving protein so the UI can show both.

body_impact tone rules:
- nutri_iq_score >= 75: positive, energising — "clean fuel", "muscles will thank you", sustained energy
- nutri_iq_score 50–74: balanced — note what's good and what to watch
- nutri_iq_score < 50: cautionary — spike, crash, additive load etc.

Required shape:
{
  "product_name": "string (product name if visible, else 'Unknown product')",
  "serving_size_g": number (serving size in grams from label, or null if not shown),
  "per_100g": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "sugar_g": number,
    "fat_g": number,
    "saturated_fat_g": number,
    "fibre_g": number,
    "sodium_mg": number
  },
  "ingredients_count": number,
  "has_artificial_additives": boolean,
  "has_trans_fat": boolean,
  "nutri_iq_score": number (0-100, weighted: protein efficiency 30% + glycaemic load 20% + additive penalty 20% + fat quality 15% + fibre bonus 10% + transparency 5%),
  "score_grade": "Excellent|Good|Decent|Poor|Harmful",
  "score_color": "great|ok|bad",
  "protein_per_100kcal": number,
  "gl_index": number,
  "verdicts": {
    "good": ["2-3 specific positive findings with numbers"],
    "bad": ["2-3 specific negative findings with numbers"],
    "neutral": ["1-2 neutral observations"]
  },
  "body_impact": "2-3 sentences matching tone to score (see rules above). Be specific and accurate.",
  "phab_comparison": {
    "this_protein_per_100kcal": number,
    "phab_protein_per_100kcal": 5.9,
    "this_sugar_per_100g": number,
    "phab_sugar_per_100g": 8.48,
    "nutri_iq_gap": number
  },
  "not_a_food_label": boolean
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
            { type: 'text', text: USER_PROMPT }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const text = data.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch (_) {
      console.error('JSON parse failed. Raw:', text.slice(0, 200));
      return res.status(422).json({ error: 'Could not parse nutrition data. Try a flatter, better-lit photo.' });
    }

    // Persist to Supabase (including photo if storage is configured)
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && !result.not_a_food_label) {
      try {
        const imageUrl = await persistScan(result, safeCity, ip, imageBase64, imageType);
        result._saved = true;
        if (imageUrl) result._image_url = imageUrl;
      } catch (err) {
        console.error('Persist error:', err);
        result._saved = false;
      }
    } else {
      result._saved = false;
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function persistScan(result, city, ip, imageBase64, imageType) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const ipHash = hashIp(ip);

  // Dedup: skip if same ip_hash + product within last 5 minutes
  const { data: recent } = await supabase
    .from('scans')
    .select('id')
    .eq('ip_hash', ipHash)
    .eq('product_name', result.product_name)
    .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .limit(1);
  if (recent && recent.length > 0) return null;

  // Upload photo to Supabase Storage (if bucket 'scan-images' exists)
  let imageUrl = null;
  if (imageBase64 && process.env.SUPABASE_STORAGE_ENABLED === 'true') {
    try {
      const ext = imageType.split('/')[1] || 'jpg';
      const filename = `${Date.now()}-${ipHash}.${ext}`;
      const buffer = Buffer.from(imageBase64, 'base64');
      const { data: upload, error: uploadErr } = await supabase.storage
        .from('scan-images')
        .upload(filename, buffer, { contentType: imageType, upsert: false });
      if (!uploadErr && upload) {
        const { data: { publicUrl } } = supabase.storage.from('scan-images').getPublicUrl(filename);
        imageUrl = publicUrl;
      }
    } catch (e) {
      console.warn('Image upload failed (non-fatal):', e.message);
    }
  }

  await supabase.from('scans').insert({
    city: city || null,
    product_name: result.product_name,
    nutri_iq_score: Math.round(result.nutri_iq_score),
    tier_label: getTierLabel(result.nutri_iq_score),
    protein_per_100kcal: result.protein_per_100kcal,
    sugar_per_100g: result.per_100g?.sugar_g,
    calories_per_100g: result.per_100g?.calories,
    fibre_per_100g: result.per_100g?.fibre_g,
    has_artificial_additives: result.has_artificial_additives,
    ingredients_count: result.ingredients_count,
    ip_hash: ipHash,
    image_url: imageUrl
  });

  return imageUrl;
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
