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
export function stripDigestMarkers(text) {
  if (!text) return text;
  return text
    .replace(/<!--SEG.*?-->\n?/g, '')
    .replace(/<!--\/SEG-->\n?/g, '')
    .replace(/<!--TOP3.*?-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
