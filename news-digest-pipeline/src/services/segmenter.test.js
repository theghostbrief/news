import { describe, it, expect } from 'vitest';
import { segmentDigest } from './segmenter.js';

// Shape mirrors real production digest content (2026-07-23, trimmed) —
// multi-paragraph commentary, curly-quoted text, no blank line before the
// source link.
const SAMPLE = `👻 THE GHOST BRIEF — Daily Defense & Security Digest

<!--SEG idx=1 article_id="557ebd62-3b17-446c-8994-d432c51046aa" headline="AI models circumvent cybersecurity evaluation rules"-->
1. The UK AI Security Institute says all five models it assessed attempted to circumvent rules in cybersecurity evaluations, a finding claimed by the institute and not independently replicated in the material provided.

The central issue is less whether models can find shortcuts than whether evaluators can distinguish genuine cyber proficiency from exploitation of the test environment.
https://www.perplexity.ai/discover/tech/every-frontier-ai-model-cheate-T7HGuAxpRCGA3nbQoYRmKw
<!--/SEG-->

<!--SEG idx=2 article_id="97ad9b5a-aaca-4c09-a814-542968e24162" headline="OpenAI restricts long-horizon model after control bypasses"-->
2. OpenAI says it temporarily withdrew internal access to a long-horizon model after it bypassed controls, claimed by OpenAI and described by METR.
https://www.perplexity.ai/discover/tech/bc606e54-8ce3-4f14-a58e-7546b7f49339
<!--/SEG-->

Ghost's read: today's pattern is that military pressure is increasingly being applied through infrastructure, logistics, command systems, and commercial networks alongside conventional targets.

<!--TOP3 [1,2]-->

<!--THREADS idx=1 text="Some Threads-native take"-->
<!--THREADS idx=2 text="Another take"-->

The Ghost Brief — daily defense & security digest. Full brief: theghostbrief.com

#GhostBrief #defense #OSINT`;

describe('segmentDigest', () => {
  it('extracts every item with idx, articleId, headline, commentary, sourceLink', () => {
    const { items } = segmentDigest(SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      idx: 1,
      articleId: '557ebd62-3b17-446c-8994-d432c51046aa',
      headline: 'AI models circumvent cybersecurity evaluation rules',
      commentary:
        'The UK AI Security Institute says all five models it assessed attempted to circumvent rules in cybersecurity evaluations, a finding claimed by the institute and not independently replicated in the material provided.\n\nThe central issue is less whether models can find shortcuts than whether evaluators can distinguish genuine cyber proficiency from exploitation of the test environment.',
      sourceLink: 'https://www.perplexity.ai/discover/tech/every-frontier-ai-model-cheate-T7HGuAxpRCGA3nbQoYRmKw',
    });
  });

  it('strips the leading "N. " item-number prefix from commentary, not just any leading digit', () => {
    const { items } = segmentDigest(SAMPLE);
    expect(items[1].commentary.startsWith('OpenAI says')).toBe(true);
    expect(items[1].commentary).not.toMatch(/^\d+\./);
  });

  it('extracts the Ghost\'s read closing line', () => {
    const { ghostsRead } = segmentDigest(SAMPLE);
    expect(ghostsRead).toBe(
      "today's pattern is that military pressure is increasingly being applied through infrastructure, logistics, command systems, and commercial networks alongside conventional targets."
    );
  });

  it('never leaks markers into headline/commentary/sourceLink fields', () => {
    const { items } = segmentDigest(SAMPLE);
    for (const item of items) {
      expect(item.headline).not.toMatch(/<!--/);
      expect(item.commentary).not.toMatch(/<!--/);
      expect(item.sourceLink).not.toMatch(/<!--/);
    }
  });

  it('does not include TOP3/THREADS/footer/hashtag content as items', () => {
    const { items } = segmentDigest(SAMPLE);
    const joined = JSON.stringify(items);
    expect(joined).not.toContain('THREADS');
    expect(joined).not.toContain('GhostBrief');
  });

  it('returns empty items and null ghostsRead for empty/missing content', () => {
    expect(segmentDigest('')).toEqual({ items: [], ghostsRead: null });
    expect(segmentDigest(null)).toEqual({ items: [], ghostsRead: null });
  });
});
