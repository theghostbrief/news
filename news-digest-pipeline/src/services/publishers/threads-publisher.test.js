import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  parseTop3Items,
  trimToThreadsLimit,
  formatItemPost,
  resolveCanonicalLink,
  publishThreadsChain,
  pollContainerStatus,
} from './threads-publisher.js';

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

// Same as SAMPLE_CONTENT but with no <!--THREADS--> markers at all — models
// old digests assembled before assembly_prompt.md §5 existed.
const SAMPLE_CONTENT_NO_THREADS = SAMPLE_CONTENT.replace(
  /<!--THREADS idx=\d+ text="[^"]*"-->\n?/g,
  ''
);

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseTop3Items', () => {
  it('returns the 3 SEG items in TOP3 array order (not idx-sorted)', () => {
    const items = parseTop3Items(SAMPLE_CONTENT);

    expect(items.map((i) => i.idx)).toEqual([3, 1, 2]);
    expect(items[0].articleId).toBe('e5f6');
    expect(items[0].headline).toBe('Border unit reports contested skirmish');
    expect(items[0].commentary).toMatch(/^Both sides report a skirmish/);
    expect(items[0].link).toBe('https://example.com/article-e5f6');
  });

  it('picks up the <!--THREADS--> short take per item when present, and is null when absent', () => {
    const items = parseTop3Items(SAMPLE_CONTENT);

    // idx=3 -> items[0], idx=1 -> items[1] both have a THREADS line in SAMPLE_CONTENT.
    expect(items[0].threadsText).toBe('Both sides report a border skirmish — unverified, casualty figures diverge sharply between the two accounts.');
    expect(items[1].threadsText).toMatch(/^Another 'on schedule' release/);
    // idx=2 -> items[2] has no THREADS line in the fixture.
    expect(items[2].threadsText).toBeNull();
  });

  it('leaves threadsText null for every item on a digest assembled before THREADS existed', () => {
    const items = parseTop3Items(SAMPLE_CONTENT_NO_THREADS);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.threadsText === null)).toBe(true);
  });

  it('returns [] when the TOP3 marker is missing', () => {
    expect(parseTop3Items('no markers here')).toEqual([]);
  });

  it('returns [] when a referenced idx has no matching SEG block', () => {
    const broken = SAMPLE_CONTENT.replace('<!--TOP3 [3,1,2]-->', '<!--TOP3 [3,1,9]-->');
    expect(parseTop3Items(broken)).toEqual([]);
  });

  it('returns [] for empty/missing content', () => {
    expect(parseTop3Items('')).toEqual([]);
    expect(parseTop3Items(null)).toEqual([]);
  });
});

describe('trimToThreadsLimit', () => {
  it('leaves short text untouched', () => {
    expect(trimToThreadsLimit('short text')).toBe('short text');
  });

  it('trims long text at a word boundary and appends an ellipsis, staying within the limit', () => {
    const long = 'word '.repeat(200).trim(); // 999 chars
    const trimmed = trimToThreadsLimit(long, 500);

    expect(trimmed.length).toBeLessThanOrEqual(500);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(trimmed.endsWith(' …')).toBe(false); // no dangling space before the ellipsis
  });
});

describe('formatItemPost', () => {
  it('falls back to headline + commentary when threadsText is absent, with the link appended', () => {
    const item = { headline: 'Headline here', commentary: 'Commentary text.', threadsText: null };
    const post = formatItemPost(item, 't.me/theghostbrief', 'Full brief:');
    expect(post).toBe('Headline here\n\nCommentary text.\n\nFull brief: t.me/theghostbrief');
  });

  it('prefers the short threadsText take over the full commentary when present', () => {
    const item = {
      headline: 'Headline here',
      commentary: 'The full, much longer digest commentary paragraph that should NOT be used.',
      threadsText: 'Short Threads-native take.',
    };
    const post = formatItemPost(item, 't.me/theghostbrief', 'Full brief:');
    expect(post).toBe('Headline here\n\nShort Threads-native take.\n\nFull brief: t.me/theghostbrief');
  });

  it('omits the link itself (keeps just the label) when no canonical link is configured', () => {
    const item = { headline: 'Headline here', commentary: 'Commentary text.', threadsText: null };
    const post = formatItemPost(item, '', 'Full brief:');
    expect(post).toBe('Headline here\n\nCommentary text.\n\nFull brief:');
  });

  it('never truncates the link, even when the headline+body would otherwise overflow the limit', () => {
    const longBody = 'word '.repeat(200).trim(); // way over the post limit on its own
    const item = { headline: 'Headline', commentary: longBody, threadsText: null };
    const post = formatItemPost(item, 't.me/theghostbrief', 'Full brief:');

    expect(post.length).toBeLessThanOrEqual(500);
    expect(post.endsWith('Full brief: t.me/theghostbrief')).toBe(true);
    expect(post).toContain('…'); // the body portion, not the link, absorbed the trim
  });
});

describe('resolveCanonicalLink priority', () => {
  it('prefers THREADS_LINK_URL override', () => {
    expect(resolveCanonicalLink({ threadsLinkUrl: 'https://override.example', siteUrl: 'https://site.example' }))
      .toBe('https://override.example');
  });

  it('falls back to a future site URL when no override is set', () => {
    expect(resolveCanonicalLink({ threadsLinkUrl: '', siteUrl: 'https://site.example' }))
      .toBe('https://site.example');
  });

  it('falls back to the Telegram channel link when nothing else is configured', () => {
    expect(resolveCanonicalLink({ threadsLinkUrl: '', siteUrl: '' })).toBe('t.me/theghostbrief');
  });
});

