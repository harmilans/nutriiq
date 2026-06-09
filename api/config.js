// api/config.js
// Returns public Supabase config for the frontend live feed
// Anon key is safe to expose — Row Level Security restricts writes

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
}
