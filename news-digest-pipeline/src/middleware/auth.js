/**
 * Authentication middleware — public reads, authenticated writes.
 *
 * Model:
 *   - Static pages and all GET/HEAD/OPTIONS API calls are PUBLIC (read-only).
 *   - Mutating API calls (POST/PATCH/DELETE) require credentials.
 *   - Telegram webhook is exempt (has its own secret-token check).
 *
 * Credentials (any one):
 *   - Bearer token or ?key= using API_SECRET_KEY (used by local-fetcher, API clients)
 *   - HTTP Basic Auth using DASHBOARD_PASSWORD or API_SECRET_KEY (dashboard login)
 *
 * Enforcement is production-only. Locally (NODE_ENV !== 'production') everything
 * is open (full access) so development has no friction.
 */

import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Hash both to constant length to avoid length-based timing leak
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Auth is enforced only in production. Locally the dashboard and API are fully
 * open so the login prompt doesn't get in the way. The deployed instance runs
 * with NODE_ENV=production and enforces the read/write split.
 */
function authDisabled() {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Non-throwing credential check. Returns true if the request carried valid
 * credentials via Bearer token, ?key=, or Basic Auth (API key or dashboard
 * password). Does not send any response.
 */
function hasValidCreds(req) {
  const expectedKey = process.env.API_SECRET_KEY || '';
  const dashPass = process.env.DASHBOARD_PASSWORD || '';
  const authHeader = req.headers.authorization || '';

  if (expectedKey) {
    if (authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7), expectedKey)) return true;
    if (req.query.key && safeCompare(String(req.query.key), expectedKey)) return true;
  }

  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const pass = decoded.slice(colonIdx + 1);
        if (expectedKey && safeCompare(pass, expectedKey)) return true;
        if (dashPass && safeCompare(pass, dashPass)) return true;
      }
    } catch {
      // malformed — treat as no creds
    }
  }

  return false;
}

/**
 * Is this caller allowed to perform writes? True in dev (open), or when valid
 * credentials are present. Used by the /api/auth/status endpoint and by
 * writeAuth. Never sends a response.
 */
export function isAuthenticated(req) {
  return authDisabled() || hasValidCreds(req);
}

/**
 * Whether write-auth is enforced at all. False in dev (everything open), true
 * in production. The frontend uses this to decide whether to show a login CTA.
 */
export function authRequired() {
  return !authDisabled();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Public reads, authenticated writes. Safe methods (GET/HEAD/OPTIONS) always
 * pass. Mutating methods require valid credentials, except when auth is
 * disabled (dev) or for the Telegram webhook (its own secret-token check).
 */
export function writeAuth(req, res, next) {
  if (req.path.startsWith('/telegram/') || req.path.startsWith('/api/telegram/')) return next();
  if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
  if (authDisabled()) return next();
  if (hasValidCreds(req)) return next();
  return res.status(401).json({ error: 'Unauthorized — требуется авторизация для изменений' });
}
