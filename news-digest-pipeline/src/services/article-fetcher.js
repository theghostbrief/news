import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTENT_SELECTORS = [
  'article',
  '[class*="prose"]',
  '.scrollbar-subtle',
  '.markdown',
  'main',
];

const REMOVE_SELECTORS = 'script, style, nav, header, footer, [class*="sideBarWidth"], .sidebar, aside, [role="navigation"], [role="banner"]';

/**
 * Try fetching article content with cheerio (fast, lightweight).
 * Returns { title, content } or throws on failure.
 */
async function fetchWithCheerio(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const html = await response.text();
  return extractFromHtml(html);
}

/**
 * Extract title and content from raw HTML using cheerio.
 */
function extractFromHtml(html) {
  const $ = cheerio.load(html);

  // Remove unwanted elements
  $(REMOVE_SELECTORS).remove();

  // Extract title
  let title = $('h1').first().text().trim();
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || '';
  }
  if (!title) {
    title = $('title').text().replace(/\s*[-|].*$/, '').trim();
  }

  // Extract content using selectors from the extension
  let content = '';
  for (const selector of CONTENT_SELECTORS) {
    const el = $(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 100) {
        content = text;
        break;
      }
    }
  }

  // Fallback: body text
  if (!content || content.length < 200) {
    content = $('body').text().trim();
  }

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return { title, content };
}

/**
 * Fetch article content (cheerio only).
 *
 * NOTE: this is a best-effort server-side fetch. Perplexity /page/ URLs are
 * client-rendered SPAs that cheerio usually can't read, so real content is
 * fetched by the local Mac fetcher (scripts/local-fetcher.js) which drives a
 * real Chrome via AppleScript and PATCHes the content back. The previous
 * headless-Chromium/Playwright fallback was removed (it never worked against
 * Perplexity's bot detection and bloated the server image by ~400MB).
 */
export async function fetchArticleContent(url) {
  const result = await fetchWithCheerio(url);
  if (!result.content || result.content.length < 200) {
    throw new Error(
      `Insufficient content via cheerio for ${url} (${result.content?.length || 0} chars); ` +
      `enrich via the local Mac fetcher`
    );
  }
  return result;
}
