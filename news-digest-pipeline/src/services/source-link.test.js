import { describe, it, expect } from 'vitest';
import { attributeSource } from './source-link.js';

describe('attributeSource', () => {
  it('labels a known defense outlet by its real name', () => {
    const result = attributeSource(
      'https://www.defensenews.com/industry/techwatch/2026/07/30/us-strikes-586-billion-patriot-missile-deal-amid-rising-stockpile-concerns/'
    );
    expect(result.label).toBe('Defense News');
    expect(result.url).toBe(
      'https://www.defensenews.com/industry/techwatch/2026/07/30/us-strikes-586-billion-patriot-missile-deal-amid-rising-stockpile-concerns/'
    );
  });

  it('labels perplexity.ai/discover links as "via Perplexity" instead of guessing an outlet', () => {
    const result = attributeSource(
      'https://www.perplexity.ai/discover/top/trump-says-board-of-peace-reac-7QIkQpVRRSGaX3kqAUvFbg'
    );
    expect(result.label).toBe('via Perplexity');
    expect(result.url).toContain('perplexity.ai/discover/top/trump-says-board-of-peace-reac');
  });

  it('strips fbclid + sfnsn tracking params (real pravda.com.ua link)', () => {
    const result = attributeSource(
      'https://www.pravda.com.ua/news/2026/07/28/8046216/?fbclid=IwdGRzaATVX5JjbGNrBNVfb2V4dG4DYWVtAjExAHNydGMGYXBwX2lkDDM1MDY4NTUzMTcyOAABHjaDXCE5mDADc7JXNNRQJVuhkpJcHBngfc-GjVcHiq-5ma948DLPykPuN6Zm_aem_EjSSMqeshmweOZyoU5ohDg&sfnsn=mo'
    );
    expect(result.url).toBe('https://www.pravda.com.ua/news/2026/07/28/8046216/');
    expect(result.label).toBe('Ukrainska Pravda');
  });

  it('strips oref tracking param (real defenseone.com link)', () => {
    const result = attributeSource(
      'https://www.defenseone.com/threats/2026/07/amazon-uncovers-broad-north-korean-hacking-campaign-against-open-source-software/415110/?oref=d1-category-lander-top-story'
    );
    expect(result.url).toBe(
      'https://www.defenseone.com/threats/2026/07/amazon-uncovers-broad-north-korean-hacking-campaign-against-open-source-software/415110/'
    );
    expect(result.label).toBe('Defense One');
  });

  it('strips mibextid but keeps structurally required Facebook params', () => {
    const result = attributeSource(
      'https://www.facebook.com/story.php?story_fbid=pfbid0F4Qcs3PuwyP7DFbRGnnr9KnCHYoutGhLzKJNvd6AKdf35BToA9jvJPavSWPsQgWql&id=100069295707079&post_id=100069295707079_pfbid0F4Qcs3PuwyP7DFbRGnnr9KnCHYoutGhLzKJNvd6AKdf35BToA9jvJPavSWPsQgWql&mibextid=Nif5oz'
    );
    expect(result.url).not.toContain('mibextid');
    expect(result.url).toContain('story_fbid=pfbid0F4Qcs3PuwyP7DFbRGnnr9KnCHYoutGhLzKJNvd6AKdf35BToA9jvJPavSWPsQgWql');
    expect(result.url).toContain('post_id=');
    expect(result.label).toBe('Facebook');
  });

  it('matches subdomains against the base domain (edition.cnn.com -> CNN)', () => {
    const result = attributeSource('https://edition.cnn.com/2026/07/29/some-story');
    expect(result.label).toBe('CNN');
  });

  it('falls back to the bare hostname for unmapped domains, never invents a name', () => {
    const result = attributeSource('https://www.myjoyonline.com/the-chinese-robot-army-transforming-the-uks-retail-industry/');
    expect(result.label).toBe('myjoyonline.com');
  });

  it('leaves a clean URL with no tracking params unchanged', () => {
    const result = attributeSource('https://www.twz.com/sea/china-fires-yj-20-hypersonic-anti-ship-missile-from-smaller-destroyer');
    expect(result.url).toBe('https://www.twz.com/sea/china-fires-yj-20-hypersonic-anti-ship-missile-from-smaller-destroyer');
    expect(result.label).toBe('TWZ');
  });

  it('returns null for empty/missing input', () => {
    expect(attributeSource('')).toBeNull();
    expect(attributeSource(null)).toBeNull();
  });

  it('does not throw on a malformed URL, falls back to raw string', () => {
    const result = attributeSource('not a url');
    expect(result).toEqual({ label: 'not a url', url: 'not a url' });
  });
});
