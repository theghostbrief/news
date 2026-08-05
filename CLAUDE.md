# The Ghost Brief

## 1. What this project is

The Ghost Brief — an English-language defense & security news digest platform. This is an independent fork with its own roadmap (originally forked from a Russian-language Facebook-digest project by Alexey Krol; MIT-licensed, attribution kept in README/LICENSE — the course-promo banner and other upstream branding have been removed as of 2026-07-22, this fork is not affiliated with the original course).

The product is pivoting end-to-end (dashboard UI, Telegram bot, and eventually digest content itself) from Russian to English, for a defense & security audience.

## 2. Current state (deployed & working)

- **Production**: `theghostbrief.com`, Hetzner VPS at `37.27.188.38`.
- **Dashboard UI** (index/articles/settings pages) and **Telegram bot**: fully translated to English (2026-07-22).
- **English "Ghost Brief" digest persona — Stage 4a done, voice locked (2026-07-22).** `prompts/en/{prompt,assembly_prompt,config}.md` (persona "The Ghost": **near-neutral analytical** register — calm, precise, minimal personality, one analytical observation per item, not dry wit; OSINT confidence markers "confirmed"/"claimed by &lt;side&gt;"/"unverified"; even-more-restrained sober register for casualties/victims, absolute rule) are written and wired end-to-end as a third scenario. `ghost` is now the **production default** — `ACTIVE_SCENARIO=ghost` in the server `.env` and the code-level fallback in `config.js`/`routes/settings.js`/`digest-generator.js` (was `sarcastic`) — selectable alongside Krol's untouched Sarcasm/Architect scenarios in the Settings dashboard. `digest-generator.js`'s Phase B (assembly prompt, wrapper message, completion marker) is scenario-aware since Ghost has its own independent assembly prompt/footer/hashtags instead of Krol's Russian course-mention/boundary text. The assembly prompt emits the `<!--SEG idx=N article_id=... headline="..."-->` / `<!--TOP3 [n,n,n]-->` machine-readable markers per spec §5.1, ready for the future `segmenter.js` (P1).
  - **American English is enforced by explicit prompt rule** in both `prompt.md` and `assembly_prompt.md` (spelling only — defense/armor/program/center/analyze/organization/judgment, converting any British spelling in source material). A full sweep of every English-facing file we control (prompts/en/, dashboard HTML, bot messages, routes, middleware) found zero British spellings already present.
  - Verified twice with real generation runs against the same 13 live queued articles (see `news-digest-pipeline/output/ghost-comparison/` for saved output: the original dry-wit voice, two throwaway tone-comparison variants — near-neutral analytical and maximum wit — and the final locked-voice verification run). The near-neutral variant was chosen as production.
