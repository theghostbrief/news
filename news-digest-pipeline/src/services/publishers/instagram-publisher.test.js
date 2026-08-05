import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  formatItemCaption,
  publishInstagramTop3,
  pollContainerStatus,
} from './instagram-publisher.js';

// Tests always pass intervalMs: 0 so a multi-attempt poll doesn't add real delay.
const FAST_POLL = { intervalMs: 0 };

const SAMPLE_CONTENT = `👻 THE GHOST BRIEF — Daily Defense & Security Digest

<!--SEG idx=1 article_id="a1b2" headline="Delivery delay reframed as on schedule"-->
1. Another "delivered ahead of schedule" press release, and another quiet asterisk in the annex explaining that "ahead of schedule" now means eleven months late against the original contract, not the revised one.
https://example.com/article-a1b2
<!--/SEG-->

<!--SEG idx=2 article_id="c3d4" headline="Strike claims dispute infrastructure target"-->
2. Moscow claims the strike hit only military infrastructure — claimed by the Ministry of Defense, unverified by independent imagery as of this writing.
https://example.com/article-c3d4
<!--/SEG-->

<!--SEG idx=3 article_id="e5f6" headline="Border unit reports contested skirmish"-->
3. Both sides report a skirmish near the border post — unverified, and casualty figures diverge sharply between the two accounts.
https://example.com/article-e5f6
<!--/SEG-->

Ghost's read: today's throughline is two governments describing the same week in mutually exclusive adjectives.

<!--TOP3 [3,1,2]-->

<!--THREADS idx=3 text="Both sides report a border skirmish — unverified, casualty figures diverge sharply between the two accounts."-->
<!--THREADS idx=1 text="Another 'on schedule' release quietly redefines the baseline against the revised contract, not the original one."-->

The Ghost Brief — daily defense & security digest. Full brief: theghostbrief.com
`;

const CARDS = [
  { idx: 3, articleId: 'e5f6', url: 'https://theghostbrief.com/media/cards/d1/top-3.png' },
  { idx: 1, articleId: 'a1b2', url: 'https://theghostbrief.com/media/cards/d1/top-1.png' },
  { idx: 2, articleId: 'c3d4', url: 'https://theghostbrief.com/media/cards/d1/top-2.png' },
];

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatItemCaption', () => {
  it('falls back to headline + commentary when threadsText is absent, with the link appended', () => {
    const item = { headline: 'Headline here', commentary: 'Commentary text.', threadsText: null };
    const caption = formatItemCaption(item, 't.me/theghostbrief', 'Full brief:');
    expect(caption).toBe('Headline here\n\nCommentary text.\n\nFull brief: t.me/theghostbrief');
  });

  it('prefers the short threadsText take over the full commentary when present', () => {
    const item = {
      headline: 'Headline here',
      commentary: 'The full, much longer digest commentary paragraph that should NOT be used.',
      threadsText: 'Short native take.',
    };
    const caption = formatItemCaption(item, 't.me/theghostbrief', 'Full brief:');
    expect(caption).toBe('Headline here\n\nShort native take.\n\nFull brief: t.me/theghostbrief');
  });

  it('never truncates the link, even when the headline+body would otherwise overflow the caption limit', () => {
    const longBody = 'word '.repeat(500).trim(); // way over 2200 chars on its own
    const item = { headline: 'Headline', commentary: longBody, threadsText: null };
    const caption = formatItemCaption(item, 't.me/theghostbrief', 'Full brief:');

    expect(caption.length).toBeLessThanOrEqual(2200);
    expect(caption.endsWith('Full brief: t.me/theghostbrief')).toBe(true);
    expect(caption).toContain('…');
  });
});

