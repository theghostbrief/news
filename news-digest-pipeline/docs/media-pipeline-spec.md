# Media Pipeline Extension — Technical Specification v1.0

Extension of the AI-agents-incubator/news repository (News Digest Pipeline v2.0.4).
Adds: website publication, TTS audio, slideshow video assembly, YouTube upload,
self-hosted podcast RSS feed, and 3 staggered vertical reels per digest.

**MVP scope:** 1 edition (English), 1 digest block per day (~15 news items, ~10 min video).
Architecture must support N editions later (edition = config row, not code changes).

---

## 1. Design principles

1. **Segment-based assembly.** The digest is split into segments (intro, news 1..N, outro).
   TTS runs per segment; each segment's audio duration defines its slot on the timeline.
   No sync math. A failed segment is regenerated alone.
2. **Audio is the master track.** Video is a visual layer fitted to audio durations.
3. **Visual sourcing tiers (fallback chain per segment):**
   - Tier 1: images from the source article (`og:image`, article `<img>` tags).
   - Tier 3: generated branded headline card (always succeeds).
   - (Tier 2 — external video clips — intentionally excluded from this spec.)
4. **No generative video.** FFmpeg only: Ken Burns over stills, concat, subtitle burn-in.
5. **Reuse the host repo's conventions:** better-sqlite3, publisher pattern in
   `src/services/publishers/`, queue pattern from `queue-manager.js`, env-driven config,
   fail-closed auth, cost logging into DB (extend `cost_usd` accounting).
6. **Copyright posture:** source images shown briefly under original narration, with
   on-screen source attribution ("Source: <domain>"). No watermarking to obscure origin.
   Prefer headline cards and free-license stock (Pexels/Pixabay APIs) for generic visuals.

---

## 2. Pipeline flow and statuses

Existing flow (unchanged): articles accumulate → `digest-generator.js` → digest `draft`.

New flow after digest reaches `draft` (or on explicit "Produce media" dashboard action):

```
digest:draft
  → site:published            (canonical post on website, immediate)
  → fb/tg:published           (existing publishers; text now includes site link)
  → segments:created          (split digest text)
  → segments:tts_done         (per-segment MP3 + duration + word timestamps)
  → segments:visuals_done     (per-segment image list or headline card)
  → render:video_done         (16:9 master MP4, intro/outro concatenated)
  → render:audio_done         (single MP3 = concat of segment audio, podcast-ready)
  → publish:youtube_done      (upload + metadata + chapters)
  → publish:podcast_done      (MP3 hosted + RSS item appended)
  → reels:rendered            (3 vertical MP4s for top-3 items)
  → reels:scheduled           (rows in publish_queue with staggered publish_at)
```

Each stage is idempotent and resumable: a `media_jobs` row tracks the digest's current
stage; on process restart the worker resumes from the last completed stage.

---