- **Script guard for stray non-Latin script (2026-07-22).** The Armenian-script artifact recurred a second time (`gpt-5.6-terra` again dropped a foreign word into English commentary), so it's now handled automatically rather than just watched for: `src/services/script-guard.js` detects unquoted runs of non-Latin script (legitimate quoted material is excluded), scoped to the `ghost` scenario only (Krol's Russian scenarios legitimately output Cyrillic). `digest-generator.js` auto-retries a contaminated Phase A item once, then does a final sweep over the assembled digest (catches Phase-B-generated headlines/the "Ghost's read" line too, which the per-item retry can't reach). Anything still dirty after that sets `digests.script_warning` (new column, idempotent migration) — surfaced as a ⚠️ badge next to the status dropdown (tooltip = detail) and a banner in the preview modal, so a flagged draft is hard to miss before publishing. Owner-only field, deliberately excluded from the public DTO like `generation_log`/`cost_usd`/`model`.
- **`media-pipeline-spec.md`** now lives in the repo at `news-digest-pipeline/docs/media-pipeline-spec.md` (copied in 2026-07-22 — it previously only existed in a local Downloads folder, un-versioned, which is why §4's reference to it was briefly a dead end at the start of a session).
- **Publish-time marker stripping + readable publisher errors (2026-07-22).** The first real publication leaked raw `<!--TOP3 [4,5,9]-->` text into a Telegram post. `src/services/digest-format.js` (`stripDigestMarkers`) is now applied in every publisher (Telegram, Facebook, and noted for whoever implements YouTube) right before the outgoing text is sent — the stored `digest.content` keeps the markers, only outgoing/display copies are stripped (same function the preview modal already used client-side). Also hardened `facebook.js`/`telegram.js`: both read the HTTP response as text and `JSON.parse` it in an isolated try/catch, so a non-JSON body produces a readable error instead of an unreadable raw parse exception reaching the dashboard; both now return `{ error }` on failure instead of a bare `null`, and `publishPlatform()` in the dashboard displays that message.
- **Facebook publishing is configured and confirmed live (2026-07-22).** `FACEBOOK_PAGE_ID=1107271269140227` (facebook.com/theghostbrief) and a long-lived `FACEBOOK_PAGE_ACCESS_TOKEN` (extended via the Access Token Debugger, no App Secret exchange needed) are set in the server `.env`. Verified by actually publishing a digest and reading the live post back via the Graph API — clean text, no SEG/TOP3 markers. Page setup doc: `docs/facebook-page-setup.md` (English). **Token exposure note:** the access token was pasted into an assistant chat while being set via SSH (the harness echoes full commands back, same class of exposure as the SSH key incident) — treat that specific token as compromised; rotate it via the Access Token Debugger next time credentials need touching, same safe SSH-only method as before, just don't run the `sed` command as a single command containing the live token (a heredoc with the token on its own short line still gets echoed back in full — there's no way to run the exact substitution command via the assistant without the value round-tripping through chat; only truly out-of-band edits, e.g. the user SSHing in directly without going through `!`, avoid it entirely).
- **Server-side content fetcher**: SSRF-hardened fetch (`src/services/safe-fetch.js`, DNS + private-IP guarding) plus a domain allowlist (`ALLOWED_ARTICLE_DOMAINS` env var; `perplexity.ai` is always allowed).
- **Jina Reader fallback**: `JINA_READER_FALLBACK=true` in production `.env`. Proxies fetches for known-blocked domains through `r.jina.ai` instead of giving up at `fetch_failed`. **`JINA_API_KEY`** (added 2026-08-04) moves Jina Reader off the anonymous rate limit for Perplexity fetches. **Token exposure note:** this key was pasted into an assistant chat while being set — same class of exposure as the Facebook token and SSH key incidents below. Unlike those, there's no rotation available: Jina's free tier has no key-regenerate option, the key is fixed to the account's token wallet. Exposure risk is low (token-spend only, no account/data access) — monitor the Usage tab at jina.ai for unexpected token drain; if it occurs, the only fix is a fresh Jina account for a new key.
- **Public reader page live at `theghostbrief.com` root** (shipped 2026-07-31, confirmed still current 2026-08-04). Dashboard moved to `/admin` (same Basic Auth/session-cookie login, just a different path); old bare dashboard paths 404 rather than redirect. Read-only API is `routes/public.js`, backed by dedicated `getPublishedDigests()`/`getPublishedDigestById()` queries in `db/index.js` that hardcode `status='published'` + non-empty `content` + clear `script_warning` as SQL literals (never caller-supplied) so drafts/flagged digests can't leak. Full detail in the `public-reader-page-shipped` memory.
- **TOP3 headline card generator shipped (2026-08-04), live on Threads.** `src/services/card-generator.js` — sharp+SVG-rendered 1080×1080 branded PNGs (wrapped headline, OSINT confidence-marker pill, Ghost logo corner) for the digest's 3 TOP3 items. Generated at publish time (`ensureTop3CardUrls()`, called from `POST /:id/publish`), stored under `data/media/cards/<digest_id>/` (the `./data` volume, so cards survive a redeploy — `src/public-site/` does not, it's baked into the image), served publicly at `/media/cards/*`, and recorded in the new `digests.cards_json` column in a publisher-agnostic shape. Threads now attaches the card as an `IMAGE` container (caption + `image_url`) instead of `TEXT`-only. Card generation is best-effort and fails closed — any error, or `PUBLIC_MEDIA_BASE_URL` left unset, falls back to text-only publishing rather than blocking it.
- **Instagram TOP3 auto-posting built (2026-08-05), not yet deployed/live-verified.** `src/services/publishers/instagram-publisher.js` — same container→publish flow as Threads, posts each TOP3 item as an IG feed post (the existing TOP3 card image + caption) via `INSTAGRAM_ACCOUNT_ID` / `INSTAGRAM_ACCESS_TOKEN` (reuses the Facebook Page long-lived token, no separate auth flow). Immediate/synchronous — 3 posts back to back, no scheduling yet. Unlike Threads, IG feed posts require an image and have no TEXT fallback: an item with no matching `cards_json` entry fails that item (and the run) closed rather than posting text-only. Resumable via `digests.instagram_media_ids`, same contract as `threads_thread_ids`. Wired into `publishers/index.js` as its own independent block (own try/catch, own `instagram_status`/`instagram_error`), so an IG failure — including an empty `cards_json` failing all 3 items — never blocks or is blocked by Facebook/Telegram/Threads. Dashboard has a 📷 IG publish button next to Threads. All 14 new tests pass locally (203/203 suite-wide) — per §5's "validate before moving on," still needs `INSTAGRAM_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN` set in the server `.env`, a deploy, and one real publish verified against the live Graph API before roadmap item #2 (staggered scheduling) starts.
- **Deploy flow**: the server tracks `origin/main` directly — `git status` is clean, HEAD matches the repo (fixed 2026-07-22; previously the server's git index was stale for months while the working tree was kept current via manual file copies). Deploy is now just:
  ```
  cd /srv/news-digest-pipeline && git pull
  cd news-digest-pipeline && docker compose build && docker compose up -d
  ```
- **SSH access**: root key auth only (no password). The key lives in the Windows `ssh-agent` service (`Get-Service ssh-agent`), which holds it unlocked persistently across PowerShell *and* Git Bash sessions — this is the one agent that matters, not a per-shell `ssh-agent -s` you'd spawn yourself. To load a new/rotated key: `/c/Windows/System32/OpenSSH/ssh-add.exe <path>` (Git Bash's own `ssh-add` can't reach the Windows agent and will error "Could not open a connection"). The passphrase is always typed interactively via a `!`-prefixed terminal command in front of the user — never pasted into chat.
- **`.env` / `data/`**: both gitignored, both live only on the server. Never lost by git operations (`reset --hard` / `clean -fd` don't touch ignored paths) — verified safe during the 2026-07-22 drift reconciliation.

## 3. Key decisions and why

- **Perplexity = "needs content fetch" route.** `perplexity.ai` sits behind Cloudflare's bot challenge — a plain server-side fetch gets HTTP 403 unconditionally, no header/retry tuning gets through. `content-fetcher.js` detects known-blocked domains and skips straight to the Jina Reader fallback (or `fetch_failed` if the fallback is off) rather than burning a request on a guaranteed failure.
- **No headless browser.** Chose a lightweight server-side fetch + third-party Jina Reader proxy over running Puppeteer/Playwright in production — avoids the operational weight, fragility, and larger detection surface of driving a real browser on the server just to get past Cloudflare.
- **Voice locked: near-neutral analytical (2026-07-22), not dry wit.** The first Ghost-persona draft used dry, skeptical wit (irony aimed at propaganda claims/procurement absurdity/political theater). After comparing three tone variants side-by-side (dry wit, near-neutral analytical, maximum wit) on the same real articles, **near-neutral analytical was chosen as the production voice** — calm, precise, minimal personality, the tone of a serious geopolitical risk briefing. Casualties/victims still get an even-more-restrained version of that register (no analytical color at all), per the absolute rule.
- **OSINT confidence markers are non-negotiable, not a nice-to-have.** Every claim in Ghost-persona commentary must be tagged "confirmed" / "claimed by &lt;side&gt;" / "unverified" — this is what keeps a defense-niche digest credible instead of reading like unsourced aggregation.
- **American English only, enforced by prompt rule, not just habit.** A defense/security audience will read "programme"/"defence"/"analyse" as a tell that the content wasn't written for them. The rule is explicit in both prompts and converts British spelling encountered in source material, rather than relying on the model defaulting correctly.

## 4. What's NOT done yet

Stage 4a (English prompts, §3 above) is done. Instagram TOP3 auto-posting (§2 above) is built and unit-tested but still needs `.env` credentials + a deploy + a live Graph API check before it counts as done per §5. **Next up after that:** `media-pipeline-spec.md` §9's roadmap, in order — updated 2026-08-05:
1. **Staggered post scheduling** (10–20 min delays between the 3 TOP3 posts, IG + Threads, via `publish_queue`).
2. **Website images** (populate `articles.image_url`, already-existing column).
3. **Public page design pass**.
4. **P1 audio** — segment TTS + podcast RSS (`segmenter.js` already ships; remaining is `tts.js`, `buildPodcastAudio`, podcast publisher, dashboard badge).

Don't skip ahead — each item should be validated (tests + a live check on the deployed server) before starting the next. Video/YouTube, Reels, and external-post ingestion (the old P2/P4/P5) are still valid scope but deprioritized below this list — see spec §9's "Not yet scheduled" section.

Not yet decided: whether/when Krol's Russian scenarios (Sarcasm/Architect) get retired versus kept as a permanent second edition — currently all three scenarios (Sarcasm, Architect, Ghost) coexist and are independently selectable.

Krol's original Russian prompts (`prompts/{prompt,prompt_deep,assembly_prompt,config}.md`) are kept as-is, untouched, as reference/fallback scenarios — not legacy-to-be-deleted, just no longer the default.

## 5. Working conventions

- **One phase per session.** Don't bundle multiple spec phases (§4) into a single session — land one, verify it, stop.
- **Commit and push after every successful change.** Don't let the working tree accumulate uncommitted drift on either the local machine or the server — that's exactly what caused the 2026-07-22 server git reconciliation.
- **Never touch `.env` in commits.** It's gitignored and holds live production secrets (API keys, tokens, DB path). Edit it directly on the server over SSH; it must never appear in a diff, commit, or PR.

## File paths (legacy manual workflow — root-level, Russian)

Separate from the deployed app: manual digest assembly from Chrome-extension exports, still root-level and still Russian.
- Input: `./input_*.json` (from `extension/`)
- Output: `./output/digest_YYYY-MM-DD_partN.txt`
- Rules: `./prompt.md` (commentary style), `./assembly_prompt.md` (assembly format), `./config.md` (exchange rate, hashtags, boundary text)

### Delegating tasks to subagents

When a task comes in, first assess:
- **Do it yourself:** quick edits (< 2 min), discussion, analysis, questions, small fixes.
- **Delegate to a subagent:** code > 50 lines, new modules, refactors, UI changes, research, anything > 5 min.

When delegating:
- Write a detailed brief with context, files to read, and expected output.
- Launch in the background.
- Tell the user what's running.
- Report back concisely once it's done.
- Multiple subagents can run in parallel on independent tasks.

Goal: maximum parallelism, minimum time the user spends waiting.

## Autonomy

The agent is fully autonomous within this project. All decisions on code, architecture, testing, security, and quality are made independently, without asking the user for confirmation.

**Only involve the user when:**
- Credentials or access to external services are needed (VPS, API keys, tokens).
- Connecting to a remote server.
- A final demo of the result is due.
- A genuinely ambiguous product decision (not a technical one) needs to be made.

<!-- BEGIN: PIPELINE_MODEL_SELECTION_HANDOFF -->
## Pipeline Model Selection Handoff

When work concerns a model-backed pipeline/API route, read [Claude Code Pipeline Model-Selection Handoff](/Users/alexeykrolmini/Code/CLAUDE_CODE_PIPELINE_MODEL_SELECTION_HANDOFF.md) and its required [GPT-5.6 Model Selection Guide](/Users/alexeykrolmini/Code/GPT-5.6-model-selection-guide-ru.md).
Start with a read-only, microtask-level audit; verify exact provider models, reasoning controls, and pricing from current official documentation; return an evaluation/rollback recommendation before changing any runtime route.
<!-- END: PIPELINE_MODEL_SELECTION_HANDOFF -->
