// TOP3 headline cards for IG/Threads (media-pipeline-spec.md §4.4).
// Template-rendered, no AI image gen: an SVG layer (background, confidence
// pill, wrapped headline, brand wordmark) rasterized by sharp, with the Ghost
// logo composited on top. Reuses parseTop3Items() from threads-publisher.js
// so this reads the same <!--SEG-->/<!--TOP3--> markers that publisher
// already depends on, instead of a second bespoke parser (same reasoning as
// segmenter.js's header comment).

import sharp from 'sharp';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseTop3Items } from './publishers/threads-publisher.js';
import { updateDigest } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'ghost-logo.png');
// Under the ./data volume (docker-compose.yml) so cards survive a redeploy —
// src/public-site (the reader page) is baked into the image and is NOT
// volume-mounted, so it gets wiped on every `docker compose build`.
const CARDS_DATA_DIR = path.join(__dirname, '..', '..', 'data', 'media', 'cards');

export const CARD_SIZE = 1080;
const PADDING = 76;
const LOGO_SIZE = 150;
const BG_COLOR = '#0a0a0c';
const ACCENT = '#7c3aed'; // matches the violet accent used across the dashboard/reader
// 'DejaVu Sans' is the font actually installed in the production Docker image
// (see Dockerfile) — bookworm-slim ships no fonts at all otherwise, which
// renders SVG <text> blank. Inter/Arial only apply to local dev where a
// system font happens to be present.
const FONT_FAMILY = "'DejaVu Sans',Inter,Arial,sans-serif";

const CONFIDENCE_STYLES = {
  confirmed: { fg: '#4ade80', bg: 'rgba(34,197,94,0.16)' },
  claimed: { fg: '#fbbf24', bg: 'rgba(245,158,11,0.16)' },
  unverified: { fg: '#9ca3af', bg: 'rgba(255,255,255,0.08)' },
};

/**
 * Finds the leftmost OSINT confidence marker (prompt.md's confirmed /
 * claimed by <side> / unverified vocabulary) in a piece of commentary text,
 * so the card shows the confidence tag that governs the headline's own
 * claim rather than a later, unrelated one in the same paragraph.
 * @returns {{tone: 'confirmed'|'claimed'|'unverified', label: string}|null}
 */
export function extractConfidenceMarker(text) {
  if (!text) return null;

  const candidates = [
    {
      re: /\bclaimed by (?:the\s+)?([^,.;:()—–-]+)/i,
      tone: 'claimed',
      label: (m) => `CLAIMED BY ${m[1].trim().toUpperCase()}`,
    },
    { re: /\bconfirmed\b/i, tone: 'confirmed', label: () => 'CONFIRMED' },
    { re: /\bunverified\b/i, tone: 'unverified', label: () => 'UNVERIFIED' },
  ];

  let best = null;
  for (const c of candidates) {
    const m = text.match(c.re);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, tone: c.tone, label: c.label(m) };
    }
  }
  return best ? { tone: best.tone, label: best.label } : null;
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/**
 * Greedy word-wrap using an average-glyph-width estimate (no text-measurement
 * lib in the stack) — same tradeoff as picking a static brand font in §4.4
 * over a heavier layout engine. Ratio is calibrated for bold Inter/DejaVu Sans.
 */
function wrapLines(text, fontSize, maxWidth, avgCharWidthRatio = 0.6) {
  const words = text.split(/\s+/).filter(Boolean);
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * avgCharWidthRatio)));
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Picks the largest font size (from a fixed ladder) whose wrapped headline fits the box; truncates at the smallest size as a last resort. */
function fitHeadline(headline, maxWidth, maxHeight) {
  const sizes = [96, 84, 72, 64, 56, 48, 42];
  const lineHeightRatio = 1.18;

  for (const fontSize of sizes) {
    const lines = wrapLines(headline, fontSize, maxWidth);
    const blockHeight = lines.length * fontSize * lineHeightRatio;
    if (blockHeight <= maxHeight) {
      return { fontSize, lines, lineHeight: fontSize * lineHeightRatio };
    }
  }

  const fontSize = sizes[sizes.length - 1];
  const lineHeight = fontSize * lineHeightRatio;
  let lines = wrapLines(headline, fontSize, maxWidth);
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '').trimEnd() + '…';
  }
  return { fontSize, lines, lineHeight };
}

/**
 * Renders one 1080x1080 TOP3 card as a PNG buffer.
 * @param {{headline: string, confidenceText?: string}} item - confidenceText
 *   is the text scanned for the confidence marker; falls back to headline.
 */
