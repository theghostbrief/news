# The Ghost Brief

## 1. What this project is

The Ghost Brief — an English-language defense & security news digest platform. This is an independent fork with its own roadmap (originally forked from a Russian-language Facebook-digest project by Alexey Krol; MIT-licensed, attribution kept in README/LICENSE — the course-promo banner and other upstream branding have been removed as of 2026-07-22, this fork is not affiliated with the original course).

The product is pivoting end-to-end (dashboard UI, Telegram bot, and eventually digest content itself) from Russian to English, for a defense & security audience.

## 2. Current state (deployed & working)

- **Production**: `theghostbrief.com`, Hetzner VPS at `37.27.188.38`.
- **Dashboard UI** (index/articles/settings pages) and **Telegram bot**: fully translated to English (2026-07-22).
- **English "Ghost Brief" digest persona — Stage 4a done (2026-07-22).** `prompts/en/{prompt,assembly_prompt,config}.md` (new persona "The Ghost": dry, skeptical defense analyst; OSINT confidence markers "confirmed"/"claimed by <side>"/"unverified"; sober no-irony register for casualties/victims, absolute rule) are written and wired end-to-end as a third scenario, `ACTIVE_SCENARIO=ghost`, selectable in the Settings dashboard alongside Krol's untouched Sarcasm/Architect scenarios. `digest-generator.js`'s Phase B (assembly prompt, wrapper message, completion marker) is now scenario-aware since Ghost has its own independent assembly prompt/footer/hashtags instead of Krol's Russian course-mention/boundary text. The assembly prompt already emits the `<!--SEG idx=N article_id=... headline="..."-->` / `<!--TOP3 [n,n,n]-->` machine-readable markers per spec §5.1, ready for the future `segmenter.js` (P1). Verified with a real generation run against 13 live queued articles — see `news-digest-pipeline/output/ghost-comparison/` for the output (default Ghost voice + two throwaway tone-comparison variants: near-neutral analytical, maximum wit). One model artifact seen once (a stray Armenian-script word from `gpt-5.6-terra`, not a prompt bug) — worth a quick eye on future runs, not yet a pattern.
- **`media-pipeline-spec.md`** now lives in the repo at `news-digest-pipeline/docs/media-pipeline-spec.md` (copied in 2026-07-22 — it previously only existed in a local Downloads folder, un-versioned, which is why §4's reference to it was briefly a dead end at the start of a session).
- **Server-side content fetcher**: SSRF-hardened fetch (`src/services/safe-fetch.js`, DNS + private-IP guarding) plus a domain allowlist (`ALLOWED_ARTICLE_DOMAINS` env var; `perplexity.ai` is always allowed).
- **Jina Reader fallback**: `JINA_READER_FALLBACK=true` in production `.env`. Proxies fetches for known-blocked domains through `r.jina.ai` instead of giving up at `fetch_failed`.
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
- **Tone/voice for the English content: decided (2026-07-22).** "The Ghost" persona — dry, skeptical wit aimed at propaganda claims/procurement absurdity/political theater, never at casualties or victims (sober register there instead). See §2.
- **OSINT confidence markers are non-negotiable, not a nice-to-have.** Every claim in Ghost-persona commentary must be tagged "confirmed" / "claimed by &lt;side&gt;" / "unverified" — this is what keeps a defense-niche digest credible instead of reading like unsourced aggregation.

## 4. What's NOT done yet

Stage 4a (English prompts, §3 above) is done. **Next up:** `media-pipeline-spec.md`'s build order, phases **P1 → P6** in order (§9 of the spec) — starting with **P1: segments + TTS + podcast** (`segmenter.js` parsing the SEG/TOP3 markers, `tts.js`, `buildPodcastAudio`, podcast publisher, dashboard badge). Don't skip ahead — each phase should be validated (tests + a live check on the deployed server) before starting the next.

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
