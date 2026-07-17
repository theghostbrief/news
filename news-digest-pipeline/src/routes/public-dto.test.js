import { describe, it, expect } from 'vitest';
import {
  publicDigest,
  publicArticle,
  clampLimit,
} from './public-dto.js';

// Full rows carrying every column, including the sensitive ones. The DTOs are
// allowlists, so the assertions check exact key sets: no sensitive field may
// leak and no unexpected field may appear.

describe('publicDigest', () => {
  const full = {
    id: 1, date: '2026-07-16', part: 1, seq_number: 42, articles_count: 15,
    content: 'digest text', status: 'draft', published_at: null,
    created_at: 't0', updated_at: 't1',
    // sensitive:
    generation_log: 'LLM log', model: 'gpt-5', input_tokens: 1000,
    output_tokens: 2000, cost_usd: 0.12, facebook_post_id: 'fb123',
    telegram_message_id: 'tg123', youtube_post_id: 'yt123',
  };

  it('keeps exactly the safe fields', () => {
    expect(Object.keys(publicDigest(full)).sort()).toEqual([
      'articles_count', 'content', 'created_at', 'date', 'id', 'part',
      'published_at', 'seq_number', 'status', 'updated_at',
    ]);
  });

  it('drops every sensitive field', () => {
    const dto = publicDigest(full);
    for (const k of ['generation_log', 'model', 'input_tokens', 'output_tokens',
      'cost_usd', 'facebook_post_id', 'telegram_message_id', 'youtube_post_id']) {
      expect(dto).not.toHaveProperty(k);
    }
  });

  it('passes null/undefined through untouched', () => {
    expect(publicDigest(null)).toBeNull();
    expect(publicDigest(undefined)).toBeUndefined();
  });
});

describe('publicArticle', () => {
  const full = {
    id: 5, url: 'https://x/y', title: 'T', content: 'body', status: 'new',
    digest_id: 3, created_at: 't0', updated_at: 't1',
    // sensitive:
    commentary: 'draft commentary', fetch_error: 'boom',
    source_chat_id: 'chat1', source_message_id: 'msg1', source: 'telegram',
  };

  it('keeps exactly the safe fields', () => {
    expect(Object.keys(publicArticle(full)).sort()).toEqual([
      'content', 'created_at', 'digest_id', 'id', 'status', 'title',
      'updated_at', 'url',
    ]);
  });

  it('drops commentary, fetch_error, telegram source ids and source channel', () => {
    const dto = publicArticle(full);
    for (const k of ['commentary', 'fetch_error', 'source_chat_id',
      'source_message_id', 'source']) {
      expect(dto).not.toHaveProperty(k);
    }
  });
});

// NOTE: publicSourcePost moved to the pro cluster; its tests live in
// src/pro/dto.test.js.

describe('clampLimit', () => {
  it('falls back to default for non-positive / non-numeric input', () => {
    expect(clampLimit('-1', 50, 200)).toBe(50);   // SQLite LIMIT -1 = unbounded
    expect(clampLimit('0', 50, 200)).toBe(50);
    expect(clampLimit('abc', 50, 200)).toBe(50);
    expect(clampLimit(undefined, 50, 200)).toBe(50);
    expect(clampLimit('', 50, 200)).toBe(50);
  });

  it('caps at max and passes valid values through', () => {
    expect(clampLimit('5', 50, 200)).toBe(5);
    expect(clampLimit('50', 50, 200)).toBe(50);
    expect(clampLimit('9999', 50, 200)).toBe(200);
    expect(clampLimit('200', 50, 200)).toBe(200);
  });
});