describe('publishThreadsChain', () => {
  const config = {
    threadsUserId: 'user123',
    threadsAccessToken: 'token-abc',
    threadsLinkText: 'Full brief:',
    threadsLinkUrl: 'https://theghostbrief.com',
  };
  const digest = { id: 'd1', content: SAMPLE_CONTENT };

  // Each post is create -> poll(status) -> publish = 3 fetch calls.
  const okPoll = () => jsonResponse({ status: 'FINISHED' });

  it('publishes all 3 items as standalone top-level posts, each carrying the link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p1' })) // item1
      .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p2' })) // item2
      .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p3' })); // item3
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual(['p1', 'p2', 'p3']);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(9);

    // No post replies to another — every create body must be reply_to_id-free.
    const item1CreateBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const item2CreateBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    const item3CreateBody = JSON.parse(fetchMock.mock.calls[6][1].body);
    expect(item1CreateBody.reply_to_id).toBeUndefined();
    expect(item2CreateBody.reply_to_id).toBeUndefined();
    expect(item3CreateBody.reply_to_id).toBeUndefined();

    // Every post, not just a dedicated closing one, ends with the link.
    expect(item1CreateBody.text.endsWith('Full brief: https://theghostbrief.com')).toBe(true);
    expect(item2CreateBody.text.endsWith('Full brief: https://theghostbrief.com')).toBe(true);
    expect(item3CreateBody.text.endsWith('Full brief: https://theghostbrief.com')).toBe(true);
  });

  it('stops at the first failure and returns only what actually published', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p1' })) // item1 ok
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limited' } }, false, 429)); // item2 create fails
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual(['p1']);
    expect(result.failedAt).toBe('item2');
    expect(result.error).toMatch(/Rate limited/);
    // 4 calls happened: item1 create+poll+publish, then item2's failed create.
    // item2's poll/publish and item3 never fire.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops when a container status poll reports ERROR, without ever calling publish for it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // item1 create ok
      .mockResolvedValueOnce(jsonResponse({ status: 'ERROR', error_message: 'UNKNOWN' })); // item1 poll -> ERROR
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/status ERROR/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // create + 1 poll, publish never called
  });

  it('stops when a container never reaches FINISHED before the poll attempt budget runs out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // item1 create ok
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' })); // exhausts a 2-attempt budget
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, { intervalMs: 0, maxAttempts: 2 });

    expect(result.threadIds).toEqual([]);
    expect(result.failedAt).toBe('item1');
    expect(result.error).toMatch(/did not reach FINISHED/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // create + 2 polls, publish never called
  });

  it('fails fast without configured credentials, no network calls made', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, { threadsUserId: '', threadsAccessToken: '' });

    expect(result.threadIds).toEqual([]);
    expect(result.error).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without attempting any post when the digest has no full TOP3 set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain({ id: 'd2', content: 'no markers' }, config);

    expect(result.threadIds).toEqual([]);
    expect(result.error).toMatch(/TOP3/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('resuming a retried run (threads_thread_ids)', () => {
    it('skips already-published items and only posts the remaining ones', async () => {
      const retryDigest = { id: 'd1', content: SAMPLE_CONTENT, threads_thread_ids: JSON.stringify(['p1']) };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p2' })) // item2
        .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p3' })); // item3
      vi.stubGlobal('fetch', fetchMock);

      const result = await publishThreadsChain(retryDigest, config, FAST_POLL);

      expect(result.threadIds).toEqual(['p1', 'p2', 'p3']);
      expect(result.error).toBeUndefined();
      // Only 6 calls (2 items), not 9 — item1 was never re-attempted.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('is a no-op returning the existing ids when every item was already published', async () => {
      const retryDigest = { id: 'd1', content: SAMPLE_CONTENT, threads_thread_ids: JSON.stringify(['p1', 'p2', 'p3']) };
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await publishThreadsChain(retryDigest, config, FAST_POLL);

      expect(result.threadIds).toEqual(['p1', 'p2', 'p3']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats missing or malformed threads_thread_ids as a fresh start, not a crash', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p1' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p2' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p3' }));
      vi.stubGlobal('fetch', fetchMock);

      const malformedDigest = { id: 'd1', content: SAMPLE_CONTENT, threads_thread_ids: 'not valid json' };
      const result = await publishThreadsChain(malformedDigest, config, FAST_POLL);

      expect(result.threadIds).toEqual(['p1', 'p2', 'p3']);
      expect(fetchMock).toHaveBeenCalledTimes(9);
    });
  });
});

describe('pollContainerStatus', () => {
  it('returns ready:true immediately when the container is already FINISHED', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ status: 'FINISHED' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollContainerStatus('token', 'c1', 'lead', FAST_POLL);

    expect(result.ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through IN_PROGRESS until FINISHED', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'FINISHED' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollContainerStatus('token', 'c1', 'lead', FAST_POLL);

    expect(result.ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on EXPIRED without exhausting the attempt budget', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ status: 'EXPIRED' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollContainerStatus('token', 'c1', 'lead', FAST_POLL);

    expect(result.error).toMatch(/status EXPIRED/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a readable error on a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollContainerStatus('token', 'c1', 'lead', FAST_POLL);

    expect(result.error).toMatch(/network error/i);
  });
});
