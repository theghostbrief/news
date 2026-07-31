// Parses the <!--SEG--> / <!--TOP3--> markers (prompts/en/assembly_prompt.md
// §5.1) out of an assembled Ghost digest's `content` into structured items.
//
// This is the mechanical inverse of what the assembly prompt produces: each
// item is
//   <!--SEG idx=N article_id="<id>" headline="<headline>"-->
//   N. <commentary — one or more paragraphs, blank-line separated>
//   <source link>
//   <!--/SEG-->
// followed once, after the last item, by a single `Ghost's read: <sentence>`
// line. Used by the public reader route (routes/public.js) to render clean
// per-item fields instead of shipping raw markdown-with-markers, and intended
// as the shared parser for the future podcast segmenter (media-pipeline-spec
// §9, P1) rather than a second bespoke one.
//
// Coupled to the exact marker format in assembly_prompt.md, same as
// digest-format.js's stripDigestMarkers() already is — if that format
// changes, both need updating together.

const SEG_RE = /<!--SEG idx=(\d+) article_id="([^"]*)" headline="([^"]*)"-->\n([\s\S]*?)\n<!--\/SEG-->/g;
const GHOSTS_READ_RE = /Ghost.s read:\s*(.+)/;

/**
 * @param {string} content - digest.content (raw, with markers).
 * @returns {{ items: Array<{idx: number, articleId: string, headline: string, commentary: string, sourceLink: string}>, ghostsRead: string|null }}
 */
export function segmentDigest(content) {
  if (!content) return { items: [], ghostsRead: null };

  const items = [];
  let match;
  SEG_RE.lastIndex = 0;
  while ((match = SEG_RE.exec(content)) !== null) {
    const idx = parseInt(match[1], 10);
    const articleId = match[2];
    const headline = match[3];
    const body = match[4];

    const lines = body.split('\n');
    const sourceLink = (lines[lines.length - 1] || '').trim();
    let commentary = lines.slice(0, -1).join('\n');
    // Strip the leading "N. " item-number prefix the assembly prompt bakes
    // into the commentary line — not part of the actual commentary text.
    commentary = commentary.replace(new RegExp(`^${idx}\\.\\s+`), '').trim();

    items.push({ idx, articleId, headline, commentary, sourceLink });
  }

  const ghostsReadMatch = content.match(GHOSTS_READ_RE);
  const ghostsRead = ghostsReadMatch ? ghostsReadMatch[1].trim() : null;

  return { items, ghostsRead };
}
