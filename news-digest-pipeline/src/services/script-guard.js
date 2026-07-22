// Detects stray non-Latin-script text in otherwise-English digest commentary —
// e.g. a model dropping a single Armenian/Cyrillic word into an English
// sentence (seen with gpt-5.6-terra, 2026-07-22). Legitimate quoted material
// (a name, slogan, or phrase deliberately quoted in its original script) is
// excluded: only unquoted runs are flagged.

const NON_LATIN_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Georgian}\p{Script=Thai}]+/gu;

const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'], // “ ”
  ["'", "'"],
  ['‘', '’'], // ‘ ’
];

function escapeRegex(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Byte ranges [start, end) covered by quoted spans, for any of the quote-pair styles. */
function getQuotedRanges(text) {
  const ranges = [];
  for (const [open, close] of QUOTE_PAIRS) {
    const body = open === close
      ? `[^${escapeRegex(open)}]*`
      : `[^${escapeRegex(open)}${escapeRegex(close)}]*`;
    const re = new RegExp(`${escapeRegex(open)}${body}${escapeRegex(close)}`, 'g');
    let m;
    while ((m = re.exec(text))) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

function isWithinRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Find runs of non-Latin-script text that are NOT inside quotation marks.
 * Returns [] if the text is clean. Each result: { text, index }.
 */
export function findUnquotedNonLatinRuns(text) {
  if (!text) return [];
  const quotedRanges = getQuotedRanges(text);
  const offenders = [];
  let m;
  NON_LATIN_SCRIPT.lastIndex = 0;
  while ((m = NON_LATIN_SCRIPT.exec(text))) {
    if (!isWithinRanges(m.index, quotedRanges)) {
      offenders.push({ text: m[0], index: m.index });
    }
  }
  return offenders;
}

/** True if `text` contains any unquoted non-Latin-script run. */
export function hasUnquotedNonLatinScript(text) {
  return findUnquotedNonLatinRuns(text).length > 0;
}

/** Short human-readable description of offending runs, for logs/warnings. */
export function describeScriptIssues(runs) {
  return runs.map((r) => `"${r.text}"`).join(', ');
}
