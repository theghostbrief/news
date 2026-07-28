import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  parseTop3Items,
  trimToThreadsLimit,
  formatItemPost,
  formatClosingReply,
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

describe('formatItemPost / formatClosingReply', () => {
  it('falls back to headline + commentary when threadsText is absent', () => {
    const item = { headline: 'Headline here', commentary: 'Commentary text.', threadsText: null };
    const post = formatItemPost(item);
    expect(post).toBe('Headline here\n\nCommentary text.');
  });

  it('prefers the short threadsText take over the full commentary when present', () => {
    const item = {
      headline: 'Headline here',
      commentary: 'The full, much longer digest commentary paragraph that should NOT be used.',
      threadsText: 'Short Threads-native take.',
    };
    const post = formatItemPost(item);
    expect(post).toBe('Headline here\n\nShort Threads-native take.');
  });

  it('builds the closing reply as "<linkText> <link>"', () => {
    expect(formatClosingReply('t.me/theghostbrief', 'Full brief:')).toBe('Full brief: t.me/theghostbrief');
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

  // Each post is now create -> poll(status) -> publish = 3 fetch calls.
  const okPoll = () => jsonResponse({ status: 'FINISHED' });

  it('publishes the full 4-post chain and returns all 4 ids in order', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p1' })) // lead
      .mockResolvedValueOnce(jsonResponse({ id: 'c2' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p2' })) // reply1
      .mockResolvedValueOnce(jsonResponse({ id: 'c3' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p3' })) // reply2
      .mockResolvedValueOnce(jsonResponse({ id: 'c4' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p4' })); // closing
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(12);

    // Each reply after the first must reply_to_id the previous post, chained
    // sequentially (not all replying to the lead).
    const reply1CreateBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(reply1CreateBody.reply_to_id).toBe('p1');
    const reply2CreateBody = JSON.parse(fetchMock.mock.calls[6][1].body);
    expect(reply2CreateBody.reply_to_id).toBe('p2');
    const closingCreateBody = JSON.parse(fetchMock.mock.calls[9][1].body);
    expect(closingCreateBody.reply_to_id).toBe('p3');
    expect(closingCreateBody.text).toBe('Full brief: https://theghostbrief.com');
  });

  it('stops at the first failure with no orphaned replies attempted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })).mockResolvedValueOnce(okPoll()).mockResolvedValueOnce(jsonResponse({ id: 'p1' })) // lead ok
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limited' } }, false, 429)); // reply1 create fails
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual(['p1']);
    expect(result.failedAt).toBe('reply1');
    expect(result.error).toMatch(/Rate limited/);
    // 4 calls happened: lead create+poll+publish, then reply1's failed create.
    // reply1's poll/publish and reply2/closing never fire — no orphaned replies.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops the chain when a container status poll reports ERROR, without ever calling publish for it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // lead create ok
      .mockResolvedValueOnce(jsonResponse({ status: 'ERROR', error_message: 'UNKNOWN' })); // lead poll -> ERROR
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, FAST_POLL);

    expect(result.threadIds).toEqual([]);
    expect(result.failedAt).toBe('lead');
    expect(result.error).toMatch(/status ERROR/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // create + 1 poll, publish never called
  });

  it('stops the chain when a container never reaches FINISHED before the poll attempt budget runs out', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'c1' })) // lead create ok
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'IN_PROGRESS' })); // exhausts a 2-attempt budget
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishThreadsChain(digest, config, { intervalMs: 0, maxAttempts: 2 });

    expect(result.threadIds).toEqual([]);
    expect(result.failedAt).toBe('lead');
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
