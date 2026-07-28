/**
 * Threads publisher — republishes the digest's TOP3 items as a Threads
 * reply-chain (lead post + 2 sequential replies + a closing "Full brief:"
 * link reply). See docs/media-pipeline-spec.md §11.
 *
 * Depends only on the <!--SEG idx=N article_id="..." headline="..."--> /
 * <!--TOP3 [n1,n2,n3]--> markers already emitted by the assembly prompt
 * (§5.1) — no prompt changes needed.
 */
import { resolveThreadsAccessToken } from './threads-token-refresh.js';

const THREADS_API_BASE = 'https://graph.threads.net/v1.0';
const THREADS_POST_LIMIT = 500;

// Meta's official guidance (developers.facebook.com/documentation/threads/
// troubleshooting) is to poll a container's status once/minute for up to 5
// minutes — sized for video containers. Ours are TEXT-only and the live 2026-
// 07-27 failure ("resource does not exist" publishing immediately after
// create) resolved with no wait at all having been tried, so a much tighter
// loop is used here. Revisit these numbers if a live run ever exhausts them.
const DEFAULT_POLL_MAX_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Static fallback until the site URL (P3) ships — see resolveCanonicalLink().
const TELEGRAM_CHANNEL_FALLBACK_LINK = 't.me/theghostbrief';

/**
 * Parses the TOP3 marker and its 3 referenced SEG blocks out of assembled
 * digest content, in TOP3 order (the array order is "ranked by nothing in
 * particular" per assembly_prompt.md — n1 is simply the lead post, n2/n3 the
 * two replies). Also picks up each item's <!--THREADS idx=N text="..."-->
 * short-form take when present (assembly_prompt.md §5) — digests assembled
 * before that field existed simply won't have one, and `threadsText` is null
 * for those; formatItemPost() falls back to the trimmed commentary.
 *
 * Returns [] if the TOP3 marker or fewer than 3 matching SEG blocks are found
 * — callers treat that as "can't build a chain," not a partial chain.
 */
export function parseTop3Items(content) {
  if (!content) return [];

  const top3Match = content.match(/<!--TOP3\s*\[([^\]]*)\]-->/);
  if (!top3Match) return [];

  const order = top3Match[1]
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (order.length === 0) return [];

  const segRe = /<!--SEG idx=(\d+) article_id="([^"]*)" headline="([^"]*)"-->\n([\s\S]*?)\n<!--\/SEG-->/g;
  const byIdx = new Map();
  let m;
  while ((m = segRe.exec(content)) !== null) {
    const [, idxStr, articleId, headline, body] = m;
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

    let link = null;
    if (lines.length > 0 && /^https?:\/\//.test(lines[lines.length - 1])) {
      link = lines.pop();
    }
    const commentary = lines.join(' ').replace(/^\d+\.\s*/, '').trim();

    byIdx.set(Number(idxStr), { idx: Number(idxStr), articleId, headline, commentary, link, threadsText: null });
  }

  const threadsRe = /<!--THREADS idx=(\d+) text="([^"]*)"-->/g;
  let tm;
  while ((tm = threadsRe.exec(content)) !== null) {
    const [, idxStr, text] = tm;
    const item = byIdx.get(Number(idxStr));
    if (item) item.threadsText = text.trim() || null;
  }

  const items = order.map((idx) => byIdx.get(idx)).filter(Boolean);
  return items.length === order.length ? items : [];
}

/** Word-boundary-aware trim to Threads' post character limit. */
export function trimToThreadsLimit(text, limit = THREADS_POST_LIMIT) {
  if (!text) return '';
  if (text.length <= limit) return text;

  const ellipsis = '…';
  const cut = text.slice(0, limit - ellipsis.length);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trimEnd() + ellipsis;
}

/**
 * Lead/reply post body: headline + a Threads-native take, no link (per §11.1).
 * Prefers the assembly-time <!--THREADS--> short take (written for this
 * medium, ~420 chars — see assembly_prompt.md §5) over the full commentary.
 * Falls back to trimming the full commentary for older digests assembled
 * before that field existed — trimToThreadsLimit() is still applied either
 * way as a hard safety net against a too-long THREADS take.
 */
