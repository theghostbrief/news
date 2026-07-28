import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractFromJinaMarkdown, fetchViaJinaReader, JinaAbuseBlockError } from './jina-reader.js';

// Trimmed fixture mirroring a real Jina Reader dump of a perplexity.ai/page/
// URL (captured 2026-07-22): nav chrome, then the real article (H2 title +
// body + sub-sections), then a "Discover more" related-articles rail and
// cookie-banner footer.
const SAMPLE = `[](https://www.perplexity.ai/)

New

Sign In

Share

## Ukraine unveils faster interceptor drones at Farnborough

As Russia fields growing numbers of jet-propelled Shahed attack drones capable of reaching 500 kph, Ukrainian and British-Ukrainian drone manufacturers are racing to close the speed gap, unveiling a new generation of faster interceptors at the Farnborough Airshow this week.

Published

20 hours ago

[![Image 1](https://example.com/a.png) internazionale As Russia deploys...](https://www.internazionale.it/x)

![Image 5: caption](https://pplx-res.cloudinary.com/x.jpg)

economist.com

## A New Arms Race in the Sky

SkyFall, one of Ukraine's largest drone manufacturers, revealed its P1-SUN Jetkiller on Monday at the airshow, a high-speed variant of its existing interceptor drone that has been deployed in Ukraine since late last year.

2 sources

## The Threat Driving Urgency

The push for speed reflects a shifting battlefield. About 15 to 20 percent of Russia's Shaheds now carry jet engines, up sharply over recent months, according to a senior Ukrainian air force commander cited by Reuters in April.

Discover more

[![Image 13: caption](https://example.com/b.jpg) Some other article...](https://www.perplexity.ai/page/other)

Ask follow-up

Search Computer

## Cookie Policy

We and our partners use cookies, pixels, SDKs...`;

describe('extractFromJinaMarkdown', () => {
  it('extracts the real title (first H2), skipping nav chrome above it', () => {
    const { title } = extractFromJinaMarkdown(SAMPLE);
    expect(title).toBe('Ukraine unveils faster interceptor drones at Farnborough');
  });

  it('includes the real body sections', () => {
    const { content } = extractFromJinaMarkdown(SAMPLE);
    expect(content).toContain('SkyFall, one of Ukraine');
    expect(content).toContain('The push for speed reflects a shifting battlefield');
  });

  it('excludes everything from "Discover more" onward (related-articles rail, cookie banner)', () => {
    const { content } = extractFromJinaMarkdown(SAMPLE);
    expect(content).not.toContain('Discover more');
    expect(content).not.toContain('Cookie Policy');
    expect(content).not.toContain('Some other article');
  });

  it('drops image-only and bare-domain/source-count noise lines', () => {
    const { content } = extractFromJinaMarkdown(SAMPLE);
    expect(content).not.toContain('economist.com');
    expect(content).not.toContain('2 sources');
    expect(content).not.toMatch(/^!\[/m);
  });

  it('throws when there is no H2 heading at all', () => {
    expect(() => extractFromJinaMarkdown('no headings here, just text')).toThrow(/heading/);
  });

  it('throws when the extracted body is too short', () => {
    expect(() => extractFromJinaMarkdown('## Title\n\nToo short.\n\nDiscover more\nrest')).toThrow(/Insufficient/);
  });
});

function jsonResponse(body, status) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchViaJinaReader — AbuseAlleviationError detection', () => {
  const ABUSE_BODY = {
    data: null,
    code: 403,
    name: 'AbuseAlleviationError',
    status: 40305,
    message: 'Anonymous access to domain www.perplexity.ai blocked until Tue Jul 28 2026 08:17:33 GMT+0000 (Coordinated Universal Time) due to previous abuse found on https://www.perplexity.ai/finance/AMZN: DDoS attack suspected: Too many requests',
  };

  it('throws JinaAbuseBlockError with a parsed blockedUntil date for a real AbuseAlleviationError body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(ABUSE_BODY, 403)));

    await expect(fetchViaJinaReader('https://www.perplexity.ai/discover/top/x'))
      .rejects.toBeInstanceOf(JinaAbuseBlockError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(ABUSE_BODY, 403)));
    try {
      await fetchViaJinaReader('https://www.perplexity.ai/discover/top/x');
      expect.unreachable();
    } catch (err) {
      expect(err.blockedUntil).toBeInstanceOf(Date);
      expect(err.blockedUntil.toISOString()).toBe('2026-07-28T08:17:33.000Z');
    }
  });

  it('sets blockedUntil to null when the message has no parseable timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ name: 'AbuseAlleviationError', status: 40305, message: 'blocked, no timestamp here' }, 403)
    ));

    try {
      await fetchViaJinaReader('https://www.perplexity.ai/discover/top/x');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JinaAbuseBlockError);
      expect(err.blockedUntil).toBeNull();
    }
  });

  it('throws a plain Error (not JinaAbuseBlockError) for a real 403 that is not an abuse block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ name: 'SecurityCompromiseError' }, 403)));

    await expect(fetchViaJinaReader('https://example.com/x'))
      .rejects.toThrow(/Jina Reader HTTP 403/);
  });

  it('throws a plain Error when the error body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => '<html>oops</html>' }));

    const err = await fetchViaJinaReader('https://example.com/x').catch((e) => e);
    expect(err).not.toBeInstanceOf(JinaAbuseBlockError);
    expect(err.message).toMatch(/Jina Reader HTTP 500/);
  });
});
