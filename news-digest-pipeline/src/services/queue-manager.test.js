import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendCompilePromptMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./compile-prompt.js', () => ({
  sendCompilePrompt: sendCompilePromptMock,
}));

import { initDb, insertArticle, markArticleFetched, getDigestPromptState, setDigestPromptState } from '../db/index.js';
import { processQueue } from './queue-manager.js';

const config = {
  telegramBotToken: 'test-token',
  telegramChatId: '12345',
  checkIntervalMs: 60000,
  articleThreshold: 10,
};

let counter = 0;
function addArticle({ ready }) {
  counter += 1;
  const { id } = insertArticle({
    url: `https://www.perplexity.ai/discover/you/item-${counter}`,
    title: `Item ${counter}`,
    content: ready ? 'Real fetched body text.'.repeat(5) : '',
    source: 'telegram',
  });
  return id;
}

beforeEach(() => {
  initDb(':memory:');
  counter = 0;
  sendCompilePromptMock.mockClear();
});

describe('processQueue readiness prompt', () => {
  it('(a) fires the prompt exactly once when ready count first reaches 10', async () => {
    for (let i = 0; i < 10; i++) addArticle({ ready: true });

    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);
    expect(getDigestPromptState().pending).toBe(1);

    // A second tick while still pending must not re-send.
    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);
  });

  it('(b) excludes unfetched articles until content populates', async () => {
    const ids = Array.from({ length: 10 }, () => addArticle({ ready: false }));

    await processQueue(config);
    expect(sendCompilePromptMock).not.toHaveBeenCalled();

    for (const id of ids) {
      markArticleFetched(id, { title: 'Fetched', content: 'Real fetched body text.'.repeat(5) });
    }

    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);
  });

  it('(c) does not re-prompt at 15 but does at 20', async () => {
    for (let i = 0; i < 10; i++) addArticle({ ready: true });
    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);

    // "Keep adding" — clears pending; baseline (10, set when the prompt was
    // sent) is left untouched.
    setDigestPromptState({ pending: 0 });

    for (let i = 0; i < 5; i++) addArticle({ ready: true }); // ready = 15
    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1); // still just the first

    for (let i = 0; i < 5; i++) addArticle({ ready: true }); // ready = 20
    await processQueue(config);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(2);
  });

  it('never sends when Telegram is not configured', async () => {
    for (let i = 0; i < 10; i++) addArticle({ ready: true });
    await processQueue({ ...config, telegramBotToken: '' });
    expect(sendCompilePromptMock).not.toHaveBeenCalled();
  });

  it('honors a configured articleThreshold instead of a fixed 10', async () => {
    const customConfig = { ...config, articleThreshold: 5 };

    for (let i = 0; i < 4; i++) addArticle({ ready: true });
    await processQueue(customConfig);
    expect(sendCompilePromptMock).not.toHaveBeenCalled();

    addArticle({ ready: true }); // ready = 5
    await processQueue(customConfig);
    expect(sendCompilePromptMock).toHaveBeenCalledTimes(1);
    expect(sendCompilePromptMock).toHaveBeenCalledWith(customConfig, 5);
  });
});
