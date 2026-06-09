// api/geocode.js
// Reverse geocode lat/lon via Nominatim — proxied server-side to avoid CORS/User-Agent issues

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'NutriIQ/1.0 (scan.phab.in)',
        'Accept-Language': 'en'
      }
    });
    if (!r.ok) return res.status(502).json({ error: 'Nominatim error' });
    const data = await r.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || addr.state_district || null;
    return res.status(200).json({ ok: true, city, full: addr });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
