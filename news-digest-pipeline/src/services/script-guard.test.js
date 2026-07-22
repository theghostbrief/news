import { describe, it, expect } from 'vitest';
import { findUnquotedNonLatinRuns, hasUnquotedNonLatinScript, describeScriptIssues } from './script-guard.js';

describe('findUnquotedNonLatinRuns', () => {
  it('returns [] for clean English text', () => {
    expect(findUnquotedNonLatinRuns('The strike hit a logistics depot, unverified.')).toEqual([]);
  });

  it('flags a stray unquoted non-Latin word (the real gpt-5.6-terra bug, 2026-07-22)', () => {
    const text = 'What mattered was the operational trade-off. Ռուսաստանը was consuming trained formations.';
    const runs = findUnquotedNonLatinRuns(text);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Ռուսաստանը');
  });

  it('flags stray Cyrillic the same way', () => {
    const runs = findUnquotedNonLatinRuns('Officials said Россия would respond.');
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Россия');
  });

  it('does NOT flag non-Latin text inside straight double quotes (legitimate quote)', () => {
    const runs = findUnquotedNonLatinRuns('The rallying cry "Слава Україні" spread quickly.');
    expect(runs).toEqual([]);
  });

  it('does NOT flag non-Latin text inside curly quotes', () => {
    const runs = findUnquotedNonLatinRuns('The banner read “Слава Україні” at the rally.');
    expect(runs).toEqual([]);
  });

  it('does NOT flag non-Latin text inside single quotes', () => {
    const runs = findUnquotedNonLatinRuns("The slogan 'Слава Україні' was chanted.");
    expect(runs).toEqual([]);
  });

  it('still flags unquoted script even when a quoted span exists elsewhere in the same text', () => {
    const runs = findUnquotedNonLatinRuns('The slogan "Слава Україні" was chanted, and Москва reacted.');
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('Москва');
  });

  it('handles empty/null/undefined input', () => {
    expect(findUnquotedNonLatinRuns('')).toEqual([]);
    expect(findUnquotedNonLatinRuns(null)).toEqual([]);
    expect(findUnquotedNonLatinRuns(undefined)).toEqual([]);
  });
});

describe('hasUnquotedNonLatinScript', () => {
  it('returns false for clean text', () => {
    expect(hasUnquotedNonLatinScript('All clear here.')).toBe(false);
  });

  it('returns true when a stray run is present', () => {
    expect(hasUnquotedNonLatinScript('stray word Ռուսաստանը here')).toBe(true);
  });
});

describe('describeScriptIssues', () => {
  it('joins offending runs into a readable summary', () => {
    const runs = findUnquotedNonLatinRuns('Россия and Ռուսաստանը both appeared.');
    expect(describeScriptIssues(runs)).toBe('"Россия", "Ռուսաստանը"');
  });
});
