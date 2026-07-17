import { describe, it, expect } from 'vitest';
import { safeNext } from './auth.js';

describe('safeNext — open-redirect guard (F-27)', () => {
  it('allows same-origin absolute paths', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/dashboard')).toBe('/dashboard');
    expect(safeNext('/a/b?c=d#e')).toBe('/a/b?c=d#e');
  });

  it('rejects protocol-relative and backslash cross-origin targets', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');   // browsers normalize to //evil.com
    expect(safeNext('/\\/evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('http://evil.com')).toBe('/');
  });

  it('rejects non-strings, empty, missing leading slash, and control/backslash chars', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(42)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('dashboard')).toBe('/');
    expect(safeNext('/x\ny')).toBe('/');
    expect(safeNext('/a\\b')).toBe('/');
  });
});
