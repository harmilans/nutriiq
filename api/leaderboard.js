// api/leaderboard.js
// Returns rolling 7-day city leaderboard from Supabase
// Cached at edge for 15 minutes to avoid DB hammering

export const config = { runtime: 'edge' };

const CACHE_SECONDS = 900; // 15 minutes

export default async function handler(req) {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') || 'overall'; // overall | protein | sugar

  const cacheKey = `leaderboard:${mode}`;

  // Build query based on mode
  const metricMap = {
    overall: { col: 'nutri_iq_score', label: 'NutriIQ' },
    protein: { col: 'protein_per_100kcal', label: 'Protein' },
    sugar:   { col: 'sugar_per_100g',      label: 'Sugar Avoidance', invert: true }
  };

  const metric = metricMap[mode] || metricMap.overall;

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Raw SQL via rpc for the aggregation
    const { data, error } = await supabase.rpc('get_leaderboard', {
      p_mode: mode,
      p_min_scans: 10
    });

    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, mode, data }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`
      }
    });

  } catch (err) {
    console.error('Leaderboard error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
