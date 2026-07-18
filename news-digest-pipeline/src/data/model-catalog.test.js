import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG, priceFor } from './model-catalog.js';

describe('MODEL_CATALOG', () => {
  it('has the expected number of models per vendor', () => {
    expect(MODEL_CATALOG.anthropic).toHaveLength(7);
    expect(MODEL_CATALOG.openai).toHaveLength(11);
  });

  it('every model has id, label and numeric input/output pricing', () => {
    for (const vendor of Object.keys(MODEL_CATALOG)) {
      for (const m of MODEL_CATALOG[vendor]) {
        expect(typeof m.id).toBe('string');
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.label).toBe('string');
        expect(typeof m.pricing.input).toBe('number');
        expect(typeof m.pricing.output).toBe('number');
        expect(m.pricing.input).toBeGreaterThan(0);
        expect(m.pricing.output).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate model ids across the whole catalog', () => {
    const ids = Object.values(MODEL_CATALOG).flat().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('priceFor', () => {
  it('returns base prices for a known Anthropic model', () => {
    expect(priceFor('claude-opus-4-6')).toEqual({ input: 5, output: 25 });
  });

  it('returns base prices for a known OpenAI model', () => {
    expect(priceFor('gpt-5.4-mini')).toEqual({ input: 0.75, output: 4.5 });
  });

  it('returns base prices for GPT-5.6 Terra', () => {
    expect(priceFor('gpt-5.6-terra')).toEqual({ input: 2.5, output: 15 });
  });

  it('returns null for an unknown model', () => {
    expect(priceFor('no-such-model')).toBeNull();
  });
});

describe('digest cost calculation', () => {
  // Mirrors the formula used in digest-generator.generateDigest.
  const cost = (model, inTok, outTok) => {
    const p = priceFor(model);
    if (!p) return null;
    return Number((inTok / 1e6 * p.input + outTok / 1e6 * p.output).toFixed(6));
  };

  it('computes cost for Opus 4.6 (10k in / 2k out = $0.10)', () => {
    expect(cost('claude-opus-4-6', 10000, 2000)).toBe(0.1);
  });

  it('computes cost for Haiku 4.5 (cheapest Anthropic)', () => {
    // 1M in * $1 + 1M out * $5 = $6
    expect(cost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBe(6);
  });

  it('returns null cost when the model is not in the catalog', () => {
    expect(cost('mystery-model', 1000, 1000)).toBeNull();
  });
});
