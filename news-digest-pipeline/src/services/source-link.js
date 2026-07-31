// Cleans and labels the source link parsed out of a digest SEG block for the
// public reader page (theghostbrief.com). Two separate concerns:
//
// 1. Strip tracking-query junk (utm_*, fbclid, etc.) so the URL itself is
//    short and clean, while keeping structurally required params intact
//    (e.g. Facebook's story_fbid/post_id/id — without those the link 404s).
// 2. Produce an honest display label. Known defense/security outlets get
//    their real name; perplexity.ai/discover links are labeled "via
//    Perplexity" rather than resolved to a guessed primary outlet — Jina's
//    extraction of Perplexity pages inconsistently exposes the actual cited
//    source (the named primary citation is often plain text with no href;
//    what IS linked tends to be a secondary reprint site), so resolving
//    automatically would risk silently crediting the wrong outlet. See the
//    2026-07-31 public-page scoping conversation for the sampled evidence.
// Anything unmapped falls back to its bare hostname — never an invented
// outlet name.

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid', 'igshid', 'mibextid', 'sfnsn', 'oref', 'ref_src',
  'yclid', 'twclid', 'spm',
];

const OUTLET_LABELS = {
  'defensenews.com': 'Defense News',
  'twz.com': 'TWZ',
  'militarnyi.com': 'Militarnyi',
  'breakingdefense.com': 'Breaking Defense',
  'kyivindependent.com': 'Kyiv Independent',
  'warontherocks.com': 'War on the Rocks',
  'militarywatchmagazine.com': 'Military Watch Magazine',
  'rusi.org': 'RUSI',
  'eurasiantimes.com': 'Eurasian Times',
  'defenseone.com': 'Defense One',
  'janes.com': 'Janes',
  'understandingwar.org': 'ISW',
  'apnews.com': 'AP News',
  'cnn.com': 'CNN',
  'err.ee': 'ERR News',
  'pravda.com.ua': 'Ukrainska Pravda',
  '24tv.ua': '24 Kanal',
  'seenews.com': 'SeeNews',
  'mezha.ua': 'Mezha Media',
  'thinkbrics.substack.com': 'Think BRICS',
  'facebook.com': 'Facebook',
  'fb.watch': 'Facebook',
};

const PERPLEXITY_HOST_RE = /(^|\.)perplexity\.ai$/;

/** True when `host` equals `domain` or is a subdomain of it. */
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function labelForHost(host) {
  for (const domain of Object.keys(OUTLET_LABELS)) {
    if (hostMatches(host, domain)) return OUTLET_LABELS[domain];
  }
  return host;
}

/**
 * @param {string} rawUrl - the source link parsed from a SEG block.
 * @returns {{ label: string, url: string } | null}
 */
export function attributeSource(rawUrl) {
  if (!rawUrl) return null;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { label: rawUrl, url: rawUrl };
  }

  for (const param of TRACKING_PARAMS) {
    parsed.searchParams.delete(param);
  }

  const host = parsed.hostname.replace(/^www\./, '');
  const label = PERPLEXITY_HOST_RE.test(parsed.hostname) ? 'via Perplexity' : labelForHost(host);

  return { label, url: parsed.toString() };
}
