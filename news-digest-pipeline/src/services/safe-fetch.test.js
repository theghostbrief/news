import { describe, it, expect } from 'vitest';
import { isPrivateIP } from './safe-fetch.js';

describe('isPrivateIP — IPv4', () => {
  it('flags RFC1918 ranges', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('192.168.1.1')).toBe(true);
  });

  it('flags loopback, link-local, CGNAT, and "this network"', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.1.1')).toBe(true);
    expect(isPrivateIP('100.64.0.1')).toBe(true);
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('does not flag adjacent public ranges', () => {
    expect(isPrivateIP('172.15.255.255')).toBe(false);
    expect(isPrivateIP('172.32.0.0')).toBe(false);
    expect(isPrivateIP('100.63.255.255')).toBe(false);
    expect(isPrivateIP('100.128.0.0')).toBe(false);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
  });
});

describe('isPrivateIP — IPv6', () => {
  it('flags loopback, unspecified, link-local, and unique-local', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('::')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456:789a::1')).toBe(true);
  });

  it('flags IPv4-mapped private addresses', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not flag a public IPv6 address', () => {
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false);
  });
});
