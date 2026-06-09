// api/admin-clear.js
// Master user only: deletes all scans from the DB
// Protected by ADMIN_SECRET env var

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { secret } = req.body || {};
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Delete all rows — neq filter is a workaround since Supabase requires a filter for delete
    const { error, count } = await supabase
      .from('scans')
      .delete({ count: 'exact' })
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (error) throw error;

    return res.status(200).json({ ok: true, deleted: count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
