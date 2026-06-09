// api/feed.js
// Returns recent scans for the Live Feed — uses service key server-side
// No anon key needed in the browser

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('scans')
      .select('id,created_at,city,product_name,nutri_iq_score,tier_label,protein_per_100kcal,sugar_per_100g,has_artificial_additives')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.status(200).json({ ok: true, data });

  } catch (err) {
    console.error('Feed error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
