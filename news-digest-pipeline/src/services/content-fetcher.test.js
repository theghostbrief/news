import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchArticleContentMock = vi.hoisted(() => vi.fn());
vi.mock('./article-fetcher.js', () => ({
  fetchArticleContent: fetchArticleContentMock,
}));

const sendCompilePromptMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./compile-prompt.js', () => ({
  sendCompilePrompt: sendCompilePromptMock,
}));

const fetchViaJinaReaderMock = vi.hoisted(() => vi.fn());
vi.mock('./jina-reader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchViaJinaReader: fetchViaJinaReaderMock };
});

import { initDb, insertArticle, getDigestPromptState, getDb } from '../db/index.js';
import { triggerFetch } from './content-fetcher.js';
import { JinaAbuseBlockError } from './jina-reader.js';

const config = {
  telegramBotToken: 'test-token',
  telegramChatId: '12345',
  articleThreshold: 10,
  contentFetchBatchSize: 5,
  contentFetchDomainDelayMs: 3000, // real per-host throttle value — must NOT slow this down
  jinaReaderFallback: false,
};

beforeEach(() => {
  initDb(':memory:');
  sendCompilePromptMock.mockClear();
  fetchArticleContentMock.mockReset();
  fetchArticleContentMock.mockImplementation(async (url) => ({
    title: `Title for ${url}`,
    content: `Real fetched body text for ${url}.`.repeat(5),
  }));
  fetchViaJinaReaderMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('triggerFetch — on-demand burst fetch + reactive readiness', () => {
  it('fires the compile prompt within a few seconds of the last fetch completing, with no further message', async () => {
    // Simulate a burst of 10 saved links, each a distinct host so the
    // per-host throttle (3s) never engages — this proves the prompt isn't
    // gated on that throttle, only on all 10 actually finishing.
    for (let i = 0; i < 10; i++) {
      insertArticle({
        url: `https://host-${i}.example.com/article`,
        title: '',
        content: '',
        source: 'telegram',
      });
    }

    // Single trigger call, as handleUrls() does once after saving a batch.
    triggerFetch(config);

    // Debounce is 500ms; give the whole debounced pass a generous but still
    // "a few seconds" window to finish fetching all 10 and react.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(fetchArticleContentMock).toHaveBeenCalledTimes(10);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);
    expect(sendCompilePromptMock).toHaveBeenCalledWith(config, 10);
    expect(getDigestPromptState().pending).toBe(1);
  }, 10000);

  it('collapses a burst of triggerFetch() calls into a single fetch pass (debounced)', async () => {
    for (let i = 0; i < 3; i++) {
      insertArticle({
        url: `https://burst-${i}.example.com/article`,
        title: '',
        content: '',
        source: 'telegram',
      });
      triggerFetch(config); // called once per save, like handleUrls would in a loop
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(fetchArticleContentMock).toHaveBeenCalledTimes(3);
  }, 10000);
});

describe('Jina abuse-block retry (perplexity.ai, jinaReaderFallback: true)', () => {
  const jinaConfig = { ...config, jinaReaderFallback: true };

  function getArticleRow(url) {
    return getDb().prepare('SELECT * FROM articles WHERE url = ?').get(url);
  }

  it('schedules a retry (not a permanent failure) with retry_after derived from blockedUntil + buffer', async () => {
    insertArticle({ url: 'https://www.perplexity.ai/discover/top/x', title: '', content: '', source: 'telegram' });
    const blockedUntil = new Date(Date.now() + 10 * 60 * 1000); // 10 min out
    fetchViaJinaReaderMock.mockRejectedValueOnce(new JinaAbuseBlockError('blocked', blockedUntil));

    triggerFetch(jinaConfig);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = getArticleRow('https://www.perplexity.ai/discover/top/x');
    expect(row.status).toBe('retry_scheduled');
    expect(row.retry_count).toBe(1);
    const retryAfterMs = new Date(row.retry_after).getTime();
    // Expect blockedUntil + ~2min buffer, generous tolerance for test timing.
    expect(retryAfterMs).toBeGreaterThan(blockedUntil.getTime() + 60 * 1000);
    expect(retryAfterMs).toBeLessThan(blockedUntil.getTime() + 3 * 60 * 1000);
  }, 10000);

  it('defaults to a ~40min backoff when blockedUntil did not parse', async () => {
    insertArticle({ url: 'https://www.perplexity.ai/discover/top/y', title: '', content: '', source: 'telegram' });
    fetchViaJinaReaderMock.mockRejectedValueOnce(new JinaAbuseBlockError('blocked, no timestamp', null));

    triggerFetch(jinaConfig);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = getArticleRow('https://www.perplexity.ai/discover/top/y');
    expect(row.status).toBe('retry_scheduled');
    const waitMs = new Date(row.retry_after).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(35 * 60 * 1000);
    expect(waitMs).toBeLessThan(45 * 60 * 1000);
  }, 10000);

  it('caps at 3 attempts, then permanently fails instead of scheduling a 4th retry', async () => {
    const { id } = insertArticle({ url: 'https://www.perplexity.ai/discover/top/z', title: '', content: '', source: 'telegram' });
    // Seed as if all 3 allowed retries already happened — this failure is the 4th.
    getDb().prepare(`UPDATE articles SET status = 'retry_scheduled', retry_count = 3, retry_after = datetime('now', '-1 minute') WHERE id = ?`).run(id);
    fetchViaJinaReaderMock.mockRejectedValueOnce(new JinaAbuseBlockError('blocked again', new Date(Date.now() + 5 * 60 * 1000)));

    triggerFetch(jinaConfig);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = getArticleRow('https://www.perplexity.ai/discover/top/z');
    expect(row.status).toBe('fetch_failed');
    expect(row.fetch_error).toMatch(/retries exhausted/);
  }, 10000);

  it('a non-abuse Jina failure still fails permanently, unchanged', async () => {
    insertArticle({ url: 'https://www.perplexity.ai/discover/top/w', title: '', content: '', source: 'telegram' });
    fetchViaJinaReaderMock.mockRejectedValueOnce(new Error('Jina Reader HTTP 500 for x'));

    triggerFetch(jinaConfig);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = getArticleRow('https://www.perplexity.ai/discover/top/w');
    expect(row.status).toBe('fetch_failed');
    expect(row.fetch_error).toMatch(/Jina Reader fallback also failed/);
  }, 10000);

  it('retries a due retry_scheduled article on the next fetch pass and clears retry fields on success', async () => {
    const { id } = insertArticle({ url: 'https://www.perplexity.ai/discover/top/v', title: '', content: '', source: 'telegram' });
    // Seed retry_after in the SAME format the real write path produces
    // (ISO8601 via toISOString(), computeAbuseRetryAfter/markArticleRetryScheduled)
    // — NOT SQLite's own datetime('now', ...) format. Using the SQLite-native
    // format here previously masked a real bug: a bare string comparison
    // between an ISO8601 value ("...T...Z") and datetime('now')'s
    // space-separated output is never true regardless of actual time, so a
    // due retry never actually fired (caught live 2026-07-28). This seed
    // format is what makes this test exercise that comparison for real.
    const pastRetryAfter = new Date(Date.now() - 60 * 1000).toISOString();
    getDb().prepare(`UPDATE articles SET status = 'retry_scheduled', retry_count = 1, retry_after = ? WHERE id = ?`).run(pastRetryAfter, id);
    fetchViaJinaReaderMock.mockResolvedValueOnce({ title: 'Recovered', content: 'x'.repeat(300) });

    triggerFetch(jinaConfig);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const row = getArticleRow('https://www.perplexity.ai/discover/top/v');
    expect(row.status).toBe('new');
    expect(row.retry_count).toBe(0);
    expect(row.retry_after).toBeNull();
  }, 10000);
});
