// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for validating article URLs.
//
// Every path that ingests an article URL (POST /api/articles, POST
// /api/articles/batch, the Telegram intake) and the local Mac fetcher run the
// raw string through this one validator, so the contract is identical
// everywhere: HTTPS only, host on the allowlist below, no ASCII control
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
// Zero dependencies (only the global WHATWG URL + process.env) so
// scripts/local-fetcher.js can import it directly without pulling in the
// server's module graph.
//
// Allowlist model: perplexity.ai is matched by EXACT hostname (apex + www
// only) — a deliberate, tight rule preserved even when ALLOWED_ARTICLE_DOMAINS
// widens the list, so a look-alike/takeover subdomain like evil.perplexity.ai
// never passes just because other sources allow subdomain matching. Domains
// added via ALLOWED_ARTICLE_DOMAINS (comma-separated, e.g. defense/news
// sources that don't gate behind Cloudflare the way perplexity.ai does) match
// by suffix, so their legitimate subdomains (www., regional editions, etc.)
// work without listing each one.
// ─────────────────────────────────────────────────────────────────────────────

const CORE_EXACT_HOSTS = new Set(['perplexity.ai', 'www.perplexity.ai']);
const MAX_URL_LEN = 2048;
// ASCII control chars (C0 range + DEL). Never valid in a URL, and the injection
// sink for the AppleScript/heredoc string in scripts/local-fetcher.js.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Extra domains allowed via ALLOWED_ARTICLE_DOMAINS (comma-separated), matched
 * by suffix (apex + any subdomain). Read from process.env on every call
 * (rather than cached at module load) so it stays test-friendly and picks up
 * an updated .env without requiring a fresh import of this module.
 */
function getExtraAllowedDomains() {
  const raw = process.env.ALLOWED_ARTICLE_DOMAINS;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    // perplexity.ai already has its own tighter, exact-match rule above; never
    // let env config loosen it to suffix/subdomain matching.
    .filter((d) => d !== 'perplexity.ai' && d !== 'www.perplexity.ai');
}

function hostMatchesSuffix(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Domain list for error messages / bot replies: core + configured extras. */
export function allowedDomainsForDisplay() {
  return ['perplexity.ai', ...getExtraAllowedDomains()];
}

function isAllowedHostname(hostname) {
  if (CORE_EXACT_HOSTS.has(hostname)) return true;
  return getExtraAllowedDomains().some((d) => hostMatchesSuffix(hostname, d));
}

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
  if (!isAllowedHostname(parsed.hostname.toLowerCase())) {
    return { ok: false, error: `Only these domains are accepted: ${allowedDomainsForDisplay().join(', ')}` };
  }
  return { ok: true, href: parsed.href };
}
