// ─────────────────────────────────────────────────────────────────────────────
// Cheap lexical near-duplicate detection for compile-time review. No
// embeddings, no LLM call, no dependency — word-trigram shingling + Jaccard
// similarity, which is enough to catch wire-copy syndication and near-
// identical rewrites of the same story without confusing "same broad topic"
// with "same story" (two independently-written articles rarely share many
// literal 3-word phrases even when covering the same event).
// ─────────────────────────────────────────────────────────────────────────────

const SHINGLE_SIZE = 3;
// Below this many shingles there isn't enough text to compare meaningfully —
// treat as "never flag" rather than risk a spurious high Jaccard score on
// two short, mostly-empty texts. Biases toward under-flagging, as required.
const MIN_SHINGLES = 5;
// Only compare this much of each article's text — near-duplicate signal is
// concentrated in the opening paragraphs (the lede), and capping keeps the
// O(n^2) pairwise comparison cheap regardless of how long a fetched page is.
const MAX_COMPARISON_CHARS = 3000;

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingle(text) {
  const words = normalizeText(text).slice(0, MAX_COMPARISON_CHARS).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i <= words.length - SHINGLE_SIZE; i++) {
    set.add(words.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return set;
}

/**
 * Word-trigram Jaccard similarity between two texts, 0..1. Returns 0 if
 * either text is too short to shingle meaningfully (see MIN_SHINGLES).
 */
export function jaccardSimilarity(textA, textB) {
  const a = shingle(textA);
  const b = shingle(textB);
  if (a.size < MIN_SHINGLES || b.size < MIN_SHINGLES) return 0;

  let intersection = 0;
  for (const s of a) {
    if (b.has(s)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function articleText(article) {
  return `${article.title || ''} ${article.content || ''}`;
}

/**
 * Group articles into suspected-duplicate clusters. Pairwise comparison
 * (O(n^2), trivial for a compile-sized batch), grouped via union-find so a
 * chain of pairwise matches (A~B, B~C) becomes one group even if A~C alone
 * didn't clear the threshold.
 *
 * @param {Array<{id, title, content}>} articles
 * @param {number} threshold 0..1 — only pairs at or above this are grouped
 * @returns {Array<Array<{id, title, content}>>} groups of size >= 2 only
 */
export function findDuplicateGroups(articles, threshold) {
  const n = articles.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x, y) {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }

  const texts = articles.map(articleText);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccardSimilarity(texts[i], texts[j]) >= threshold) {
        union(i, j);
      }
    }
  }

  const groupsByRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(articles[i]);
  }

  return [...groupsByRoot.values()].filter((g) => g.length > 1);
}
