import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateDigestMock = vi.hoisted(() => vi.fn());
vi.mock('./digest-generator.js', () => ({
  generateDigest: generateDigestMock,
}));

import {
  initDb,
  insertArticle,
  createDigest,
  assignArticlesToDigest,
  getReadyArticleCount,
  getDigestPromptState,
  setDigestPromptState,
} from '../db/index.js';
import { handleTelegramUpdate } from './telegram-bot.js';

const config = {
  telegramBotToken: 'test-token',
  telegramChatId: '12345',
  maxArticlesPerDigest: 17,
};

let counter = 0;
function readyArticle() {
  counter += 1;
  const { id } = insertArticle({
    url: `https://www.perplexity.ai/discover/you/item-${counter}`,
    title: `Item ${counter}`,
    content: 'Real fetched body text.'.repeat(5),
    source: 'telegram',
  });
  return id;
}

function compileCallback() {
  return { callback_query: { id: 'cb1', data: 'compile_digest', message: { chat: { id: 12345 } } } };
}

beforeEach(() => {
  initDb(':memory:');
  counter = 0;
  generateDigestMock.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleCompileDigest via the Compile-digest callback', () => {
  it('(d) resets the prompt baseline to the post-compile ready count', async () => {
    // 12 ready articles accumulated; a prompt was already sent at 10 (pending=1).
    const ids = Array.from({ length: 12 }, () => readyArticle());
    setDigestPromptState({ pending: 1, baseline: 10 });

    generateDigestMock.mockImplementation(async (db, articles) => {
      const digestId = createDigest({ date: '2026-07-25', articlesCount: articles.length });
      assignArticlesToDigest(articles.map((a) => a.id), digestId);
      return digestId;
    });

    await handleTelegramUpdate(compileCallback(), config);

    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(generateDigestMock.mock.calls[0][1]).toHaveLength(12);

    const state = getDigestPromptState();
    expect(state.pending).toBe(0);
    // All 12 were compiled (assigned to the digest, status -> used), so ready
    // count is back to 0 — the baseline must follow it down, not stay at 10.
    expect(getReadyArticleCount()).toBe(0);
    expect(state.baseline).toBe(0);
  });

  it('never compiles an empty digest', async () => {
    // No ready articles at all.
    setDigestPromptState({ pending: 1, baseline: 10 });

    await handleTelegramUpdate(compileCallback(), config);

    expect(generateDigestMock).not.toHaveBeenCalled();
    expect(getDigestPromptState().pending).toBe(0);
  });
});
