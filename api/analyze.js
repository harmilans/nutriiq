// api/analyze.js
// Vercel serverless function — proxies image to Anthropic Claude Vision
// Never exposes API key to the browser

export default async function handler(req, res) {
  // CORS headers — lock to your domain in production
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageType, city, productName } = req.body;

  if (!imageBase64 || !imageType) {
    return res.status(400).json({ error: 'imageBase64 and imageType are required' });
  }

  // Basic rate limit via Vercel KV (optional — falls back gracefully if not configured)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      const key = `ratelimit:${ip}`;
      const count = await kv.incr(key);
      if (count === 1) await kv.expire(key, 3600); // 1 hour window
      if (count > 20) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
      }
    } catch (_) { /* KV not configured, skip */ }
  }

  const SYSTEM_PROMPT = `You are NutriIQ, a nutritional intelligence engine built by Phab (an Indian protein bar brand). 
Analyse nutrition labels with scientific rigour and a dry, slightly dark sense of humour in your descriptions.
Always return valid JSON only — no markdown, no backticks, no preamble.`;

  const USER_PROMPT = `Analyse this nutrition label image and return ONLY a valid JSON object.

IMPORTANT: The label may be rotated, sideways, upside-down, or at an angle — rotate it mentally and read it anyway. Do not refuse due to orientation.
${productName ? `The user has identified this product as: "${productName}". Use this as the product_name and as context when reading the label.` : ''}
If the label is partially visible, estimate missing values from what is visible.
Only set "not_a_food_label": true if the image contains NO food packaging whatsoever.

Required shape:
{
  "product_name": "string (product name if visible, else 'Unknown product')",
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
  "body_impact": "2-3 sentences: what this food does to the body in the 2 hours after eating. Be specific and slightly dramatic but accurate.",
  "phab_comparison": {
    "this_protein_per_100kcal": number,
    "phab_protein_per_100kcal": 17.5,
    "this_sugar_per_100g": number,
    "phab_sugar_per_100g": 0,
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
            {
              type: 'image',
              source: { type: 'base64', media_type: imageType, data: imageBase64 }
            },
            { type: 'text', text: USER_PROMPT }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'AI service error', detail: err });
    }

    const data = await response.json();
    const text = data.content.map(i => i.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch (_) {
      console.error('JSON parse failed. Raw response:', text);
      return res.status(422).json({ error: 'Could not parse nutrition data. The label may be too blurry or obscured — try a flatter, better-lit photo.' });
    }

    // Persist scan to Supabase asynchronously (non-blocking)
    if (process.env.SUPABASE_URL && !result.not_a_food_label) {
      persistScan(result, city, ip).catch(console.error);
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

async function persistScan(result, city, ip) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
    ip_hash: hashIp(ip)
  });
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

function hashIp(ip) {
  // Simple non-reversible hash for privacy compliance
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash) + ip.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}