export function formatItemPost(item) {
  const body = item.threadsText || item.commentary;
  return trimToThreadsLimit(`${item.headline}\n\n${body}`);
}

/** Closing reply body: "<linkText> <link>". */
export function formatClosingReply(canonicalLink, linkText) {
  const text = canonicalLink ? `${linkText} ${canonicalLink}` : linkText;
  return trimToThreadsLimit(text);
}

/**
 * Best available link for the closing reply, in priority order:
 * 1. THREADS_LINK_URL (manual override)
 * 2. config.siteUrl — not implemented yet (P3); reads as undefined until it ships,
 *    at which point this starts resolving automatically with no code change here.
 * 3. The Telegram channel link (current fallback).
 */
export function resolveCanonicalLink(config) {
  if (config?.threadsLinkUrl) return config.threadsLinkUrl;
  if (config?.siteUrl) return config.siteUrl;
  return TELEGRAM_CHANNEL_FALLBACK_LINK;
}

// Two-step Threads publish flow: create a container, then publish it (same
// shape as Instagram's Graph API container flow). Publishing a container
// before it reaches status FINISHED fails with an opaque "resource does not
// exist" error (confirmed against the real API 2026-07-27) — pollContainerStatus()
// below closes that gap.
async function createContainer(userId, accessToken, { text, replyToId }) {
  const url = `${THREADS_API_BASE}/${userId}/threads`;
  const body = { media_type: 'TEXT', text, access_token: accessToken };
  if (replyToId) body.reply_to_id = replyToId;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: `Network error creating Threads container: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Threads returned an unreadable response creating the post container.' };
  }

  if (!response.ok || data.error) {
    return { error: `Threads container error: ${data.error?.message || `HTTP ${response.status}`}` };
  }
  if (!data.id) {
    return { error: 'Threads did not return a container id.' };
  }
  return { containerId: data.id };
}

// Polls GET /{container-id}?fields=status,error_message until the container
// reports FINISHED (ready to publish), ERROR/EXPIRED (fail this step), or the
// attempt budget runs out (also a failure — never calls publish on an unknown
// state). Status values per Meta's docs: IN_PROGRESS, FINISHED, ERROR, EXPIRED,
// PUBLISHED.
export async function pollContainerStatus(accessToken, containerId, label, {
  maxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = `${THREADS_API_BASE}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(accessToken)}`;

    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      console.error(`[threads-publisher] [${label}] Network error polling container ${containerId} status (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      return { error: `Network error polling Threads container status: ${err.message}` };
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(`[threads-publisher] [${label}] Unreadable response polling container ${containerId} status (attempt ${attempt}/${maxAttempts})`);
      return { error: 'Threads returned an unreadable response polling container status.' };
    }

    if (!response.ok || data.error) {
      const msg = data.error?.message || `HTTP ${response.status}`;
      console.error(`[threads-publisher] [${label}] Container ${containerId} status check failed: ${msg}`);
      return { error: `Threads container status check failed: ${msg}` };
    }

    console.log(`[threads-publisher] [${label}] Container ${containerId} status (attempt ${attempt}/${maxAttempts}): ${data.status}`);

    if (data.status === 'FINISHED') {
      return { ready: true };
    }
    if (data.status === 'ERROR' || data.status === 'EXPIRED') {
      const detail = data.error_message ? ` (${data.error_message})` : '';
      return { error: `Threads container entered status ${data.status}${detail}` };
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  return { error: `Threads container ${containerId} did not reach FINISHED status after ${maxAttempts} polling attempts.` };
}

