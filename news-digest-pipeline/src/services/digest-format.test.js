import { describe, it, expect } from 'vitest';
import { stripDigestMarkers } from './digest-format.js';

const SAMPLE = `👻 THE GHOST BRIEF — Daily Defense & Security Digest

<!--SEG idx=1 article_id="abc" headline="Some headline"-->
1. Commentary text here.
https://example.com/a
<!--/SEG-->

<!--SEG idx=2 article_id="def" headline="Another"-->
2. More text.
https://example.com/b
<!--/SEG-->

Ghost's read: pattern sentence.

<!--TOP3 [1,2]-->

The Ghost Brief — daily defense & security digest. Full brief: theghostbrief.com

#GhostBrief #defense #OSINT
`;

describe('stripDigestMarkers', () => {
  it('removes SEG open/close tags and the TOP3 line', () => {
    const out = stripDigestMarkers(SAMPLE);
    expect(out).not.toMatch(/<!--SEG/);
    expect(out).not.toMatch(/<!--\/SEG-->/);
    expect(out).not.toMatch(/<!--TOP3/);
  });

  it('keeps the actual commentary, links, and footer intact', () => {
    const out = stripDigestMarkers(SAMPLE);
    expect(out).toContain('1. Commentary text here.');
    expect(out).toContain('https://example.com/a');
    expect(out).toContain("Ghost's read: pattern sentence.");
    expect(out).toContain('The Ghost Brief — daily defense & security digest.');
    expect(out).toContain('#GhostBrief #defense #OSINT');
  });

  it('does not leave excess blank lines where markers were removed', () => {
    const out = stripDigestMarkers(SAMPLE);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('is a no-op on text with no markers (e.g. Krol\'s Russian scenarios)', () => {
    const plain = '#новости 1. Текст.\nhttps://example.com\n';
    expect(stripDigestMarkers(plain)).toBe(plain);
  });

  it('handles empty/null/undefined input', () => {
    expect(stripDigestMarkers('')).toBe('');
    expect(stripDigestMarkers(null)).toBe(null);
    expect(stripDigestMarkers(undefined)).toBe(undefined);
  });
});