describe('publishInstagramTop3', () => {
  const config = {
    instagramAccountId: 'ig-user-123',
    instagramAccessToken: 'token-abc',
    instagramLinkText: 'Full brief:',
    threadsLinkUrl: 'https://theghostbrief.com',
  };
  const digestWithCards = { id: 'd1', content: SAMPLE_CONTENT, cards_json: JSON.stringify(CARDS) };

  // Each post is create -> poll(status_code) -> publish = 3 fetch calls.
  const okPoll = () => jsonResponse({ status_code: 'FINISHED' });

  it('publishes all 3 TOP3 items as feed posts, image + caption', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm1' })) // item1
      .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm2' })) // item2
      .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm3' })); // item3
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestWithCards, config, FAST_POLL);

    expect(result.mediaIds).toEqual(['m1', 'm2', 'm3']);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(9);

    // Items post in TOP3 array order [3,1,2] — first create call is idx=3.
    const item1CreateBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(item1CreateBody.image_url).toBe('https://theghostbrief.com/media/cards/d1/top-3.png');
    expect(item1CreateBody.caption).toBeTruthy();
    expect(item1CreateBody.caption.endsWith('Full brief: https://theghostbrief.com')).toBe(true);

    const item2CreateBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(item2CreateBody.image_url).toBe('https://theghostbrief.com/media/cards/d1/top-1.png');
  });

  it('fails the item (without attempting a post) when it has no matching card image, and stops there', async () => {
    // Only idx=1 has a card; idx=3 (the first item in TOP3 order) does not.
    const partialCards = [{ idx: 1, articleId: 'a1b2', url: 'https://theghostbrief.com/media/cards/d1/top-1.png' }];
    const digestPartialCards = { id: 'd1', content: SAMPLE_CONTENT, cards_json: JSON.stringify(partialCards) };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestPartialCards, config, FAST_POLL);

    expect(result.mediaIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/no card image available/);
    expect(fetchMock).not.toHaveBeenCalled(); // no network call for an item with no image
  });

  it('fails every item (no posts at all) when cards_json is empty, without blocking on network', async () => {
    const digestNoCards = { id: 'd1', content: SAMPLE_CONTENT, cards_json: '[]' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestNoCards, config, FAST_POLL);

    expect(result.mediaIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/no card image available/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops at the first API failure and returns only what actually published', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm1' })) // item1 ok
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limited' } }, false, 429)); // item2 create fails
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestWithCards, config, FAST_POLL);

    expect(result.mediaIds).toEqual(['m1']);
    expect(result.failedAt).toBe('item2');
    expect(result.error).toMatch(/Rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops when a container status poll reports ERROR, without ever calling publish for it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // item1 create ok
      .mockResolvedValueOnce(jsonResponse({ status_code: 'ERROR' })); // item1 poll -> ERROR
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestWithCards, config, FAST_POLL);

    expect(result.mediaIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/status ERROR/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // create + 1 poll, publish never called
  });

  it('stops when a container never reaches FINISHED before the poll attempt budget runs out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // item1 create ok
      .mockResolvedValueOnce(jsonResponse({ status_code: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status_code: 'IN_PROGRESS' })); // exhausts a 2-attempt budget
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestWithCards, config, { intervalMs: 0, maxAttempts: 2 });

    expect(result.mediaIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/did not reach FINISHED/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails fast without configured credentials, no network calls made', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestWithCards, { instagramAccountId: '', instagramAccessToken: '' });

    expect(result.mediaIds).toEqual([]);
    expect(result.error).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without attempting any post when the digest has no full TOP3 set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3({ id: 'd2', content: 'no markers' }, config);

    expect(result.mediaIds).toEqual([]);
    expect(result.error).toMatch(/TOP3/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resumes from instagram_media_ids, skipping items already published', async () => {
    const digestPartiallyDone = {
      ...digestWithCards,
      instagram_media_ids: JSON.stringify(['m1']),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm2' })) // item2
      .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'm3' })); // item3
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestPartiallyDone, config, FAST_POLL);

    expect(result.mediaIds).toEqual(['m1', 'm2', 'm3']);
    expect(fetchMock).toHaveBeenCalledTimes(6); // only the 2 remaining items
  });

  it('does nothing and returns the existing ids when all 3 are already published', async () => {
    const digestDone = { ...digestWithCards, instagram_media_ids: JSON.stringify(['m1', 'm2', 'm3']) };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishInstagramTop3(digestDone, config, FAST_POLL);

    expect(result.mediaIds).toEqual(['m1', 'm2', 'm3']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pollContainerStatus', () => {
  it('reads IG\'s status_code field (not Threads\' status field)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollContainerStatus('token', 'container1', 'item1', { intervalMs: 0 });

    expect(result.ready).toBe(true);
  });
});