async function publishContainer(userId, accessToken, containerId) {
  const url = `${THREADS_API_BASE}/${userId}/threads_publish`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
    });
  } catch (err) {
    return { error: `Network error publishing Threads container: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Threads returned an unreadable response publishing the post.' };
  }

  if (!response.ok || data.error) {
    return { error: `Threads publish error: ${data.error?.message || `HTTP ${response.status}`}` };
  }
  if (!data.id) {
    return { error: 'Threads did not return a post id.' };
  }
  return { postId: data.id };
}

async function createAndPublishPost(userId, accessToken, { text, replyToId, label }, pollOptions) {
  console.log(`[threads-publisher] [${label}] Creating container${replyToId ? ` (reply to ${replyToId})` : ''}...`);
  const created = await createContainer(userId, accessToken, { text, replyToId });
  if (created.error) {
    console.error(`[threads-publisher] [${label}] Container create failed: ${created.error}`);
    return { error: created.error };
  }
  console.log(`[threads-publisher] [${label}] Container created: ${created.containerId} — polling status...`);

  const status = await pollContainerStatus(accessToken, created.containerId, label, pollOptions);
  if (status.error) {
    console.error(`[threads-publisher] [${label}] Container status poll failed: ${status.error}`);
    return { error: status.error };
  }

  console.log(`[threads-publisher] [${label}] Container ${created.containerId} ready — publishing...`);
  const published = await publishContainer(userId, accessToken, created.containerId);
  if (published.error) {
    console.error(`[threads-publisher] [${label}] Publish failed: ${published.error}`);
    return { error: published.error };
  }
  console.log(`[threads-publisher] [${label}] Published: ${published.postId}`);
  return { postId: published.postId };
}

/**
 * Publishes the digest's TOP3 items as a 4-post Threads reply chain: lead,
 * reply1 (→lead), reply2 (→reply1), closing link (→reply2).
 *
 * Stops at the first failure and returns however many post ids the chain
 * reached — never attempts a post whose parent didn't actually publish, so
 * there is no orphaned-reply case to clean up.
 *
 * @param {Object} [pollOptions] - Overrides for the container-status poll (maxAttempts, intervalMs). Tests shrink these to avoid real delays.
 * @returns {{ threadIds: string[], error?: string, failedAt?: string }}
 */
export async function publishThreadsChain(digest, config, pollOptions) {
  const userId = config.threadsUserId;
  const accessToken = resolveThreadsAccessToken(config);

  if (!userId || !accessToken) {
    const error = 'Threads user ID or access token is not configured (THREADS_USER_ID / THREADS_ACCESS_TOKEN in .env).';
    console.error(`[threads-publisher] ${error}`);
    return { threadIds: [], error };
  }

  const items = parseTop3Items(digest.content);
  if (items.length < 3) {
    const error = `Digest content is missing a full TOP3 set (found ${items.length}/3 items) — cannot build a Threads reply chain.`;
    console.error(`[threads-publisher] ${error}`);
    return { threadIds: [], error };
  }

  const canonicalLink = resolveCanonicalLink(config);
  const posts = [
    { label: 'lead', text: formatItemPost(items[0]) },
    { label: 'reply1', text: formatItemPost(items[1]) },
    { label: 'reply2', text: formatItemPost(items[2]) },
    { label: 'closing', text: formatClosingReply(canonicalLink, config.threadsLinkText) },
  ];

  console.log(`[threads-publisher] Starting chain for digest ${digest.id} (${posts.length} posts)`);

  const threadIds = [];
  let replyToId = null;

  for (const post of posts) {
    console.log(`[threads-publisher] Chain position: "${post.label}" (${threadIds.length + 1}/${posts.length})`);
    const result = await createAndPublishPost(userId, accessToken, { text: post.text, replyToId, label: post.label }, pollOptions);
    if (result.error) {
      const error = `Threads chain stopped at "${post.label}": ${result.error}`;
      console.error(`[threads-publisher] ${error}`);
      return { threadIds, error, failedAt: post.label };
    }
    threadIds.push(result.postId);
    replyToId = result.postId;
  }

  console.log(`[threads-publisher] Chain complete for digest ${digest.id}: ${threadIds.join(', ')}`);
  return { threadIds };
}
