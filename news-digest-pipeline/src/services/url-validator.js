// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for validating article URLs.
//
// Every path that ingests an article URL (POST /api/articles, POST
// /api/articles/batch, the Telegram intake) and the local Mac fetcher run the
// raw string through this one validator, so the contract is identical
// everywhere: HTTPS only, host on the perplexity.ai allowlist, no ASCII control
// characters, bounded length. It returns the WHATWG-normalized `href` — the
// only form that should ever be stored or handed to the fetcher.
//
// Why control chars are rejected outright: the local fetcher interpolates the
// URL into an AppleScript string executed via osascript. A newline or quote
// there is a command-injection sink. `new URL().href` percent-encodes quotes,
// backslashes and spaces, and rejecting control characters removes the last way
// to break out of the AppleScript/heredoc string — making injection structurally
// impossible rather than merely unlikely.
//
// Zero dependencies (only the global WHATWG URL) so scripts/local-fetcher.js can
// import it directly without pulling in the server's module graph.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_HOSTS = new Set(['perplexity.ai', 'www.perplexity.ai']);
const MAX_URL_LEN = 2048;
// ASCII control chars (C0 range + DEL). Never valid in a URL, and the injection
// sink for the AppleScript/heredoc string in scripts/local-fetcher.js.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate and normalize an article URL.
 * @param {unknown} raw
 * @returns {{ok: true, href: string} | {ok: false, error: string}}
 */
export function validateArticleUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  const s = raw.trim();
  if (!s) return { ok: false, error: 'url is required' };
  if (s.length > MAX_URL_LEN) return { ok: false, error: 'url too long' };
  if (CONTROL_CHARS.test(s)) return { ok: false, error: 'url contains control characters' };

  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only HTTPS URLs are accepted' };
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: 'Only perplexity.ai URLs are accepted' };
  }
  return { ok: true, href: parsed.href };
}
