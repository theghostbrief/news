import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { initDb, getThreadsTokenState } from '../../db/index.js';
import {
  resolveThreadsAccessToken,
  refreshThreadsAccessToken,
  maybeRefreshThreadsToken,
} from './threads-token-refresh.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

const config = { threadsAccessToken: 'env-token' };

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveThreadsAccessToken', () => {
  it('falls back to the .env token when nothing has been refreshed yet', () => {
    expect(resolveThreadsAccessToken(config)).toBe('env-token');
  });
});

describe('refreshThreadsAccessToken', () => {
  it('returns the new token + expiry on success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ access_token: 'new-token', token_type: 'bearer', expires_in: 5184000 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshThreadsAccessToken('old-token');

    expect(result.accessToken).toBe('new-token');
    expect(result.expiresInSeconds).toBe(5184000);
    expect(fetchMock.mock.calls[0][0]).toContain('access_token=old-token');
  });

  it('surfaces a readable error on an API error response (e.g. token too young to refresh)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: { message: 'The token is too new to be refreshed.' } }, false, 400)
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshThreadsAccessToken('old-token');

    expect(result.error).toMatch(/too new/i);
  });

  it('handles a non-JSON response without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<html>oops</html>' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshThreadsAccessToken('old-token');

    expect(result.error).toMatch(/unreadable/i);
  });
});

describe('maybeRefreshThreadsToken', () => {
  it('skips when nothing is configured', async () => {
    const result = await maybeRefreshThreadsToken({ threadsAccessToken: '' });
    expect(result.skipped).toBe(true);
  });

  it('refreshes and persists to DB when no expiry is known yet (first run)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ access_token: 'refreshed-1', expires_in: 5184000 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date('2026-07-27T00:00:00Z');
    const result = await maybeRefreshThreadsToken(config, now);

    expect(result.refreshed).toBe(true);
    const state = getThreadsTokenState();
    expect(state.access_token).toBe('refreshed-1');
    expect(state.last_error).toBeNull();
    expect(resolveThreadsAccessToken(config)).toBe('refreshed-1');
  });

  it('skips when the stored token is not yet within the refresh margin of expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ access_token: 'refreshed-1', expires_in: 5184000 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const now = new Date('2026-07-27T00:00:00Z');
    await maybeRefreshThreadsToken(config, now); // seeds expires_at ~60 days out

    fetchMock.mockClear();
    const nextDay = new Date('2026-07-28T00:00:00Z');
    const result = await maybeRefreshThreadsToken(config, nextDay);

    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records last_error and does not clobber the existing good token on a failed refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: { message: 'The token is too new to be refreshed.' } }, false, 400)
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await maybeRefreshThreadsToken(config, new Date('2026-07-27T00:00:00Z'));

    expect(result.error).toMatch(/too new/i);
    const state = getThreadsTokenState();
    expect(state.last_error).toMatch(/too new/i);
    expect(state.access_token).toBeNull();
    // Still resolves to the .env token — the failed refresh didn't break publishing.
    expect(resolveThreadsAccessToken(config)).toBe('env-token');
  });
});
