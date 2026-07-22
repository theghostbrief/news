import { validateArticleUrl } from './url-validator.js';

const JINA_READER_PREFIX = 'https://r.jina.ai/';
// Jina renders the target page server-side (their own infra, their own
// headless browser) before returning Markdown — slower than a plain fetch.
const TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;

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
 */
export async function fetchViaJinaReader(articleUrl) {
  const v = validateArticleUrl(articleUrl);
  if (!v.ok) throw new Error(`Refusing to proxy via Jina Reader: ${v.error}`);

  const response = await fetch(JINA_READER_PREFIX + v.href, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
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
      return true;
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (content.length < 200) {
    throw new Error(`Insufficient content via Jina Reader (${content.length} chars)`);
  }

  return { title, content };
}
