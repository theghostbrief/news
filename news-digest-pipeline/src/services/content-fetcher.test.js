import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchArticleContentMock = vi.hoisted(() => vi.fn());
vi.mock('./article-fetcher.js', () => ({
  fetchArticleContent: fetchArticleContentMock,
}));

const sendCompilePromptMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./compile-prompt.js', () => ({
  sendCompilePrompt: sendCompilePromptMock,
}));

import { initDb, insertArticle, getDigestPromptState } from '../db/index.js';
import { triggerFetch } from './content-fetcher.js';

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
