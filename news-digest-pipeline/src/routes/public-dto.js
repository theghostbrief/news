// ─────────────────────────────────────────────────────────────────────────────
// Public projection layer for read-only GET endpoints.
//
// The dashboard is a "read-only working dashboard": public GETs return only
// non-sensitive fields to anonymous callers, while the authenticated owner
// (dashboard session cookie OR a valid API key/Bearer) sees the full rows.
//
// The DTOs are ALLOWLISTS, not denylists: a new column added to a table does
// NOT leak by default — it has to be added here explicitly. Sensitive columns
// deliberately omitted: platform post ids (facebook/telegram/instagram/youtube),
// generation logs, model/token/cost accounting, fetch/error logs, and the
// telegram source chat/message identifiers.
// ─────────────────────────────────────────────────────────────────────────────

import { isBrowserAuthenticated, isAuthenticated } from '../middleware/auth.js';

/**
 * Whether this caller may see full, unredacted rows. True for the dashboard
 * owner (session cookie) OR any caller holding valid credentials (Bearer/Basic,
 * e.g. the local fetcher). Anonymous visitors get the DTO. In dev both auth
 * checks are open, so everything is full.
 */
export function showFull(req) {
  return isBrowserAuthenticated(req) || isAuthenticated(req);
}

/** Safe digest fields for anonymous callers. */
export function publicDigest(d) {
  if (!d) return d;
  return {
    id: d.id,
    date: d.date,
    part: d.part,
    seq_number: d.seq_number,
    articles_count: d.articles_count,
    content: d.content,
    status: d.status,
    published_at: d.published_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/** Safe article fields for anonymous callers. */
export function publicArticle(a) {
  if (!a) return a;
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    content: a.content,
    status: a.status,
    digest_id: a.digest_id,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

// NOTE: publicSourcePost lives in the pro cluster (src/pro/dto.js) alongside the
// source_posts table it projects. Core keeps only the DTOs for core tables.

/**
 * Parse and clamp a client-supplied `limit` query param.
 * Rejects NaN, zero and negatives (which SQLite treats as "unbounded" for
 * `LIMIT -1`) by falling back to `def`, and caps the upper bound at `max`.
 */
export function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}