## 3. Database additions (`src/db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  idx INTEGER NOT NULL,              -- 0=intro, 1..N=news, 999=outro
  kind TEXT DEFAULT 'news',          -- intro | news | outro
  article_id TEXT,                   -- FK to articles when kind='news'
  text TEXT NOT NULL,                -- narration text for this segment
  headline TEXT,                     -- short headline for cards/overlays
  audio_path TEXT,
  audio_duration_ms INTEGER,
  timestamps_json TEXT,              -- word-level timestamps for subtitles
  visual_json TEXT,                  -- [{type:'article_image'|'card', path, source_domain}]
  is_top3 INTEGER DEFAULT 0,
  top3_rank INTEGER,                 -- 1..3
  status TEXT DEFAULT 'new',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  digest_id TEXT UNIQUE NOT NULL,
  stage TEXT DEFAULT 'pending',      -- mirrors flow stages above
  video_path TEXT,
  audio_path TEXT,                   -- final podcast MP3
  thumbnail_path TEXT,
  youtube_video_id TEXT,
  podcast_guid TEXT,
  site_url TEXT,
  tts_cost_usd REAL DEFAULT 0,
  image_cost_usd REAL DEFAULT 0,
  llm_cost_usd REAL DEFAULT 0,       -- metadata/ranking calls
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS publish_queue (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL,
  segment_id TEXT,                   -- set for reels
  kind TEXT NOT NULL,                -- 'reel_fb' | 'reel_youtube_short' | future kinds
  media_path TEXT NOT NULL,
  caption TEXT,
  publish_at TEXT NOT NULL,          -- ISO datetime
  status TEXT DEFAULT 'scheduled',   -- scheduled | published | failed
  platform_post_id TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_segments_digest ON segments(digest_id);
CREATE INDEX IF NOT EXISTS idx_publish_queue_due ON publish_queue(status, publish_at);
```

Edition support (for later, add now — costs nothing): add column
`digests.edition TEXT DEFAULT 'en'` and an `editions` JSON config file
(`config/editions.json`) with one entry: language, voice id, channel credential keys,
publish times, reel stagger offsets. All new services read edition config, never
hard-code 'en'.

---

## 4. New modules

All under `news-digest-pipeline/src/`. Follow existing code style (ESM, plain functions,
no classes unless the repo uses them).

### 4.1 `services/segmenter.js`
- `splitDigest(digest) -> Segment[]`
- Input: digest content + its articles (join via `articles.digest_id`).
- Strategy: change Phase B assembly prompt to emit explicit machine-readable markers
  (see §5). Parser splits on markers; falls back to numbered-list regex if markers
  missing. Intro/outro texts come from `config/editions.json` templates
  ("Welcome to <channel>, here are today's top stories…").
- Writes `segments` rows; strips course-promo/footer blocks from narration text
  (they stay in the text post, not the audio).

### 4.2 `services/tts.js`
- `synthesizeSegment(segment, editionCfg) -> {audioPath, durationMs, timestamps}`
- Provider abstraction like `llm.js` (env `TTS_VENDOR=openai`, model
  `gpt-4o-mini-tts` default; keep interface ready for `elevenlabs`).
- OpenAI TTS does not return word timestamps → after synthesis, run local
  `whisper.cpp` (small model, bundled in Docker image) or OpenAI
  `whisper-1` transcription with timestamps on our own audio to get word timings
  for subtitles. Env switch `SUBTITLES_SOURCE=whisper_local|whisper_api|none`.
- Normalize loudness to -16 LUFS (`ffmpeg loudnorm`) per segment.
- Record cost into `media_jobs.tts_cost_usd`.

### 4.3 `services/visual-sourcer.js`
- `sourceVisuals(segment, article) -> VisualAsset[]`
- Tier 1: fetch article URL (reuse `article-fetcher.js` + `url-validator.js`
  conventions; extend URL whitelist policy — see §8 security note), parse
  `og:image` / `twitter:image` / first meaningful `<img>` (skip icons < 300 px).
  Download to `data/media/<digest>/<segment>/`, validate min resolution 800×450,
  store `source_domain` for on-screen attribution.
- Tier 3 fallback: call `card-generator.js`.
- Target 1–3 visuals per segment; 1 is fine.

### 4.4 `services/card-generator.js`
- `makeHeadlineCard(headline, editionCfg, {vertical=false}) -> path`
- Sharp-based composition (same as Pro Instagram module pattern): brand background
  (static PNG from `assets/brand/` or optional fal.ai/Recraft generated background,
  env `CARD_BG=static|generated`), headline text auto-wrapped, channel logo,
  16:9 (1920×1080) or 9:16 (1080×1920).
- Also produces the YouTube thumbnail (1280×720) from the top-1 news headline.

### 4.5 `services/video-builder.js`
- `buildVideo(digestId) -> {videoPath}` — the 16:9 master.
- Per segment: FFmpeg `zoompan` Ken Burns over its visuals (split segment duration
  evenly across visuals, min 4 s per image, crossfade 0.5 s), overlay lower-third
  with headline + "Source: <domain>", pair with segment audio.
- Subtitle burn-in from `timestamps_json` → generate `.ass` file (max 2 lines,
  bottom-centered, brand font) → `subtitles=` filter.
- Concat: `intro.mp4` (5 s, static asset with logo animation, pre-made once,
  stored in `assets/brand/`) + segments + `outro.mp4` (5 s).
  Use concat demuxer with uniform encoding params (1920×1080, 30 fps, h264,
  yuv420p, aac 192k) — re-encode segments to the same params to avoid concat bugs.
- Also exports chapters file: `[{start_ms, title}]` from cumulative segment
  durations → used for YouTube description chapter timestamps.
- `buildPodcastAudio(digestId) -> {audioPath}` — concat segment MP3s + intro/outro
  audio stingers, ID3 tags (title, episode art from thumbnail).

### 4.6 `services/reel-builder.js`
- `buildReels(digestId) -> ReelRender[]` for segments where `is_top3=1`.
- Per reel: vertical 1080×1920; recompose = blurred-fill background from the
  segment's image + sharp centered image, or vertical headline card; 1.5 s hook
  title ("Today's #<rank>: <headline>"), same audio, same subtitles restyled
  larger; end card 2 s ("Full digest → link in description / <site>").
  Cap length at 75 s; if segment audio is longer, take the first sentence-boundary
  under 60 s (cut at silence via `silencedetect`).

### 4.7 `services/publishers/youtube-video.js`
- New file; do NOT overwrite existing `youtube.js` (community-post placeholder).
- YouTube Data API v3 `videos.insert` (resumable upload), then `thumbnails.set`.
- OAuth2 with offline refresh token; one-time helper script
  `scripts/youtube-auth.js` prints the consent URL and stores the refresh token.
- Metadata from one small LLM call (see §5): title (<100 chars), description
  (summary + chapters + site link + attribution lines "Sources: <domains>"),
  tags, `selfDeclaredMadeForKids=false`. Category: News & Politics.
- Register in `publishers/index.js` under platform name `youtube_video`.

### 4.8 `services/publishers/podcast.js`
- `publishEpisode(mediaJob, digest, editionCfg)`
- Copies MP3 to `public/podcast/media/<slug>.mp3` (served by existing Express
  static, behind Traefik → stable public URL).
- Maintains `public/podcast/feed.xml`: RSS 2.0 + iTunes namespace tags
  (`itunes:author`, `itunes:image`, `itunes:explicit=false`, `itunes:duration`,
  `enclosure` with byte length, stable `guid`). Rebuild feed from DB each time
  (source of truth = `media_jobs`), don't string-append.
- One-time manual step (document in `docs/podcast-setup.md`): submit feed URL to
  Spotify for Creators and Apple Podcasts Connect.

### 4.9 `services/publishers/site.js`
- `publishPost(digest, editionCfg) -> {url}`
- MVP: render digest into a static post using a template
  (`views/post.html`: headline list, full sarcastic text, embedded YouTube iframe
  added later by an update call, podcast player `<audio>` tag, source links,
  OG meta for social sharing). Write to `public/site/<yyyy-mm-dd>-<slug>.html`
  and regenerate `public/site/index.html` (latest 30 posts). Serve via Express
  static + Traefik on the site domain.
- After YouTube publish completes, `site.js.updatePost()` injects the video embed.
- Sitemap.xml + RSS for the site itself (SEO), regenerate on publish.
- Keep it dependency-free (template literals or a micro-templater); a real SSG or
  CMS can replace this later without touching the pipeline.

### 4.10 `services/media-worker.js`
- The orchestrator; mirrors `queue-manager.js` style:
  `startMediaWorker(config)` with `setInterval` (default 30 s).
- Picks up: (a) digests in `draft`/`published` without a `media_jobs` row when
  `MEDIA_AUTO=true`, or jobs created by dashboard button "Produce media";
  (b) `media_jobs` stuck mid-stage (resume); (c) due `publish_queue` rows
  (`publish_at <= now AND status='scheduled'`) → route to reel publishers.
- Stages run sequentially per digest; TTS calls for segments may run with
  concurrency 3. Every stage wraps in try/catch → sets `error`, notifies via
  existing `notifier.js` (Ntfy).
- Reel scheduling on `reels:rendered`: create 3 `publish_queue` rows with
  offsets from edition config (default: +30 min, +4 h, +9 h from digest publish).
- Reel publishers: `publishers/facebook.js` extended with `publishReel()`
  (Graph API video_reels flow: init → upload → finish_publish), and
  `youtube-video.js` reused for Shorts (vertical video ≤ 3 min is auto-Short;
  include #Shorts in title/description).

### 4.11 `services/fb-post-fetcher.js` — FB posts as a source (browserless, no login)
- Extends article ingestion: `POST /api/articles` and the Telegram bot accept
  `facebook.com` / `fb.watch` post URLs in addition to Perplexity links.
- `fetchFbPost(url) -> {authorName, authorUrl, text, imageUrls[], postedAt}`
- Extraction chain (stop at first success):
  1. **Embed endpoint:** GET `https://www.facebook.com/plugins/post.php?href=<encoded_url>&show_text=true`
     (plain HTTP, no cookies, desktop UA). Parse post text + author from the
     returned HTML. Works for genuinely public posts.
  2. **OG meta fallback:** GET the post URL logged-out; extract `og:title`
     (author/page), `og:description` (text snippet, may be truncated),
     `og:image`.
  3. **Failure state:** article saved with `status='fetch_failed'`,
     `fetch_error` set; dashboard shows "couldn't read — paste text manually"
     with an editable text field (route already supports content PATCH).
- Store as `articles` row: `source='facebook'`, `content=text`,
  `title=authorName + first line`, keep `authorName`/`authorUrl` in new columns
  `articles.author_name`, `articles.author_url`.
- **Politeness/durability:** cache fetched posts (URL-keyed, permanent — a post
  doesn't change), max 1 request/10 s to facebook.com, single retry, 10 s
  timeout, honest desktop User-Agent. Optional `FB_FETCH_PROXY_URL` env for a
  cheap HTTP proxy if the VPS IP ever gets blocked. Never use the owner's FB
  credentials or cookies anywhere in this path.
- **Prompt handling:** in Phase-A commentary, FB-source articles get one extra
  instruction line (prompt partial `prompts/en/fb-source-note.md`): treat as an
  opinion/post by "<author>", attribute by name, quote at most one short phrase,
  link to the original. Assembly output for these items renders as
  "<author> writes: <commentary> → <link>".
- **Visuals:** `og:image` from the post feeds visual-sourcer Tier 1 with
  `source_domain='facebook.com/<author>'` attribution overlay.
- **Validator note:** facebook.com joins the SEPARATE media-fetch SSRF-guarded
  path (§8), NOT the perplexity.ai article whitelist. Only `/plugins/post.php`
  and canonical post URL patterns (`/posts/`, `/permalink`, `pfbid`, `story.php`,
  `/reel/`, `/watch/`) are accepted; anything else is rejected.

### 4.11b `services/tg-post-fetcher.js` + bot extension — Telegram posts as a source
Two ingestion routes, preferred first:
- **Route A — forward to the bot (primary, official API, zero scraping).**
  Extend `telegram-bot.js` webhook handler: if an incoming message has
  `forward_origin` of type `channel` (or legacy `forward_from_chat`), treat it as
  a source post: `text`/`caption` → content; channel title + `@username` →
  `author_name`/`author_url` (`https://t.me/<username>/<forward_from_message_id>`);
  attached photo → download via Bot API `getFile` (≤ 20 MB) into media dir for
  visual-sourcer Tier 1. Store `source='telegram'`. Reply with the same
  confirmation the URL flow uses. Misses only channels with "restrict saving
  content" (forwarding disabled) → use Route B or manual paste.
- **Route B — t.me link pasted/sent.** `fetchTgPost(url)`:
  GET `https://t.me/<channel>/<id>?embed=1` (Telegram's intended public embed
  page; plain HTTP, no login) → parse text, author, photo URL; fallback to the
  plain post page OG tags. Accept URL patterns `t.me/<name>/<id>` and
  `t.me/s/<name>/<id>` only; private-channel links (`t.me/c/...`) are rejected
  with a dashboard hint to forward the post to the bot instead.
- Same politeness rules as FB fetcher (cache permanently, 1 req/10 s, timeout,
  no user credentials/session anywhere). t.me joins the SSRF-guarded media-fetch
  path.
- Prompt handling and attribution identical to FB-source posts (prompt partial
  covers "external author post" generically: attribute by name, minimal quoting,
  link original). Digest renders as "<channel> writes: <commentary> → <link>".

### 4.11c Source-language handling
- Sources may arrive in any language (Perplexity = English; FB/TG posts often
  Ukrainian or Russian). No separate translation step: the Phase A commentary
  prompt states the edition's output language explicitly ("regardless of the
  source language, write in <edition.language>") — the model translates
  implicitly while reinterpreting, same mechanism Krol uses for EN→RU.
- Cheap language detection on ingestion (heuristic: Cyrillic ratio, or the
  `franc` npm package — no API call): store `articles.source_lang`. Used for:
  (a) dashboard badge; (b) when quoting an external author whose post was not
  in the edition language, the digest marks the quote "(translated)"; (c) later
  editions can filter/prioritize sources by language.
- Edge case: mixed-language posts and code-switched UA/RU text need no special
  handling — the model copes; `source_lang` stores the dominant language only.

### 4.12 Dashboard additions (`public/index.html` + `routes/`)
- Per digest row: media stage badge, "Produce media" button, links to rendered
  files, reel schedule list with cancel button, cumulative media cost display
  (tts + image + llm) next to existing `cost_usd`.
- New routes `routes/media.js`: `POST /api/digests/:id/media` (start),
  `GET /api/digests/:id/media` (status), `DELETE /api/publish-queue/:id`.
  Same auth model as existing routes (Bearer/session, public GET = safe fields
  only — extend `public-dto.js`).

---

## 5. Prompt changes

1. **`assembly_prompt.md`** — add an output contract section:
   - Wrap every news item as:
     `<!--SEG idx=N article_id=... headline="..."-->` … `<!--/SEG-->`
     (HTML comments are invisible when the same text is posted to FB/TG.)
   - After the digest, output one line:
     `<!--TOP3 [n1,n2,n3]-->` — the 3 items with highest viral/emotional potential.
2. **New `metadata_prompt.md`** — single small call (Haiku 4.5 or GPT-5.4 Mini,
   env `META_MODEL`): input = digest + chapters; output strict JSON:
   `{youtube_title, youtube_description, tags[], reel_captions[3], slug, seo_description}`.
3. English edition: `prompt.md`/`assembly_prompt.md` get English variants under
   `prompts/en/` (edition config points to prompt dir). Keep Krol's sarcastic
   authorial tone — it is the transformation layer that justifies the format.
4. **Niche editorial rules (defense & security digest)** — hard requirements in
   `prompts/en/prompt.md`:
   - Tone: dry, skeptical, analytical wit. Legitimate targets of irony:
     propaganda claims, procurement absurdity, political theater, inflated or
     unverifiable statements. NEVER direct humor or sarcasm at casualties,
     victims, refugees, or ongoing human tragedy; those items get a sober,
     analytical register within the same digest.
   - OSINT hygiene: every factual claim carries an explicit confidence marker
     in the commentary where relevant — "confirmed", "claimed by <side>",
     "unverified". Prefer naming the origin of a claim over repeating it as
     fact. Skepticism about sourcing is part of the voice, not a disclaimer.
   - No graphic descriptions of violence beyond what analysis requires.
5. **Visual safety rule** (`visual-sourcer.js` + `card-generator.js`): prefer
   neutral imagery — maps, equipment, infographics, officials, satellite
   imagery. Skip article images that appear graphic (heuristic: if in doubt,
   fall back to a headline card). Keeps the channel clear of YouTube/Meta
   graphic-content and ad-suitability flags for conflict coverage.

---

## 6. FFmpeg reference commands

(Implementation may build filtergraphs programmatically; these define expected behavior.)

Ken Burns single image → segment video (duration from audio):
```
ffmpeg -loop 1 -i img.jpg -i seg.mp3 \
 -filter_complex "[0:v]scale=8000:-1,zoompan=z='min(zoom+0.0008,1.15)':d=<frames>:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,format=yuv420p[v]" \
 -map "[v]" -map 1:a -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -shortest seg.mp4
```

Subtitle burn (ASS generated from word timestamps, grouped to ≤ 42 chars/line):
```
ffmpeg -i seg.mp4 -vf "ass=seg.ass" -c:a copy seg_sub.mp4
```

Concat (all parts pre-encoded to identical params):
```
ffmpeg -f concat -safe 0 -i list.txt -c copy master.mp4
```

Vertical reel background (blur-fill):
```
ffmpeg -i img.jpg -i seg.mp3 -filter_complex \
 "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];\
  [0:v]scale=1080:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]" \
 -map "[v]" -map 1:a -t 60 -c:v libx264 -crf 21 -c:a aac reel.mp4
```

Loudness normalize: `-af loudnorm=I=-16:TP=-1.5:LRA=11` on final audio outputs.

Docker: add `ffmpeg` and (if `SUBTITLES_SOURCE=whisper_local`) `whisper.cpp` +
small model (~500 MB) to the image; document RAM/CPU expectations
(10-min 1080p render ≈ 5–10 min on a 2-vCPU VPS — acceptable for 1 block/day).

---

## 7. .env additions

```
MEDIA_AUTO=true                  # produce media automatically after digest draft
TTS_VENDOR=openai
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=onyx
SUBTITLES_SOURCE=whisper_local
META_MODEL=gpt-5.4-mini
CARD_BG=static
FAL_API_KEY=                     # only if CARD_BG=generated
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_CHANNEL_ID=
SITE_BASE_URL=https://yourdomain.com
PODCAST_TITLE=
PODCAST_AUTHOR=
PODCAST_BASE_URL=${SITE_BASE_URL}/podcast
REEL_OFFSETS_MIN=30,240,540      # minutes after digest publish
```

---

## 8. Security & policy notes (carry over repo's posture)

- **URL whitelist:** `url-validator.js` currently whitelists `perplexity.ai` only.
  `visual-sourcer.js` fetches arbitrary news domains → introduce a SEPARATE
  fetch path with its own SSRF guard: resolve DNS, reject private/loopback/link-local
  IPs, HTTPS only, size cap 15 MB, image content-types only, no redirects to
  non-HTTPS. Do not widen the article-ingestion whitelist.
- All new POST routes behind existing Bearer/session auth + rate limiting.
- Media files are public by design (served for podcast/site); everything else
  under `data/` stays non-served.
- YouTube/FB publishing only via official APIs (no browser automation — see
  repo's shadow-ban research).
- Attribution overlay ("Source: <domain>") is mandatory on Tier-1 images; no
  logic that removes or obscures source watermarks.
- Disclose AI narration in YouTube upload settings (altered/synthetic content
  flag) and in the standard description footer.

---

## 9. Build order (each phase independently shippable)

1. **P1 — Segments + TTS + podcast.** segmenter, tts, buildPodcastAudio,
   podcast publisher, dashboard badge. Deliverable: daily podcast episode.
2. **P2 — Video master + YouTube.** visual-sourcer (Tier 1+3), card-generator,
   video-builder, subtitles, youtube-video publisher, thumbnail. Deliverable:
   daily 10-min YouTube video with chapters.
3. **P3 — Website.** site publisher, FB/TG text now links to site; YouTube
   embed back-fill. Deliverable: canonical site with SEO basics.
4. **P4 — Reels.** reel-builder, top-3 ranking parse, publish_queue scheduler,
   FB Reels + YouTube Shorts publishers. Deliverable: 3 staggered reels/day.
5. **P5 — external posts as source (FB + Telegram).** fb-post-fetcher,
   tg-post-fetcher, bot forward-handler, ingestion route + URL acceptance,
   author columns, "external author" prompt partial, dashboard manual-paste
   fallback. Deliverable: forward a TG post or paste a FB/TG link → it appears
   in the next digest with attribution. (Build TG Route A first — it is the
   simplest and most reliable piece of the whole phase.)
6. **P6 — hardening.** resume-from-stage tests, cost dashboard, edition config
   plumbed end-to-end (still single 'en' edition active).

---

## 10. Unit economics (MVP, per daily block)

| Item | Est. cost |
|---|---|
| Digest LLM (existing pipeline) | ~$0.30 |
| Metadata/ranking LLM call | ~$0.03 |
| TTS ~10 min (gpt-4o-mini-tts) | ~$0.15 |
| Whisper timestamps (local) | $0.00 |
| Headline cards + thumbnail (static bg) | ~$0.00–0.16 |
| Renders, uploads, RSS, site | $0.00 |
| **Total** | **~$0.50–0.65/day** |

Fixed: VPS $7–12/mo (2 vCPU / 4 GB recommended for ffmpeg + whisper.cpp).
Intro/outro (5 s each) — one-time asset, stored in `assets/brand/`.