export async function renderTop3Card({ headline, confidenceText }) {
  const marker = extractConfidenceMarker(confidenceText || headline);
  const pillStyle = CONFIDENCE_STYLES[marker?.tone] ?? CONFIDENCE_STYLES.unverified;
  const pillLabel = marker?.label ?? null;

  const eyebrowY = PADDING + 26;
  const pillTop = PADDING + 58;
  const pillHeight = 52;
  const wordmarkY = CARD_SIZE - 64;

  const headlineTop = pillTop + pillHeight + 44;
  const headlineBottom = wordmarkY - 56;
  const headlineMaxWidth = CARD_SIZE - PADDING * 2;
  const headlineMaxHeight = headlineBottom - headlineTop;

  const { fontSize, lines, lineHeight } = fitHeadline(headline, headlineMaxWidth, headlineMaxHeight);
  const blockHeight = lines.length * lineHeight;
  const firstBaseline = headlineTop + (headlineMaxHeight - blockHeight) / 2 + fontSize * 0.82;
  const tspans = lines
    .map((line, i) => `<tspan x="${PADDING}" y="${firstBaseline + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');

  const pillWidth = pillLabel ? Math.min(CARD_SIZE - PADDING * 2, pillLabel.length * 15 + 56) : 0;

  const svg = `
<svg width="${CARD_SIZE}" height="${CARD_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="vignette" cx="50%" cy="34%" r="80%">
      <stop offset="0%" stop-color="#16151b"/>
      <stop offset="100%" stop-color="${BG_COLOR}"/>
    </radialGradient>
  </defs>
  <rect width="${CARD_SIZE}" height="${CARD_SIZE}" fill="url(#vignette)"/>
  <rect x="${PADDING}" y="${eyebrowY - 24}" width="6" height="34" fill="${ACCENT}"/>
  <text x="${PADDING + 20}" y="${eyebrowY}" font-family="${FONT_FAMILY}" font-size="26" font-weight="700" letter-spacing="3" fill="#8b8593">THE GHOST BRIEF</text>
  ${pillLabel ? `
  <rect x="${PADDING}" y="${pillTop}" width="${pillWidth}" height="${pillHeight}" rx="26" fill="${pillStyle.bg}"/>
  <text x="${PADDING + pillWidth / 2}" y="${pillTop + pillHeight / 2 + 8}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="23" font-weight="700" letter-spacing="1.5" fill="${pillStyle.fg}">${escapeXml(pillLabel)}</text>
  ` : ''}
  <text font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="800" fill="#f5f4f6">${tspans}</text>
  <text x="${PADDING}" y="${wordmarkY}" font-family="${FONT_FAMILY}" font-size="21" font-weight="600" letter-spacing="2" fill="#5c5763">GHOSTBRIEF.COM</text>
</svg>`.trim();

  const logo = await sharp(LOGO_PATH).resize(LOGO_SIZE, LOGO_SIZE).png().toBuffer();
  const logoOffset = CARD_SIZE - PADDING - LOGO_SIZE;

  return sharp(Buffer.from(svg))
    .composite([{ input: logo, top: logoOffset, left: logoOffset }])
    .png()
    .toBuffer();
}

/**
 * Renders all 3 TOP3 cards for an assembled digest and writes them to
 * `<outDir>/top-<idx>.png`. Returns [] if the digest has no full TOP3 set
 * (same "all or nothing" contract as threads-publisher's parseTop3Items).
 * @param {string} content - digest.content (raw, with markers).
 * @param {string} outDir - directory to write PNGs into (must already exist).
 */
export async function makeTop3Cards(content, outDir) {
  const items = parseTop3Items(content);
  const results = [];
  for (const item of items) {
    const buffer = await renderTop3Card({
      headline: item.headline,
      confidenceText: item.threadsText || item.commentary,
    });
    const filePath = path.join(outDir, `top-${item.idx}.png`);
    await sharp(buffer).toFile(filePath);
    results.push({ idx: item.idx, articleId: item.articleId, path: filePath });
  }
  return results;
}

/**
 * Best-effort, idempotent card generation for a digest at publish time.
 * Returns `[{idx, articleId, url}]` (publisher-agnostic — Threads and a
 * future IG publisher both read this same shape), or `[]` if cards can't be
 * produced (no PUBLIC_MEDIA_BASE_URL configured, no full TOP3 set, or a
 * render failure) — callers treat `[]` as "publish text-only," never as a
 * reason to fail the publish attempt itself.
 *
 * Reuses `digest.cards_json` if already populated (set on a prior attempt)
 * instead of re-rendering on every retry.
 * @param {{cardsDataDir?: string}} [opts] - cardsDataDir override for tests;
 *   production callers rely on the CARDS_DATA_DIR default.
 */
export async function ensureTop3CardUrls(digest, config, { cardsDataDir = CARDS_DATA_DIR } = {}) {
  if (digest.cards_json) {
    try {
      const existing = JSON.parse(digest.cards_json);
      if (Array.isArray(existing) && existing.length > 0) return existing;
    } catch {
      // Malformed JSON — fall through and regenerate rather than crash.
    }
  }

  if (!config?.publicMediaBaseUrl) {
    return [];
  }

  try {
    const outDir = path.join(cardsDataDir, digest.id);
    await mkdir(outDir, { recursive: true });

    const rendered = await makeTop3Cards(digest.content, outDir);
    if (rendered.length === 0) return [];

    const base = config.publicMediaBaseUrl.replace(/\/+$/, '');
    const cards = rendered.map((r) => ({
      idx: r.idx,
      articleId: r.articleId,
      url: `${base}/media/cards/${digest.id}/top-${r.idx}.png`,
    }));

    updateDigest(digest.id, { cards_json: JSON.stringify(cards) });
    digest.cards_json = JSON.stringify(cards);
    return cards;
  } catch (err) {
    console.error(`[card-generator] Failed to generate TOP3 cards for digest ${digest.id}: ${err.message}`);
    return [];
  }
}
