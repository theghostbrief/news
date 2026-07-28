CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  content TEXT,
  source TEXT DEFAULT 'extension',
  status TEXT DEFAULT 'new',
  commentary TEXT,
  digest_id TEXT,
  fetch_error TEXT,
  source_chat_id TEXT,
  source_message_id TEXT,
  retry_count INTEGER DEFAULT 0,
  retry_after TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  date TEXT,
  part INTEGER DEFAULT 1,
  seq_number INTEGER,
  articles_count INTEGER DEFAULT 0,
  content TEXT,
  status TEXT DEFAULT 'draft',
  generation_log TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  script_warning TEXT,
  published_at TEXT,
  facebook_post_id TEXT,
  facebook_status TEXT,
  facebook_error TEXT,
  telegram_message_id TEXT,
  youtube_post_id TEXT,
  threads_status TEXT,
  threads_error TEXT,
  threads_thread_ids TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Singleton row tracking the interactive "compile digest?" Telegram prompt.
-- pending: an unanswered prompt is currently outstanding (queue-manager must
--   not send another one until it's resolved via Compile or Keep adding).
-- baseline: the ready-article count as of the last prompt send (or the last
--   successful compile) — the next prompt fires once ready count - baseline
--   reaches 10, so batches are counted from "since last asked", not total.
CREATE TABLE IF NOT EXISTS digest_prompt_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pending INTEGER NOT NULL DEFAULT 0,
  baseline INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO digest_prompt_state (id, pending, baseline) VALUES (1, 0, 0);

-- Singleton row tracking an in-progress compile-time duplicate review. Only
-- one compile action can be paused mid-review at a time (single admin,
-- explicit user action) — a new handleCompileDigest() call while active=1
-- refuses to start a second review rather than clobbering this one.
-- candidate_article_ids: JSON array — the full ready-set snapshot for this
--   compile attempt, frozen at review-start time.
-- groups: JSON array of { articleIds: [...], keepArticleIds: [...] | null } —
--   one entry per suspected-duplicate cluster; keepArticleIds is null until
--   that group's Telegram buttons are answered. Compile runs automatically
--   once every group has a non-null keepArticleIds.
CREATE TABLE IF NOT EXISTS duplicate_review (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT,
  candidate_article_ids TEXT,
  groups TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO duplicate_review (id, active) VALUES (1, 0);

-- Singleton row tracking the current Threads long-lived access token once it
-- has been auto-refreshed at least once. access_token is NULL until the first
-- successful refresh — until then, threads-publisher.js uses the .env value
-- (THREADS_ACCESS_TOKEN) directly. Refreshing writes the new token here rather
-- than back into .env (which is edited manually over SSH only, per project
-- convention) so the app keeps working across restarts without touching the
-- gitignored env file.
CREATE TABLE IF NOT EXISTS threads_token_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refreshed_at TEXT,
  expires_at TEXT,
  last_error TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO threads_token_state (id) VALUES (1);

-- NOTE: source_posts (the FB-Syndication contract table) is intentionally NOT
-- defined here. It belongs to the optional pro cluster, which creates it
-- idempotently at startup (src/pro/db/source-posts.js migrateSourcePosts()).

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_digest_id ON articles(digest_id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date);
CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);
