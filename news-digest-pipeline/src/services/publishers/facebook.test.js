import { describe, it, expect, vi, afterEach } from 'vitest';
import { publishToFacebook } from './facebook.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publishToFacebook', () => {
  it('skips the POST and fails when the token health check fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Invalid OAuth access token.' } }, false, 401)
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToFacebook('bad-token', '123', 'content');

    expect(result.error).toMatch(/token health check failed/i);
    expect(result.postId).toBeUndefined();
    // Only the health-check GET happened — no POST to /feed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks the publish as failed when the response has no valid post id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'page123' })) // health check ok
      .mockResolvedValueOnce(jsonResponse({})); // feed POST — missing id
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToFacebook('good-token', '123', 'content');

    expect(result.error).toMatch(/valid post id/i);
    expect(result.postId).toBeUndefined();
  });

  it('rejects a malformed post id (not {pageId}_{postId})', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'page123' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'not-a-real-id' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToFacebook('good-token', '123', 'content');

    expect(result.error).toMatch(/valid post id/i);
  });

  it('succeeds when the health check and post both return valid data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'page123' }))
      .mockResolvedValueOnce(jsonResponse({ id: '123_456' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToFacebook('good-token', '123', 'content');

    expect(result.postId).toBe('123_456');
    expect(result.error).toBeUndefined();
  });
});
