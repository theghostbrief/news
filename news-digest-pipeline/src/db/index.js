import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function initDb(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Idempotent migrations for existing DBs
  const articleCols = new Set(db.prepare('PRAGMA table_info(articles)').all().map((c) => c.name));
  if (!articleCols.has('source_chat_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_chat_id TEXT');
  }
  if (!articleCols.has('source_message_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_message_id TEXT');
  }
  if (!articleCols.has('retry_count')) {
    // Jina abuse-block backoff (status='retry_scheduled') — see content-fetcher.js.
    db.exec('ALTER TABLE articles ADD COLUMN retry_count INTEGER DEFAULT 0');
  }
  if (!articleCols.has('retry_after')) {
    db.exec('ALTER TABLE articles ADD COLUMN retry_after TEXT');
  }

  // Token accounting + cost columns on digests (idempotent)
  const digestCols = new Set(db.prepare('PRAGMA table_info(digests)').all().map((c) => c.name));
  if (!digestCols.has('seq_number')) {
    // createDigest writes seq_number, so older DBs missing this column break
    // digest creation entirely. Add it and backfill existing rows in order.
    db.exec('ALTER TABLE digests ADD COLUMN seq_number INTEGER');
    const rows = db.prepare('SELECT id FROM digests ORDER BY created_at ASC, rowid ASC').all();
    const setSeq = db.prepare('UPDATE digests SET seq_number = ? WHERE id = ?');
    rows.forEach((r, i) => setSeq.run(i + 1, r.id));
  }
  if (!digestCols.has('model')) {
    db.exec('ALTER TABLE digests ADD COLUMN model TEXT');
  }
  if (!digestCols.has('input_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN input_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('output_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN output_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('cost_usd')) {
    db.exec('ALTER TABLE digests ADD COLUMN cost_usd REAL');
  }
  if (!digestCols.has('script_warning')) {
    // Set by digest-generator.js's post-generation non-Latin-script check
    // (script-guard.js) — NULL when clean, a human-readable summary otherwise.
    db.exec('ALTER TABLE digests ADD COLUMN script_warning TEXT');
  }
  if (!digestCols.has('facebook_status')) {
    // 'published' | 'failed' | NULL (never attempted) — set on every Facebook
    // publish attempt regardless of outcome, independent of facebook_post_id
    // (which is only ever set on a genuine success).
    db.exec('ALTER TABLE digests ADD COLUMN facebook_status TEXT');
  }
  if (!digestCols.has('facebook_error')) {
    db.exec('ALTER TABLE digests ADD COLUMN facebook_error TEXT');
  }
  if (!digestCols.has('threads_status')) {
    // 'published' | 'failed' | NULL (never attempted) — same contract as
    // facebook_status: only 'published' when the FULL 4-post chain (lead +
    // 2 replies + closing link) succeeded, never on a partial chain.
    db.exec('ALTER TABLE digests ADD COLUMN threads_status TEXT');
  }
  if (!digestCols.has('threads_error')) {
    db.exec('ALTER TABLE digests ADD COLUMN threads_error TEXT');
  }
  if (!digestCols.has('threads_thread_ids')) {
    // JSON array of however many post ids the chain reached before stopping
    // (0-4 entries) — same idea as duplicate_review.groups: JSON in a TEXT column.
    db.exec('ALTER TABLE digests ADD COLUMN threads_thread_ids TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads_token_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      refreshed_at TEXT,
      expires_at TEXT,
      last_error TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare('INSERT OR IGNORE INTO threads_token_state (id) VALUES (1)').run();

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function insertArticle({ url, title, content, source = 'extension', sourceChatId = null, sourceMessageId = null }) {
  const existing = db.prepare('SELECT id, url, title, status FROM articles WHERE url = ?').get(url);
  if (existing) {
    return { ...existing, duplicate: true };
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO articles (id, url, title, content, source, source_chat_id, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, url, title || null, content || null, source, sourceChatId, sourceMessageId);

  return { id, url, title, status: 'new', duplicate: false };
}

// Readiness — single definition, used everywhere an article is selected for
// digest generation: 'new' status AND content has actually been fetched.
// Without the content check, a burst of newly-added articles can be pulled
// into a digest before content-fetcher (a separate, slower background loop)
// has reached them, handing the LLM an empty source and getting back its own
// "please provide the source text" reply as if it were real commentary.
const READY_WHERE = `status = 'new' AND digest_id IS NULL AND content IS NOT NULL AND content != ''`;

export function getNewArticles(limit = 50) {
  return db.prepare(
    `SELECT * FROM articles WHERE ${READY_WHERE} ORDER BY created_at ASC LIMIT ?`
  ).all(limit);
}

export function getReadyArticleCount() {
  return db.prepare(`SELECT COUNT(*) as count FROM articles WHERE ${READY_WHERE}`).get().count;
}

// Saved but not yet fetched — same predicate as getArticlesNeedingFetch(),
// as a count instead of rows. Distinguishing this from getReadyArticleCount()
// is what the post-save Telegram reply needs: right after a save, an article
// is real (saved) but not yet ready, and the two counts must not be collapsed
// into one number.
export function getFetchingArticleCount() {
  return db.prepare(
    `SELECT COUNT(*) as count FROM articles WHERE status = 'new' AND (content IS NULL OR content = '')`
  ).get().count;
}

// Articles waiting out a Jina abuse-block backoff (status='retry_scheduled'),
// regardless of whether retry_after has elapsed yet — shown as its own count
// (not folded into Ready or Fetching) so a Jina-blocked paste visibly reads
// as queued rather than silently vanishing from both existing counts.
export function getRetryingArticleCount() {
  return db.prepare(
    `SELECT COUNT(*) as count FROM articles WHERE status = 'retry_scheduled'`
  ).get().count;
}

export function getArticleCount(status) {
  if (status) {
    return db.prepare('SELECT COUNT(*) as count FROM articles WHERE status = ?').get(status).count;
  }
  return db.prepare('SELECT COUNT(*) as count FROM articles').get().count;
}

export function updateArticleStatus(id, status) {
  db.prepare(
    `UPDATE articles SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

// Articles saved without content (e.g. via Telegram) that the background
// content-fetcher hasn't picked up yet, PLUS 'retry_scheduled' articles whose
// backoff has elapsed (Jina abuse-block retry — see content-fetcher.js).
// Deliberately excludes 'fetch_failed' rows — those already exhausted their
// retries (or hit a non-retryable error) and are waiting on a manual paste
// via the dashboard, not another automatic retry.
export function getArticlesNeedingFetch(limit = 5) {
  // retry_after is stored as an ISO8601 string (new Date().toISOString(), e.g.
  // "2026-07-28T08:19:33.000Z") — SQLite's datetime('now') returns its own
  // space-separated, no-'Z' format ("2026-07-28 08:19:33"). A bare string
  // comparison between the two is WRONG: 'T' (0x54) sorts after ' ' (0x20),
  // so retry_after <= datetime('now') is false for every row regardless of
  // actual time (caught live 2026-07-28 — a scheduled retry never fired even
  // 4 minutes past its due time). Wrapping retry_after in datetime(...) too
  // normalizes it to the same comparable format first.
  return db.prepare(
    `SELECT * FROM articles
     WHERE (status = 'new' AND (content IS NULL OR content = ''))
        OR (status = 'retry_scheduled' AND datetime(retry_after) <= datetime('now'))
     ORDER BY created_at ASC LIMIT ?`
  ).all(limit);
}

export function markArticleFetched(id, { title, content }) {
  db.prepare(
    `UPDATE articles SET title = ?, content = ?, fetch_error = NULL, status = 'new',
     retry_count = 0, retry_after = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(title || null, content, id);
}

export function markArticleFetchFailed(id, errorMessage) {
  db.prepare(
    `UPDATE articles SET status = 'fetch_failed', fetch_error = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(errorMessage, id);
}

// Jina abuse-block retry, still under the attempt cap: not a failure, a
// scheduled retry. retryAfter is an ISO datetime string; getArticlesNeedingFetch()
// picks the row back up once it elapses.
export function markArticleRetryScheduled(id, { retryAfter, errorMessage, retryCount }) {
  db.prepare(
    `UPDATE articles SET status = 'retry_scheduled', fetch_error = ?, retry_after = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(errorMessage, retryAfter, retryCount, id);
}

export function updateArticleCommentary(id, commentary) {
  db.prepare(
    `UPDATE articles SET commentary = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(commentary, id);
}

export function assignArticlesToDigest(articleIds, digestId) {
  const stmt = db.prepare(
    `UPDATE articles SET digest_id = ?, status = 'used', updated_at = datetime('now') WHERE id = ?`
  );
  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      stmt.run(digestId, id);
    }
  });
  transaction(articleIds);
}

export function createDigest({ date, part = 1, articlesCount = 0 }) {
  const id = uuidv4();
  // Auto-increment seq_number
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_number), 0) as max FROM digests').get().max;
  db.prepare(
    `INSERT INTO digests (id, date, part, articles_count, seq_number) VALUES (?, ?, ?, ?, ?)`
  ).run(id, date, part, articlesCount, maxSeq + 1);
  return id;
}

export function updateDigest(id, fields) {
  const allowed = ['content', 'status', 'generation_log', 'published_at',
    'facebook_post_id', 'facebook_status', 'facebook_error', 'telegram_message_id', 'youtube_post_id', 'articles_count',
    'model', 'input_tokens', 'output_tokens', 'cost_usd', 'script_warning',
    'threads_status', 'threads_error', 'threads_thread_ids'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE digests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function getDigestPromptState() {
  return db.prepare('SELECT * FROM digest_prompt_state WHERE id = 1').get();
}

export function setDigestPromptState(fields) {
  const allowed = ['pending', 'baseline'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE digest_prompt_state SET ${updates.join(', ')} WHERE id = 1`).run(...values);
}

export function getThreadsTokenState() {
  return db.prepare('SELECT * FROM threads_token_state WHERE id = 1').get();
}

export function setThreadsTokenState(fields) {
  const allowed = ['access_token', 'refreshed_at', 'expires_at', 'last_error'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE threads_token_state SET ${updates.join(', ')} WHERE id = 1`).run(...values);
}

export function getDuplicateReview() {
  const row = db.prepare('SELECT * FROM duplicate_review WHERE id = 1').get();
  return {
    active: !!row.active,
    chatId: row.chat_id,
    candidateArticleIds: row.candidate_article_ids ? JSON.parse(row.candidate_article_ids) : [],
    groups: row.groups ? JSON.parse(row.groups) : [],
  };
}

export function setDuplicateReview({ active, chatId, candidateArticleIds, groups }) {
  db.prepare(
    `UPDATE duplicate_review SET active = ?, chat_id = ?, candidate_article_ids = ?, groups = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(
    active ? 1 : 0,
    chatId ?? null,
    JSON.stringify(candidateArticleIds ?? []),
    JSON.stringify(groups ?? [])
  );
}

export function getArticlesByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`).all(...ids);
}

export function getDigest(id) {
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id);
}

export function getDigests(filters = {}) {
  let query = 'SELECT * FROM digests';
  const params = [];

  if (filters.status) {
    query += ' WHERE status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
}

export function getArticlesByDigestId(digestId) {
  return db.prepare(
    'SELECT * FROM articles WHERE digest_id = ? ORDER BY created_at ASC'
  ).all(digestId);
}

export function deleteArticle(id) {
  return db.prepare('DELETE FROM articles WHERE id = ?').run(id);
}

// source_posts data access moved to the pro cluster (src/pro/db/source-posts.js).
// Core owns only the shared connection (getDb) and the core tables. The pro
// build creates + queries source_posts via the handle returned by getDb().
