// api/leaderboard.js
// Returns rolling 7-day city leaderboard from Supabase — direct query, no RPC

const CACHE_SECONDS = 60;

export default async function handler(req, res) {
  const mode = req.query?.mode || 'overall'; // overall | protein | sugar

  res.setHeader('Cache-Control', `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all scans with a city in the last 7 days
    const { data: scans, error } = await supabase
      .from('scans')
      .select('city, nutri_iq_score, protein_per_100kcal, sugar_per_100g')
      .not('city', 'is', null)
      .gte('created_at', since);

    if (error) throw error;

    // Group by city in JS
    const cityMap = {};
    for (const row of scans || []) {
      if (!row.city) continue;
      if (!cityMap[row.city]) cityMap[row.city] = { city: row.city, scores: [], proteins: [], sugars: [] };
      if (row.nutri_iq_score != null) cityMap[row.city].scores.push(row.nutri_iq_score);
      if (row.protein_per_100kcal != null) cityMap[row.city].proteins.push(row.protein_per_100kcal);
      if (row.sugar_per_100g != null) cityMap[row.city].sugars.push(row.sugar_per_100g);
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    let data = Object.values(cityMap).map(c => {
      let avg_score;
      if (mode === 'protein') avg_score = Math.round(avg(c.proteins) * 10) / 10;
      else if (mode === 'sugar') avg_score = Math.round((100 - avg(c.sugars)) * 10) / 10;
      else avg_score = Math.round(avg(c.scores) * 10) / 10;

      return {
        city: c.city,
        avg_score,
        scan_count: c.scores.length || c.proteins.length || c.sugars.length,
        trend_7d: 0
      };
    });

    data = data.filter(d => d.scan_count >= 1).sort((a, b) => b.avg_score - a.avg_score).slice(0, 20);

    return res.status(200).json({ ok: true, mode, data });

  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
