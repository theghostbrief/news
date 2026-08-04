import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { initDb, createDigest, updateDigest, getDigest } from '../db/index.js';
import {
  extractConfidenceMarker,
  renderTop3Card,
  makeTop3Cards,
  ensureTop3CardUrls,
  CARD_SIZE,
} from './card-generator.js';

const SAMPLE_CONTENT = `👻 THE GHOST BRIEF — Daily Defense & Security Digest

<!--SEG idx=1 article_id="a1b2" headline="Delivery delay reframed as on schedule"-->
1. Another "delivered ahead of schedule" press release. The manufacturer says unit costs are "stabilizing" — unverified.
https://example.com/article-a1b2
<!--/SEG-->

<!--SEG idx=2 article_id="c3d4" headline="Strike claims dispute infrastructure target"-->
2. Moscow claims the strike hit only military infrastructure — claimed by the Ministry of Defense, unverified by independent imagery.
https://example.com/article-c3d4
<!--/SEG-->

<!--SEG idx=3 article_id="e5f6" headline="Independent imagery confirms strike on rail hub"-->
3. Satellite imagery confirms visible damage to the rail switching yard. Confirmed: two tracks are out of service.
https://example.com/article-e5f6
<!--/SEG-->

Ghost's read: today's throughline is two governments describing the same week differently.

<!--TOP3 [1,2,3]-->

The Ghost Brief — daily defense & security digest. Full brief: theghostbrief.com
`;

let tmpDir;

beforeEach(async () => {
  initDb(':memory:');
  tmpDir = await mkdtemp(path.join(tmpdir(), 'ghostbrief-cards-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('extractConfidenceMarker', () => {
  it('detects a bare "confirmed" marker', () => {
    expect(extractConfidenceMarker('Confirmed: two tracks are out of service.')).toEqual({
      tone: 'confirmed',
      label: 'CONFIRMED',
    });
  });

  it('detects "claimed by <side>", strips a leading "the", and upper-cases the side', () => {
    expect(extractConfidenceMarker('claimed by the Ministry of Defense, unverified by imagery')).toEqual({
      tone: 'claimed',
      label: 'CLAIMED BY MINISTRY OF DEFENSE',
    });
  });

  it('detects a bare "unverified" marker', () => {
    expect(extractConfidenceMarker('unit costs are stabilizing — unverified')).toEqual({
      tone: 'unverified',
      label: 'UNVERIFIED',
    });
  });

  it('picks the leftmost marker when multiple appear in the same text', () => {
    // "unverified" appears before "claimed by" here — leftmost wins.
    const text = 'unverified reports say the strike, later claimed by Moscow, hit a depot.';
    expect(extractConfidenceMarker(text)?.tone).toBe('unverified');
  });

  it('returns null when no confidence vocabulary is present', () => {
    expect(extractConfidenceMarker('A quiet week on the front.')).toBeNull();
  });

  it('returns null for empty/missing text', () => {
    expect(extractConfidenceMarker('')).toBeNull();
    expect(extractConfidenceMarker(null)).toBeNull();
  });
});

describe('renderTop3Card', () => {
  it('renders a 1080x1080 PNG', async () => {
    const buffer = await renderTop3Card({ headline: 'Test headline', confidenceText: 'confirmed' });
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(CARD_SIZE);
    expect(meta.height).toBe(CARD_SIZE);
  });

  it('renders a long headline without throwing (auto-shrink path)', async () => {
    const headline = 'NATO members agree to accelerate air-defense interceptor production amid stockpile concerns raised by multiple member states this week';
    const buffer = await renderTop3Card({ headline, confidenceText: 'claimed by NATO officials' });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(CARD_SIZE);
  });
});

describe('makeTop3Cards', () => {
  it('writes one PNG per TOP3 item, named by idx', async () => {
    const results = await makeTop3Cards(SAMPLE_CONTENT, tmpDir);

    expect(results.map((r) => r.idx)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.articleId)).toEqual(['a1b2', 'c3d4', 'e5f6']);

    const files = await readdir(tmpDir);
    expect(files.sort()).toEqual(['top-1.png', 'top-2.png', 'top-3.png']);
  });

  it('returns [] when the digest has no full TOP3 set, writing nothing', async () => {
    const results = await makeTop3Cards('no markers here', tmpDir);
    expect(results).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
  });
});

describe('ensureTop3CardUrls', () => {
  it('returns [] and touches nothing when PUBLIC_MEDIA_BASE_URL is not configured', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    updateDigest(id, { content: SAMPLE_CONTENT });
    const digest = getDigest(id);

    const result = await ensureTop3CardUrls(digest, { publicMediaBaseUrl: '' }, { cardsDataDir: tmpDir });

    expect(result).toEqual([]);
    expect(await readdir(tmpDir)).toEqual([]);
    expect(getDigest(id).cards_json).toBeNull();
  });

  it('renders, builds public URLs, and persists cards_json on first call', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    updateDigest(id, { content: SAMPLE_CONTENT });
    const digest = getDigest(id);

    const result = await ensureTop3CardUrls(
      digest,
      { publicMediaBaseUrl: 'https://theghostbrief.com/' }, // trailing slash must not double up
      { cardsDataDir: tmpDir },
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      idx: 1,
      articleId: 'a1b2',
      url: `https://theghostbrief.com/media/cards/${id}/top-1.png`,
    });

    const persisted = JSON.parse(getDigest(id).cards_json);
    expect(persisted).toEqual(result);
  });

  it('reuses existing cards_json on a second call instead of re-rendering', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    const existing = [{ idx: 1, articleId: 'a1b2', url: 'https://theghostbrief.com/media/cards/x/top-1.png' }];
    updateDigest(id, { content: SAMPLE_CONTENT, cards_json: JSON.stringify(existing) });
    const digest = getDigest(id);

    const result = await ensureTop3CardUrls(digest, { publicMediaBaseUrl: 'https://theghostbrief.com' }, { cardsDataDir: tmpDir });

    expect(result).toEqual(existing);
    expect(await readdir(tmpDir)).toEqual([]); // never wrote — proves it short-circuited
  });

  it('treats malformed cards_json as unset and regenerates', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    updateDigest(id, { content: SAMPLE_CONTENT, cards_json: 'not valid json' });
    const digest = getDigest(id);

    const result = await ensureTop3CardUrls(digest, { publicMediaBaseUrl: 'https://theghostbrief.com' }, { cardsDataDir: tmpDir });

    expect(result).toHaveLength(3);
  });

  it('returns [] without throwing when the digest has no full TOP3 set', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    updateDigest(id, { content: 'no markers here' });
    const digest = getDigest(id);

    const result = await ensureTop3CardUrls(digest, { publicMediaBaseUrl: 'https://theghostbrief.com' }, { cardsDataDir: tmpDir });

    expect(result).toEqual([]);
    expect(getDigest(id).cards_json).toBeNull();
  });

  it('returns [] instead of throwing when the output directory cannot be created', async () => {
    const id = createDigest({ date: '2026-08-04', articlesCount: 3 });
    updateDigest(id, { content: SAMPLE_CONTENT });
    const digest = getDigest(id);

    // A file, not a directory — mkdir(recursive) underneath it must fail.
    const blockedPath = path.join(tmpDir, 'blocked-file');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toFile(blockedPath);

    const result = await ensureTop3CardUrls(digest, { publicMediaBaseUrl: 'https://theghostbrief.com' }, { cardsDataDir: blockedPath });

    expect(result).toEqual([]);
  });
});
