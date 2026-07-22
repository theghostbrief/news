# The Ghost Brief

## 1. What this project is

The Ghost Brief — an English-language defense & security news digest platform. This is an independent fork with its own roadmap (originally forked from a Russian-language Facebook-digest project by Alexey Krol; MIT-licensed, attribution kept in README/LICENSE — the course-promo banner and other upstream branding have been removed as of 2026-07-22, this fork is not affiliated with the original course).

The product is pivoting end-to-end (dashboard UI, Telegram bot, and eventually digest content itself) from Russian to English, for a defense & security audience.

## 2. Current state (deployed & working)

- **Production**: `theghostbrief.com`, Hetzner VPS at `37.27.188.38`.
- **Dashboard UI** (index/articles/settings pages) and **Telegram bot**: fully translated to English (2026-07-22). Digest *content* itself is still Russian — see §4.
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
- **Tone/voice for the new English content: not decided yet.** The current "Sarcasm" / "Architect" scenario system (`SCENARIO_OPTIONS` in `routes/settings.js`) is tailored to the old Russian Facebook-audience voice and won't carry over as-is. The defense & security niche's authorial tone is an open question for the prompt rewrite in §4.

## 4. What's NOT done yet

**Next up:** write English prompts in `prompts/en/`, per `media-pipeline-spec.md` §5.

After that: work through the spec's phases **P1 → P6** in order. Don't skip ahead — each phase should be validated (tests + a live check on the deployed server) before starting the next.

The current Russian digest-generation logic (`src/config.js`, `src/services/digest-generator.js`, and `prompts/{prompt,prompt_deep,assembly_prompt,config}.md`) is legacy, kept running as-is until the English rewrite replaces it — it was deliberately left untouched during the 2026-07-22 UI translation pass.

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
