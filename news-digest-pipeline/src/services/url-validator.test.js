import { describe, it, expect, afterEach } from 'vitest';
import { validateArticleUrl } from './url-validator.js';

describe('validateArticleUrl — accepts', () => {
  it('a normal perplexity.ai HTTPS URL and returns the normalized href', () => {
    const r = validateArticleUrl('https://www.perplexity.ai/search/abc-123');
    expect(r.ok).toBe(true);
    expect(r.href).toBe('https://www.perplexity.ai/search/abc-123');
  });

  it('the apex perplexity.ai host', () => {
    expect(validateArticleUrl('https://perplexity.ai/x').ok).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const r = validateArticleUrl('  https://perplexity.ai/x  ');
    expect(r.ok).toBe(true);
    expect(r.href).toBe('https://perplexity.ai/x');
  });
});

describe('validateArticleUrl — rejects', () => {
  it('non-strings', () => {
    expect(validateArticleUrl(null).ok).toBe(false);
    expect(validateArticleUrl(undefined).ok).toBe(false);
    expect(validateArticleUrl(42).ok).toBe(false);
  });

  it('empty / whitespace-only', () => {
    expect(validateArticleUrl('').ok).toBe(false);
    expect(validateArticleUrl('   ').ok).toBe(false);
  });

  it('non-HTTPS', () => {
    expect(validateArticleUrl('http://perplexity.ai/x').ok).toBe(false);
    expect(validateArticleUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateArticleUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('disallowed / look-alike hosts', () => {
    expect(validateArticleUrl('https://evil.com/x').ok).toBe(false);
    expect(validateArticleUrl('https://perplexity.ai.evil.com/x').ok).toBe(false);
    expect(validateArticleUrl('https://evil.perplexity.ai/x').ok).toBe(false);
  });

  it('over-length URLs', () => {
    const long = 'https://perplexity.ai/' + 'a'.repeat(3000);
    expect(validateArticleUrl(long).ok).toBe(false);
  });
});

describe('validateArticleUrl — ALLOWED_ARTICLE_DOMAINS', () => {
  const ORIGINAL = process.env.ALLOWED_ARTICLE_DOMAINS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ALLOWED_ARTICLE_DOMAINS;
    else process.env.ALLOWED_ARTICLE_DOMAINS = ORIGINAL;
  });

  it('accepts a configured domain and its subdomains by suffix match', () => {
    process.env.ALLOWED_ARTICLE_DOMAINS = 'understandingwar.org,reuters.com';
    expect(validateArticleUrl('https://understandingwar.org/x').ok).toBe(true);
    expect(validateArticleUrl('https://www.understandingwar.org/x').ok).toBe(true);
    expect(validateArticleUrl('https://www.reuters.com/x').ok).toBe(true);
  });

  it('still rejects domains not on the configured list', () => {
    process.env.ALLOWED_ARTICLE_DOMAINS = 'understandingwar.org';
    expect(validateArticleUrl('https://evil.com/x').ok).toBe(false);
    expect(validateArticleUrl('https://reuters.com/x').ok).toBe(false);
  });

  it('still allows perplexity.ai (apex + www only) regardless of the env list', () => {
    process.env.ALLOWED_ARTICLE_DOMAINS = 'understandingwar.org';
    expect(validateArticleUrl('https://perplexity.ai/x').ok).toBe(true);
    expect(validateArticleUrl('https://www.perplexity.ai/x').ok).toBe(true);
  });

  it('never loosens perplexity.ai to arbitrary subdomains even if listed in env', () => {
    process.env.ALLOWED_ARTICLE_DOMAINS = 'perplexity.ai,understandingwar.org';
    expect(validateArticleUrl('https://evil.perplexity.ai/x').ok).toBe(false);
  });

  it('falls back to perplexity.ai only when the env var is unset/blank', () => {
    delete process.env.ALLOWED_ARTICLE_DOMAINS;
    expect(validateArticleUrl('https://understandingwar.org/x').ok).toBe(false);
    process.env.ALLOWED_ARTICLE_DOMAINS = '   ';
    expect(validateArticleUrl('https://understandingwar.org/x').ok).toBe(false);
  });

  it('rejects look-alike hosts for a configured domain too', () => {
    process.env.ALLOWED_ARTICLE_DOMAINS = 'reuters.com';
    expect(validateArticleUrl('https://reuters.com.evil.com/x').ok).toBe(false);
    expect(validateArticleUrl('https://notreuters.com/x').ok).toBe(false);
  });
});

describe('validateArticleUrl — injection safety (F-02)', () => {
  it('rejects URLs containing control characters (newline heredoc breakout)', () => {
    const r = validateArticleUrl('https://perplexity.ai/x\nAPPLESCRIPT\ndo shell script "id"');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/control/);
  });

  it('never returns a raw double-quote or space in href (AppleScript-safe)', () => {
    // A quote/space payload parses as a valid perplexity URL, but href must be
    // percent-encoded so nothing can break out of the AppleScript string.
    const r = validateArticleUrl('https://www.perplexity.ai/s?q=x" & do shell script "id');
    expect(r.ok).toBe(true);
    expect(r.href.includes('"')).toBe(false);
    expect(r.href.includes(' ')).toBe(false);
    expect(r.href.includes('\n')).toBe(false);
  });
});
