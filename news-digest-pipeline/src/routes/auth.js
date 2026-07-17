import { Router } from 'express';
import {
  isAuthenticated,
  isBrowserAuthenticated,
  authRequired,
  buildSessionCookie,
  clearSessionCookie,
} from '../middleware/auth.js';

const router = Router();

const REALM = 'News Digest';

/**
 * Only allow same-origin relative redirect targets (no open redirect). Must be
 * a single-slash absolute path. Rejects "//host" and "/\host" (and any
 * backslash or control char), which browsers normalize into a protocol-relative
 * cross-origin redirect — the open-redirect / phishing vector.
 */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  if (next.length > 1 && (next[1] === '/' || next[1] === '\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f]/.test(next)) return '/';
  return next;
}

// GET /api/auth/status — public. Reports whether the caller can perform writes
// and whether auth is enforced at all (so the UI knows to show a login CTA).
router.get('/status', (req, res) => {
  // Cookie-based (isBrowserAuthenticated), NOT isAuthenticated — see the
  // comment on isBrowserAuthenticated. This is what makes the header badge
  // match real write access and makes logout actually flip the state.
  res.json({
    authenticated: isBrowserAuthenticated(req),
    required: authRequired(),
  });
});

// GET /api/auth/login — triggers the browser's native Basic Auth dialog.
// If credentials are absent/invalid → 401 with WWW-Authenticate so the browser
// prompts. Once valid creds are supplied, the browser caches them for the
// origin and this redirects back to the app.
router.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    // Valid Basic creds (or already a session) → issue a Path=/ session cookie
    // so subsequent writes to /api/* authenticate regardless of Basic Auth
    // path scoping, then bounce back into the app.
    res.setHeader('Set-Cookie', buildSessionCookie());
    return res.redirect(safeNext(req.query.next));
  }
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  return res.status(401).send('Требуется авторизация. Обновите страницу и введите логин/пароль.');
});

// GET /api/auth/logout — clears the session cookie and returns to the app.
// Note: the browser may still hold the Basic Auth credentials it cached during
// the native prompt until the tab is closed; clearing the cookie is what
// actually revokes write access (writes rely on the cookie, not the cached
// Basic creds, which the browser doesn't send to /api/* anyway).
router.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.redirect(safeNext(req.query.next));
});

export default router;
