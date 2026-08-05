/**
 * Instagram publisher — republishes the digest's TOP3 items as 3 independent
 * IG feed posts (image + caption), same container->publish shape as Threads
 * (§11.3 / roadmap #1 in docs/media-pipeline-spec.md). No reply chain — IG
 * feed posts don't have one.
 *
 * Unlike Threads, Instagram feed posts require an image — there is no
 * TEXT-only fallback. An item with no card URL (card generation skipped or
 * failed for it) fails outright rather than degrading to a text post.
 *
 * Depends only on the <!--SEG idx=N article_id="..." headline="..."--> /
 * <!--TOP3 [n1,n2,n3]--> markers already emitted by the assembly prompt
 * (§5.1) — reuses parseTop3Items/resolveCanonicalLink from the Threads
 * publisher rather than re-parsing the same content shape.
 */
import { parseTop3Items, resolveCanonicalLink } from './threads-publisher.js';

const IG_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';
const IG_CAPTION_LIMIT = 2200;

// Same rationale as threads-publisher.js's poll budget: containers are
// TEXT/IMAGE, not video, so a tight loop is sized for that rather than
// Meta's video-sized 5-minute guidance.
const DEFAULT_POLL_MAX_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Standalone post caption: headline + a short take + a trailing
 * "Full brief: <link>" line, same shape as Threads' formatItemPost. Prefers
 * the assembly-time <!--THREADS--> short take when present (it's a fine fit
 * for an IG caption too — no IG-specific marker exists yet), falling back to
 * the full commentary for older digests or items without one.
 *
 * The link suffix is reserved before trimming the headline+body portion so
 * it always survives intact, same reasoning as formatItemPost().
 */
export function formatItemCaption(item, canonicalLink, linkText) {
  const linkSuffix = canonicalLink ? `\n\n${linkText} ${canonicalLink}` : `\n\n${linkText}`;
  const body = item.threadsText || item.commentary;
  const bodyText = `${item.headline}\n\n${body}`;

  const maxBodyLength = IG_CAPTION_LIMIT - linkSuffix.length;
  let trimmedBody = bodyText;
  if (bodyText.length > maxBodyLength) {
    const ellipsis = '…';
    const cut = bodyText.slice(0, maxBodyLength - ellipsis.length);
    const lastSpace = cut.lastIndexOf(' ');
    trimmedBody = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + ellipsis;
  }
  return trimmedBody + linkSuffix;
}

// Two-step IG publish flow: create a media container, then publish it.
// Unlike Threads, IMAGE is the only supported media_type here — a container
// with no image_url is never created; callers that hit a missing card image
// must fail the item before calling this.
async function createContainer(igUserId, accessToken, { imageUrl, caption }) {
  const url = `${IG_GRAPH_API_BASE}/${igUserId}/media`;
  const body = { image_url: imageUrl, caption, access_token: accessToken };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: `Network error creating Instagram media container: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Instagram returned an unreadable response creating the media container.' };
  }

  if (!response.ok || data.error) {
    return { error: `Instagram container error: ${data.error?.message || `HTTP ${response.status}`}` };
  }
  if (!data.id) {
    return { error: 'Instagram did not return a container id.' };
  }
  return { containerId: data.id };
}

// Polls GET /{container-id}?fields=status_code until the container reports
// FINISHED, ERROR/EXPIRED (fail), or the attempt budget runs out. IG's status
// field is named status_code (Threads' equivalent is `status`) but the values
// are the same: IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED.
export async function pollContainerStatus(accessToken, containerId, label, {
  maxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = `${IG_GRAPH_API_BASE}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`;

    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      console.error(`[instagram-publisher] [${label}] Network error polling container ${containerId} status (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      return { error: `Network error polling Instagram container status: ${err.message}` };
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(`[instagram-publisher] [${label}] Unreadable response polling container ${containerId} status (attempt ${attempt}/${maxAttempts})`);
      return { error: 'Instagram returned an unreadable response polling container status.' };
    }

    if (!response.ok || data.error) {
      const msg = data.error?.message || `HTTP ${response.status}`;
      console.error(`[instagram-publisher] [${label}] Container ${containerId} status check failed: ${msg}`);
      return { error: `Instagram container status check failed: ${msg}` };
    }

    console.log(`[instagram-publisher] [${label}] Container ${containerId} status (attempt ${attempt}/${maxAttempts}): ${data.status_code}`);

    if (data.status_code === 'FINISHED') {
      return { ready: true };
    }
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      return { error: `Instagram container entered status ${data.status_code}` };
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  return { error: `Instagram container ${containerId} did not reach FINISHED status after ${maxAttempts} polling attempts.` };
}

