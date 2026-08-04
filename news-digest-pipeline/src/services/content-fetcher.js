import { getArticlesNeedingFetch, markArticleFetched, markArticleFetchFailed, markArticleRetryScheduled } from '../db/index.js';
import { fetchArticleContent } from './article-fetcher.js';
import { fetchViaJinaReader, JinaAbuseBlockError } from './jina-reader.js';
import { checkReadyAndPrompt } from './queue-manager.js';
import { scheduleStatusUpdate } from './status-updater.js';

// Jina's transient domain-wide abuse block (see JinaAbuseBlockError) gets a
// minutes-scale backoff retry instead of an immediate permanent fail — distinct
// from the plain per-host throttle above, which is seconds-scale spacing
// between ordinary requests, not a failure-recovery mechanism.
const MAX_ABUSE_RETRIES = 3;
const ABUSE_RETRY_BUFFER_MS = 2 * 60 * 1000; // wait this long past Jina's own stated expiry
const DEFAULT_ABUSE_BACKOFF_MS = 40 * 60 * 1000; // used when the expiry timestamp didn't parse

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

// blockedUntil is Jina's own stated expiry (parsed from its error message) when
// available; falls back to a fixed backoff when it isn't. Either way, adds a
// small buffer so the retry lands safely after the block actually lifts.
function computeAbuseRetryAfter(blockedUntil) {
  const base = blockedUntil instanceof Date && !isNaN(blockedUntil)
    ? blockedUntil.getTime()
    : Date.now() + DEFAULT_ABUSE_BACKOFF_MS;
  return new Date(base + ABUSE_RETRY_BUFFER_MS);
}

// An on-demand trigger (article just saved) should drain far more than the
// periodic tick's small batch — the point is to fetch a just-added burst
// promptly, not trickle it out over several interval ticks. Per-host
// throttling still applies within this, so it can't hammer any single host.
const ON_DEMAND_FETCH_LIMIT = 100;
const TRIGGER_DEBOUNCE_MS = 500;
let debounceTimer = null;

/**
 * Request an immediate (short-debounced) fetch pass instead of waiting for
 * the next interval tick. Called right after an article is saved. Debounced
 * so a burst of saves (e.g. several links pasted in one message, or several
 * messages in quick succession) collapses into a single triggered pass
 * rather than one per save.
 */
export function triggerFetch(config) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    processFetchTick(config, ON_DEMAND_FETCH_LIMIT).catch((err) => {
      console.error('[content-fetcher] Triggered fetch error:', err.message);
    });
  }, TRIGGER_DEBOUNCE_MS);
}

let running = false;

async function processFetchTick(config, limit) {
  if (running) return;
  running = true;

  try {
    const articles = getArticlesNeedingFetch(limit ?? config.contentFetchBatchSize);
    if (articles.length === 0) return;

    console.log(`[content-fetcher] Fetching content for ${articles.length} article(s)`);

    for (const article of articles) {
      const hostname = new URL(article.url).hostname;

      if (isKnownBlockedDomain(hostname)) {
        if (config.jinaReaderFallback) {
          try {
            const { title, content } = await fetchViaJinaReader(article.url, config.jinaApiKey);
            markArticleFetched(article.id, { title, content });
            console.log(`[content-fetcher] Fetched via Jina Reader fallback: ${article.url} (${content.length} chars)`);
            await checkReadyAndPrompt(config);
            scheduleStatusUpdate(config);
          } catch (err) {
            if (err instanceof JinaAbuseBlockError) {
              const nextRetryCount = (article.retry_count || 0) + 1;
              if (nextRetryCount > MAX_ABUSE_RETRIES) {
                markArticleFetchFailed(
                  article.id,
                  `Blocked domain, Jina Reader abuse-block retries exhausted (${MAX_ABUSE_RETRIES}): ${err.message}`
                );
                console.warn(`[content-fetcher] Jina abuse-block retries exhausted for ${article.url} — ${err.message}`);
              } else {
                const retryAfter = computeAbuseRetryAfter(err.blockedUntil);
                markArticleRetryScheduled(article.id, {
                  retryAfter: retryAfter.toISOString(),
                  errorMessage: err.message,
                  retryCount: nextRetryCount,
                });
                console.log(`[content-fetcher] Jina abuse-block for ${article.url} — retry ${nextRetryCount}/${MAX_ABUSE_RETRIES} scheduled for ${retryAfter.toISOString()}`);
              }
            } else {
              markArticleFetchFailed(article.id, `Blocked domain, Jina Reader fallback also failed: ${err.message}`);
              console.warn(`[content-fetcher] Jina Reader fallback failed: ${article.url} — ${err.message}`);
            }
            scheduleStatusUpdate(config);
          }
        } else {
          markArticleFetchFailed(
            article.id,
            `${hostname} blocks server-side fetches (Cloudflare bot protection) — paste content manually, or enable JINA_READER_FALLBACK`
          );
          console.log(`[content-fetcher] Skipped (known-blocked domain): ${article.url}`);
          scheduleStatusUpdate(config);
        }
        continue;
      }

      try {
        await throttleHost(hostname, config.contentFetchDomainDelayMs);

        const { title, content } = await fetchArticleContent(article.url);
        markArticleFetched(article.id, { title, content });
        console.log(`[content-fetcher] Fetched: ${article.url} (${content.length} chars)`);
        // Reactive readiness check — fire the compile prompt as soon as this
        // article's content lands and crosses the threshold, instead of
        // waiting on the next queue-manager interval tick or another
        // incoming Telegram message.
        await checkReadyAndPrompt(config);
        // Live-edit the last "Saved | Ready | Fetching" reply so the user
        // watches the numbers move in real time, without sending anything.
        scheduleStatusUpdate(config);
      } catch (err) {
        markArticleFetchFailed(article.id, err.message);
        console.warn(`[content-fetcher] Failed: ${article.url} — ${err.message}`);
        // A failure still moves the article out of "Fetching" (into
        // fetch_failed) — reflect that instead of letting it silently vanish
        // from the live counts.
        scheduleStatusUpdate(config);
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
