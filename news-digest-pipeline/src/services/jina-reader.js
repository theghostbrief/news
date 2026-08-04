import { validateArticleUrl } from './url-validator.js';

const JINA_READER_PREFIX = 'https://r.jina.ai/';
// Jina renders the target page server-side (their own infra, their own
// headless browser) before returning Markdown — slower than a plain fetch.
const TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;

// Matches Jina's "blocked until <timestamp>" phrasing in an AbuseAlleviationError
// message, e.g. "...blocked until Tue Jul 28 2026 08:17:33 GMT+0000 (Coordinated...".
// The captured group is exactly the format Date's own toString() produces (minus
// the trailing zone-name parenthetical), which `new Date(...)` parses natively.
const BLOCKED_UNTIL_RE = /blocked until ([A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4})/;

/**
 * Jina's transient, domain-wide anti-abuse block (confirmed live 2026-07-28
 * against perplexity.ai: "AbuseAlleviationError", status 40305) — NOT a real
 * 403 from the target site, and not permanent: the response carries its own
 * expiry timestamp. content-fetcher.js schedules a backoff retry for this
 * specific error instead of failing the article permanently.
 */
export class JinaAbuseBlockError extends Error {
  constructor(message, blockedUntil) {
    super(message);
    this.name = 'JinaAbuseBlockError';
    this.blockedUntil = blockedUntil; // Date | null — null if the timestamp didn't parse
  }
}

/**
 * Fetch article content via Jina Reader (https://r.jina.ai/<url>), a free
 * third-party proxy that renders the target page server-side (including
 * JS-gated content) and returns it as Markdown. This is what makes it able to
 * read perplexity.ai pages at all — Cloudflare's bot challenge blocks a plain
 * fetch from this server outright (verified 2026-07-22: HTTP 403, "Just a
 * moment..." interstitial), but Jina's own infrastructure isn't blocked.
 *
 * Opt-in only (JINA_READER_FALLBACK=true) — this sends the article URL to a
 * third-party service, which content-fetcher.js only does for domains it
 * already knows a direct fetch can never reach (see KNOWN_BLOCKED_DOMAINS).
 *
 * `apiKey` (config.jinaApiKey / JINA_API_KEY) is optional — when present it's
 * sent as a Bearer token, which moves the request off Jina's anonymous rate
 * limit (anonymous requests get abuse-blocked on perplexity.ai, see
 * JinaAbuseBlockError above). When absent, fetches anonymously as before.
 */
export async function fetchViaJinaReader(articleUrl, apiKey) {
  const v = validateArticleUrl(articleUrl);
  if (!v.ok) throw new Error(`Refusing to proxy via Jina Reader: ${v.error}`);

  const response = await fetch(JINA_READER_PREFIX + v.href, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // Not a JSON error body — fall through to the generic error below.
    }

    if (data && (data.name === 'AbuseAlleviationError' || data.status === 40305)) {
      const match = typeof data.message === 'string' ? data.message.match(BLOCKED_UNTIL_RE) : null;
      const blockedUntil = match ? new Date(match[1]) : null;
      throw new JinaAbuseBlockError(
        data.message || `Jina Reader abuse-block (HTTP ${response.status}) for ${articleUrl}`,
        blockedUntil && !isNaN(blockedUntil) ? blockedUntil : null
      );
    }

    throw new Error(`Jina Reader HTTP ${response.status} for ${articleUrl}`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error(`Jina Reader response exceeded ${MAX_BYTES} bytes for ${articleUrl}`);
    }
    chunks.push(value);
  }
  const markdown = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');

  return extractFromJinaMarkdown(markdown);
}

/**
 * Perplexity's Jina Reader dump wraps the real article in nav chrome (top)
 * and a "Discover more" related-articles rail + cookie banner (bottom). The
 * real title is the first Markdown H2 (`## `); the real body runs from there
 * up to whichever trailing marker appears first. Tuned against a live sample
 * (see safe-fetch experiment, 2026-07-22) — not a general Markdown cleaner.
 */
export function extractFromJinaMarkdown(markdown) {
  const h2Match = markdown.match(/^## .+$/m);
  if (!h2Match) {
    throw new Error('Jina Reader response had no recognizable article heading');
  }

  let body = markdown.slice(h2Match.index);
  for (const marker of ['\nDiscover more', '\nAsk follow-up']) {
    const idx = body.indexOf(marker);
    if (idx !== -1) body = body.slice(0, idx);
  }

  const title = h2Match[0].replace(/^##\s*/, '').trim();

  const content = body
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^!?\[.*\]\(.*\)$/.test(t)) return false; // image/link-only lines
      if (/^\d+ sources?$/.test(t)) return false; // "2 sources" source-count labels
      if (/^[a-z0-9.+-]+$/i.test(t) && t.length < 30 && !t.includes(' ')) return false; // bare domain/favicon labels
      if (/^Published$/.test(t)) return false; // byline label with no date attached
      if (/^\d+ (minutes?|hours?|days?|weeks?|months?|years?) ago$/i.test(t)) return false; // relative byline timestamp
      return true;
    })
    // Strip inline citation tags Perplexity appends mid-sentence, e.g.
    // '...as reported by [wionews](http://...)' or bare '[tbsnews+1]' tags.
    // Must run AFTER the whole-line image/link filter above: nested
    // image+link byline lines (`[![Image](url) caption](url2)`) have
    // unbalanced brackets these regexes can't parse safely and would leave a
    // mangled fragment behind — the line filter removes those lines whole
    // first, so these regexes only ever see plain prose lines.
    .map((line) =>
      line
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '')
        .replace(/\[[a-z0-9+.-]+\+?\d*\]/gi, '')
    )
    .filter((line) => line.trim().length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Catches the case where no trailing marker was found (e.g. an unfamiliar
  // page layout) and the "content" that survived is actually a cookie-consent
  // panel long enough to clear the length check below, not the article.
  if (/permits cookies, pixels|consent is treated as implied|manage your (cookie|privacy)/i.test(content)) {
    throw new Error('Jina returned consent/boilerplate, not article');
  }

  if (content.length < 200) {
    throw new Error(`Insufficient content via Jina Reader (${content.length} chars)`);
  }

  return { title, content };
}
