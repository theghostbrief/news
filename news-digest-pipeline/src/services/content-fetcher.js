import { getArticlesNeedingFetch, markArticleFetched, markArticleFetchFailed } from '../db/index.js';
import { fetchArticleContent } from './article-fetcher.js';
import { fetchViaJinaReader } from './jina-reader.js';

let running = false;

// Domains a plain server-side fetch can never reach, verified 2026-07-22:
// perplexity.ai sits behind Cloudflare's bot challenge, which returns HTTP 403
// to any request from this server regardless of headers — no amount of
// retrying or header-tuning gets past it. Skip the doomed network call
// entirely and go straight to fetch_failed (or the Jina Reader fallback, if
// enabled) instead of wasting a request + throttle slot on a guaranteed 403.
const KNOWN_BLOCKED_DOMAINS = ['perplexity.ai'];

function isKnownBlockedDomain(hostname) {
  return KNOWN_BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// Per-hostname min gap between requests. Only perplexity.ai exists today, but
// this is keyed generically so it holds if the allowlist ever widens.
const lastRequestByHost = new Map();

async function throttleHost(hostname, minGapMs) {
  const last = lastRequestByHost.get(hostname) || 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestByHost.set(hostname, Date.now());
}

async function processFetchTick(config) {
  if (running) return;
  running = true;

  try {
    const articles = getArticlesNeedingFetch(config.contentFetchBatchSize);
    if (articles.length === 0) return;

    console.log(`[content-fetcher] Fetching content for ${articles.length} article(s)`);

    for (const article of articles) {
      const hostname = new URL(article.url).hostname;

      if (isKnownBlockedDomain(hostname)) {
        if (config.jinaReaderFallback) {
          try {
            const { title, content } = await fetchViaJinaReader(article.url);
            markArticleFetched(article.id, { title, content });
            console.log(`[content-fetcher] Fetched via Jina Reader fallback: ${article.url} (${content.length} chars)`);
          } catch (err) {
            markArticleFetchFailed(article.id, `Blocked domain, Jina Reader fallback also failed: ${err.message}`);
            console.warn(`[content-fetcher] Jina Reader fallback failed: ${article.url} — ${err.message}`);
          }
        } else {
          markArticleFetchFailed(
            article.id,
            `${hostname} blocks server-side fetches (Cloudflare bot protection) — paste content manually, or enable JINA_READER_FALLBACK`
          );
          console.log(`[content-fetcher] Skipped (known-blocked domain): ${article.url}`);
        }
        continue;
      }

      try {
        await throttleHost(hostname, config.contentFetchDomainDelayMs);

        const { title, content } = await fetchArticleContent(article.url);
        markArticleFetched(article.id, { title, content });
        console.log(`[content-fetcher] Fetched: ${article.url} (${content.length} chars)`);
      } catch (err) {
        markArticleFetchFailed(article.id, err.message);
        console.warn(`[content-fetcher] Failed: ${article.url} — ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[content-fetcher] Error processing fetch queue:', err.message);
  } finally {
    running = false;
  }
}

export function startContentFetcher(config) {
  console.log(
    `[content-fetcher] Started (interval: ${config.contentFetchIntervalMs}ms, batch: ${config.contentFetchBatchSize}, per-host delay: ${config.contentFetchDomainDelayMs}ms)`
  );

  const intervalId = setInterval(() => processFetchTick(config), config.contentFetchIntervalMs);

  // Run once immediately
  processFetchTick(config);

  return intervalId;
}
