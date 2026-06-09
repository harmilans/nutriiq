// api/_security.js — shared security utilities for all NutriIQ endpoints

import { createHash, timingSafeEqual } from 'crypto';

// ── Security headers applied to every response ──────────────────────────────
export function setSecurityHeaders(res, origin = null) {
  const allowed = origin || process.env.ALLOWED_ORIGIN || null;
  res.setHeader('Access-Control-Allow-Origin', allowed || 'null'); // 'null' blocks all if unset
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

// ── CORS preflight ───────────────────────────────────────────────────────────
export function handleCors(req, res) {
  setSecurityHeaders(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

// ── Timing-safe secret comparison ───────────────────────────────────────────
export function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

// ── Cryptographic IP hash (SHA-256, non-reversible) ─────────────────────────
export function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || 'nutriiq-default-salt';
  return createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);
}

// ── Input validators ─────────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BASE64_BYTES = 6 * 1024 * 1024; // 6 MB
const ALLOWED_LB_MODES = new Set(['overall', 'protein', 'sugar']);

export function validateImageInput(imageBase64, imageType) {
  if (!imageBase64 || typeof imageBase64 !== 'string')
    return 'imageBase64 is required';
  if (!imageType || !ALLOWED_IMAGE_TYPES.has(imageType))
    return `imageType must be one of: ${[...ALLOWED_IMAGE_TYPES].join(', ')}`;
  if (Buffer.byteLength(imageBase64, 'base64') > MAX_BASE64_BYTES)
    return 'Image too large (max 6 MB)';
  return null;
}

export function validateLatLon(lat, lon) {
  const la = parseFloat(lat), lo = parseFloat(lon);
  if (isNaN(la) || isNaN(lo)) return 'lat and lon must be numbers';
  if (la < -90 || la > 90) return 'lat out of range (-90 to 90)';
  if (lo < -180 || lo > 180) return 'lon out of range (-180 to 180)';
  return null;
}

export function validateLeaderboardMode(mode) {
  return ALLOWED_LB_MODES.has(mode) ? null : 'mode must be overall, protein, or sugar';
}

export function sanitizeText(str, maxLen = 100) {
  if (!str) return null;
  return String(str).replace(/[<>"'`]/g, '').slice(0, maxLen).trim() || null;
}

// ── In-process rate limiter (per Vercel instance; good enough for abuse deterrence) ─
const _rateLimitStore = new Map();
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rateLimitStore) {
    if (now > entry.resetAt) _rateLimitStore.delete(key);
  }
}, CLEANUP_INTERVAL);

/**
 * Returns true if the request should be rate-limited.
 * @param {string} key  — e.g. `analyze:${ip}`
 * @param {number} max  — max requests per window
 * @param {number} windowMs — window in milliseconds
 */
export function isRateLimited(key, max, windowMs) {
  const now = Date.now();
  let entry = _rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    _rateLimitStore.set(key, entry);
  }
  entry.count++;
  return entry.count > max;
}

export function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket?.remoteAddress) || 'unknown';
}
