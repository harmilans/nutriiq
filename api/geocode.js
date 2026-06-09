// api/geocode.js — Nominatim reverse-geocode proxy with security hardening

import { handleCors, validateLatLon, isRateLimited, getIp, setSecurityHeaders } from './_security.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  setSecurityHeaders(res);
  res.setHeader('Cache-Control', 's-maxage=300');

  const ip = getIp(req);
  if (isRateLimited(`geocode:${ip}`, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { lat, lon } = req.query;
  const err = validateLatLon(lat, lon);
  if (err) return res.status(400).json({ error: err });

  // Only pass validated numeric values — no raw query param injection
  const safeUrl = `https://nominatim.openstreetmap.org/reverse?lat=${parseFloat(lat)}&lon=${parseFloat(lon)}&format=json&addressdetails=1`;

  try {
    const r = await fetch(safeUrl, {
      headers: {
        'User-Agent': 'NutriIQ/1.0 (scan.phab.in)',
        'Accept-Language': 'en'
      }
    });
    if (!r.ok) return res.status(502).json({ error: 'Geocoding service error' });
    const data = await r.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || addr.state_district || null;
    return res.status(200).json({ ok: true, city, full: addr });
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
