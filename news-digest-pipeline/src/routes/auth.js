import { Router } from 'express';
import { isAuthenticated, authRequired } from '../middleware/auth.js';

const router = Router();

const REALM = 'News Digest';

/**
 * Only allow same-origin relative redirect targets (no open redirect).
 */
function safeNext(next) {
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

// GET /api/auth/status — public. Reports whether the caller can perform writes
// and whether auth is enforced at all (so the UI knows to show a login CTA).
router.get('/status', (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    required: authRequired(),
  });
});

// GET /api/auth/login — triggers the browser's native Basic Auth dialog.
// If credentials are absent/invalid → 401 with WWW-Authenticate so the browser
// prompts. Once valid creds are supplied, the browser caches them for the
// origin and this redirects back to the app.
router.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect(safeNext(req.query.next));
  }
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  return res.status(401).send('Требуется авторизация. Обновите страницу и введите логин/пароль.');
});

export default router;