async function publishContainer(igUserId, accessToken, containerId) {
  const url = `${IG_GRAPH_API_BASE}/${igUserId}/media_publish`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
    });
  } catch (err) {
    return { error: `Network error publishing Instagram container: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Instagram returned an unreadable response publishing the media.' };
  }

  if (!response.ok || data.error) {
    return { error: `Instagram publish error: ${data.error?.message || `HTTP ${response.status}`}` };
  }
  if (!data.id) {
    return { error: 'Instagram did not return a media id.' };
  }
  return { mediaId: data.id };
}

async function createAndPublishMedia(igUserId, accessToken, { imageUrl, caption, label }, pollOptions) {
  console.log(`[instagram-publisher] [${label}] Creating media container...`);
  const created = await createContainer(igUserId, accessToken, { imageUrl, caption });
  if (created.error) {
    console.error(`[instagram-publisher] [${label}] Container create failed: ${created.error}`);
    return { error: created.error };
  }
  console.log(`[instagram-publisher] [${label}] Container created: ${created.containerId} — polling status...`);

  const status = await pollContainerStatus(accessToken, created.containerId, label, pollOptions);
  if (status.error) {
    console.error(`[instagram-publisher] [${label}] Container status poll failed: ${status.error}`);
    return { error: status.error };
  }

  console.log(`[instagram-publisher] [${label}] Container ${created.containerId} ready — publishing...`);
  const published = await publishContainer(igUserId, accessToken, created.containerId);
  if (published.error) {
    console.error(`[instagram-publisher] [${label}] Publish failed: ${published.error}`);
    return { error: published.error };
  }
  console.log(`[instagram-publisher] [${label}] Published: ${published.mediaId}`);
  return { mediaId: published.mediaId };
}

/**
 * Publishes the digest's TOP3 items as 3 independent IG feed posts, image +
 * caption, immediate/synchronous (no scheduling yet — roadmap #2).
 *
 * Resumable by construction, same contract as publishThreadsChain:
 * digest.instagram_media_ids (persisted by publishers/index.js after every
 * attempt) holds exactly the media ids a prior attempt actually published, in
 * item order, so a retry never re-posts an item that already went live.
 *
 * @param {Object} [pollOptions] - Overrides for the container-status poll (maxAttempts, intervalMs). Tests shrink these to avoid real delays.
 * @returns {{ mediaIds: string[], error?: string, failedAt?: string }}
 */
export async function publishInstagramTop3(digest, config, pollOptions) {
  const igUserId = config.instagramAccountId;
  const accessToken = config.instagramAccessToken;

  if (!igUserId || !accessToken) {
    const error = 'Instagram account ID or access token is not configured (INSTAGRAM_ACCOUNT_ID / INSTAGRAM_ACCESS_TOKEN in .env).';
    console.error(`[instagram-publisher] ${error}`);
    return { mediaIds: [], error };
  }

  const items = parseTop3Items(digest.content);
  if (items.length < 3) {
    const error = `Digest content is missing a full TOP3 set (found ${items.length}/3 items) — cannot publish Instagram posts.`;
    console.error(`[instagram-publisher] ${error}`);
    return { mediaIds: [], error };
  }

  // Attach each item's card image URL by idx, same as Threads. Instagram has
  // no TEXT fallback though — an item with no matching card is a hard failure
  // for that item rather than a degraded post.
  let cardsByIdx = new Map();
  try {
    const cards = JSON.parse(digest.cards_json || '[]');
    if (Array.isArray(cards)) {
      cardsByIdx = new Map(cards.map((c) => [c.idx, c.url]));
    }
  } catch {
    cardsByIdx = new Map();
  }
  for (const item of items) {
    item.imageUrl = cardsByIdx.get(item.idx) || null;
  }

  let alreadyPublished = [];
  try {
    alreadyPublished = JSON.parse(digest.instagram_media_ids || '[]');
  } catch {
    alreadyPublished = [];
  }
  if (!Array.isArray(alreadyPublished)) alreadyPublished = [];

  const remainingItems = items.slice(alreadyPublished.length);
  if (remainingItems.length === 0) {
    console.log(`[instagram-publisher] Digest ${digest.id}: all ${items.length} items already published, nothing to resume.`);
    return { mediaIds: alreadyPublished };
  }

  const canonicalLink = resolveCanonicalLink(config);
  const mediaIds = [...alreadyPublished];

  console.log(`[instagram-publisher] Starting for digest ${digest.id}: ${remainingItems.length}/${items.length} item(s) remaining (${alreadyPublished.length} already published)`);

  for (const [i, item] of remainingItems.entries()) {
    const label = `item${alreadyPublished.length + i + 1}`;
    console.log(`[instagram-publisher] Position: "${label}" (${mediaIds.length + 1}/${items.length})`);

    if (!item.imageUrl) {
      const error = `Instagram publish stopped at "${label}": no card image available for this item (cards_json missing/empty/malformed for idx=${item.idx}).`;
      console.error(`[instagram-publisher] ${error}`);
      return { mediaIds, error, failedAt: label };
    }

    const caption = formatItemCaption(item, canonicalLink, config.instagramLinkText);
    const result = await createAndPublishMedia(igUserId, accessToken, { imageUrl: item.imageUrl, caption, label }, pollOptions);
    if (result.error) {
      const error = `Instagram publish stopped at "${label}": ${result.error}`;
      console.error(`[instagram-publisher] ${error}`);
      return { mediaIds, error, failedAt: label };
    }
    mediaIds.push(result.mediaId);
  }

  console.log(`[instagram-publisher] Complete for digest ${digest.id}: ${mediaIds.join(', ')}`);
  return { mediaIds };
}
