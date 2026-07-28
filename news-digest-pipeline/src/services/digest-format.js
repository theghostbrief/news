// Strips the <!--SEG--> / <!--TOP3--> machine-readable markers (added to
// prompts/en/assembly_prompt.md for the future segmenter — see
// media-pipeline-spec.md §5.1) from digest text before it goes anywhere a
// human reads it: publish targets (Telegram, Facebook, future publishers) and
// the dashboard preview modal. The STORED digest.content keeps the markers —
// only display/publish-time copies are stripped.
//
// Mirrored client-side in src/public/index.html's stripDigestMarkers() for the
// preview modal (plain browser script, no shared module system with the
// server) — keep both in sync if this regex changes.
//
// IMPORTANT: this is an explicit allowlist of patterns, not a general HTML-
// comment stripper — any NEW <!--MARKER...--> added to the assembly prompt
// (like THREADS was, and it was missed here until 2026-07-28) must be added
// to BOTH this list and the index.html mirror, or it leaks into published
// posts. Consider later (not now) collapsing this into one general
// <!--[\s\S]*?--> strip so a forgotten marker can't leak by construction —
// deferred for now since that's a bigger-blast-radius change than adding a
// line per marker.
export function stripDigestMarkers(text) {
  if (!text) return text;
  return text
    .replace(/<!--SEG.*?-->\n?/g, '')
    .replace(/<!--\/SEG-->\n?/g, '')
    .replace(/<!--TOP3.*?-->\n?/g, '')
    .replace(/<!--THREADS.*?-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
