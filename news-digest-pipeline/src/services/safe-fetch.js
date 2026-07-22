import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateArticleUrl } from './url-validator.js';

const DEFAULT_TIMEOUT_MS = 15000;
// Article HTML pages are small (tens of KB); this is generous headroom while
// still bounding memory against a malicious or misbehaving server.
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT RFC6598
  if (a === 0) return true; // "this network"
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

/** True if `ip` is a private/loopback/link-local/reserved address (v4 or v6). */
export function isPrivateIP(ip) {
  return isIP(ip) === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

/**
 * Resolve a hostname and reject if ANY resolved address is private/reserved.
 * The hostname already passed the perplexity.ai allowlist by the time this
 * runs — this defends against that hostname's DNS answer being rebound to a
 * private address between validation and connect.
 */
async function assertPublicHostname(hostname) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(`Refusing to fetch ${hostname}: resolves to a private/reserved address (${address})`);
    }
  }
}

/**
 * SSRF-hardened fetch for article URLs. Every redirect hop is re-validated
 * against the perplexity.ai allowlist and re-resolved to rule out a private
 * address (redirect: 'manual', so we control the loop instead of trusting
 * fetch() to follow blindly), and the response body is read under a hard byte
 * cap enforced on actual bytes received, not the (spoofable) Content-Length
 * header.
 *
 * Returns a minimal Response-like object: { ok, status, text() }.
 */
export async function safeFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let redirectsLeft = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = url;
  for (;;) {
    const v = validateArticleUrl(current);
    if (!v.ok) throw new Error(`Refusing to fetch: ${v.error}`);
    const parsed = new URL(v.href);
    await assertPublicHostname(parsed.hostname);

    const response = await fetch(v.href, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirectsLeft <= 0) throw new Error(`Too many redirects fetching ${url}`);
      redirectsLeft--;
      current = new URL(location, v.href).href;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${current}`);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`Response exceeded ${maxBytes} bytes fetching ${current}`);
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');

    return { ok: true, status: response.status, text: async () => text };
  }
}
