import { describe, it, expect, afterEach } from 'vitest';
import { isAuthenticated } from './auth.js';

// With no credentials on the request, isAuthenticated(req) collapses to
// authDisabled(): true = auth OFF (open), false = auth ENFORCED. These tests pin
// the fail-CLOSED contract (F-27) and the removal of ?key= auth (F-19).

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_KEY = process.env.API_SECRET_KEY;

afterEach(() => {
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  if (ORIG_KEY === undefined) delete process.env.API_SECRET_KEY;
  else process.env.API_SECRET_KEY = ORIG_KEY;
});

describe('fail-closed auth (F-27)', () => {
  const emptyReq = { headers: {}, query: {} };

  // Anything that is NOT an explicit dev value must ENFORCE auth — including a
  // typo'd or unset NODE_ENV, which previously (\!== 'production') failed OPEN.
  for (const v of ['production', 'Production', 'PRODUCTION', 'prod', '', 'staging', 'qa']) {
    it(`enforces auth for NODE_ENV='${v}'`, () => {
      process.env.NODE_ENV = v;
      expect(isAuthenticated(emptyReq)).toBe(false);
    });
  }

  it('enforces auth when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(isAuthenticated(emptyReq)).toBe(false);
  });

  for (const v of ['development', 'Development', 'test']) {
    it(`opens (dev friction-free) for NODE_ENV='${v}'`, () => {
      process.env.NODE_ENV = v;
      expect(isAuthenticated(emptyReq)).toBe(true);
    });
  }
});

describe('?key= query auth is removed (F-19)', () => {
  it('does NOT authenticate via ?key= even with the correct key', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_SECRET_KEY = 'secret-test-key';
    const req = { headers: {}, query: { key: 'secret-test-key' } };
    expect(isAuthenticated(req)).toBe(false);
  });

  it('still authenticates via a correct Bearer token', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_SECRET_KEY = 'secret-test-key';
    const req = { headers: { authorization: 'Bearer secret-test-key' }, query: {} };
    expect(isAuthenticated(req)).toBe(true);
  });

  it('rejects a wrong Bearer token', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_SECRET_KEY = 'secret-test-key';
    const req = { headers: { authorization: 'Bearer nope' }, query: {} };
    expect(isAuthenticated(req)).toBe(false);
  });
});
