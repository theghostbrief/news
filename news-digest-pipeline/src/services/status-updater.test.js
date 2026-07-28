import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const editMessageTextMock = vi.hoisted(() => vi.fn().mockResolvedValue({ message_id: 1 }));
vi.mock('./telegram-api.js', () => ({
  editMessageText: editMessageTextMock,
}));

import { initDb, insertArticle, markArticleFetched, markArticleFetchFailed, markArticleRetryScheduled } from '../db/index.js';
import { formatStatusReply, recordStatusMessage, scheduleStatusUpdate } from './status-updater.js';

const config = { telegramBotToken: 'test-token' };

beforeEach(() => {
  initDb(':memory:');
  editMessageTextMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatStatusReply', () => {
  it('renders the base Saved|Ready|Fetching|Retrying line', () => {
    expect(formatStatusReply({ saved: 2, duplicates: 0, rejected: 0, readyCount: 1, fetchingCount: 1, retryingCount: 0 }))
      .toBe('Saved: 2 | Ready: 1 | Fetching: 1 | Retrying: 0');
  });

  it('shows Retrying unconditionally, same as Ready/Fetching (not gated on >0 like Duplicates/Rejected)', () => {
    expect(formatStatusReply({ saved: 1, duplicates: 0, rejected: 0, readyCount: 0, fetchingCount: 0, retryingCount: 3 }))
      .toBe('Saved: 1 | Ready: 0 | Fetching: 0 | Retrying: 3');
  });

  it('appends duplicates/rejected only when present', () => {
    expect(formatStatusReply({ saved: 1, duplicates: 2, rejected: 3, readyCount: 0, fetchingCount: 1, retryingCount: 0 }))
      .toBe('Saved: 1 | Ready: 0 | Fetching: 1 | Retrying: 0 | Duplicates: 2 | Rejected: 3');
  });
});

describe('scheduleStatusUpdate', () => {
  it('does nothing if no status message has been recorded yet', async () => {
    scheduleStatusUpdate(config);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(editMessageTextMock).not.toHaveBeenCalled();
  }, 5000);

  it('edits the recorded message with live counts once an article becomes ready', async () => {
    const { id } = insertArticle({ url: 'https://example.com/a', title: '', content: '', source: 'telegram' });
    recordStatusMessage('12345', 999, { saved: 1, duplicates: 0, rejected: 0 });

    scheduleStatusUpdate(config); // ready=0, fetching=1 right now

    markArticleFetched(id, { title: 'T', content: 'x'.repeat(50) });
    scheduleStatusUpdate(config); // second call inside the debounce window — coalesced into one edit

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(editMessageTextMock).toHaveBeenCalledTimes(1);
    expect(editMessageTextMock).toHaveBeenCalledWith('test-token', '12345', 999, 'Saved: 1 | Ready: 1 | Fetching: 0 | Retrying: 0');
  }, 5000);

  it('reflects a fetch failure by decrementing Fetching, not leaving it stale', async () => {
    const { id } = insertArticle({ url: 'https://example.com/b', title: '', content: '', source: 'telegram' });
    recordStatusMessage('12345', 1000, { saved: 1, duplicates: 0, rejected: 0 });

    markArticleFetchFailed(id, 'HTTP 500');
    scheduleStatusUpdate(config);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(editMessageTextMock).toHaveBeenCalledWith('test-token', '12345', 1000, 'Saved: 1 | Ready: 0 | Fetching: 0 | Retrying: 0');
  }, 5000);

  it('shows a Jina-blocked article as Retrying instead of vanishing from Ready/Fetching', async () => {
    const { id } = insertArticle({ url: 'https://example.com/c', title: '', content: '', source: 'telegram' });
    recordStatusMessage('12345', 1001, { saved: 1, duplicates: 0, rejected: 0 });

    markArticleRetryScheduled(id, {
      retryAfter: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
      errorMessage: 'Anonymous access to domain www.perplexity.ai blocked...',
      retryCount: 1,
    });
    scheduleStatusUpdate(config);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(editMessageTextMock).toHaveBeenCalledWith('test-token', '12345', 1001, 'Saved: 1 | Ready: 0 | Fetching: 0 | Retrying: 1');
  }, 5000);
});
