import { describe, it, expect } from 'vitest';
import { extractFromJinaMarkdown } from './jina-reader.js';

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
