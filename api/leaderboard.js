// api/leaderboard.js
// Returns rolling 7-day city leaderboard from Supabase

const CACHE_SECONDS = 60; // 1 minute

export default async function handler(req, res) {
  const mode = req.query?.mode || 'overall'; // overall | protein | sugar

  res.setHeader('Cache-Control', `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase.rpc('get_leaderboard', {
      p_mode: mode,
      p_min_scans: 1
    });

    if (error) throw error;

    // Debug: also return raw scan count for diagnosis
    const { count: totalScans } = await supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .not('city', 'is', null)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    return res.status(200).json({ ok: true, mode, data, _debug: { scans_with_city_last7d: totalScans, rpc_rows: data?.length ?? 0 } });

  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
