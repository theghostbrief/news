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

// Static fallback until the site URL (P3) ships — see resolveCanonicalLink().
const TELEGRAM_CHANNEL_FALLBACK_LINK = 't.me/theghostbrief';

/**
 * Parses the TOP3 marker and its 3 referenced SEG blocks out of assembled
 * digest content, in TOP3 order (the array order is "ranked by nothing in
 * particular" per assembly_prompt.md — n1 is simply the lead post, n2/n3 the
 * two replies).
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

    byIdx.set(Number(idxStr), { idx: Number(idxStr), articleId, headline, commentary, link });
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

/** Lead/reply post body: headline + commentary, no link (per §11.1). */
export function formatItemPost(item) {
  return trimToThreadsLimit(`${item.headline}\n\n${item.commentary}`);
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
// shape as Instagram's Graph API container flow). NOTE for the live-test
// pass: some container flows in this API family need a brief status poll
// (CONTAINER STATUS = FINISHED) before publish will succeed — not implemented
// here since it's unverified against the real API; add if the live test hits it.
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

async function createAndPublishPost(userId, accessToken, { text, replyToId }) {
  const created = await createContainer(userId, accessToken, { text, replyToId });
  if (created.error) return { error: created.error };
  return publishContainer(userId, accessToken, created.containerId);
}

/**
 * Publishes the digest's TOP3 items as a 4-post Threads reply chain: lead,
 * reply1 (→lead), reply2 (→reply1), closing link (→reply2).
 *
 * Stops at the first failure and returns however many post ids the chain
 * reached — never attempts a post whose parent didn't actually publish, so
 * there is no orphaned-reply case to clean up.
 *
 * @returns {{ threadIds: string[], error?: string, failedAt?: string }}
 */
export async function publishThreadsChain(digest, config) {
  const userId = config.threadsUserId;
  const accessToken = resolveThreadsAccessToken(config);

  if (!userId || !accessToken) {
    return {
      threadIds: [],
      error: 'Threads user ID or access token is not configured (THREADS_USER_ID / THREADS_ACCESS_TOKEN in .env).',
    };
  }

  const items = parseTop3Items(digest.content);
  if (items.length < 3) {
    return {
      threadIds: [],
      error: `Digest content is missing a full TOP3 set (found ${items.length}/3 items) — cannot build a Threads reply chain.`,
    };
  }

  const canonicalLink = resolveCanonicalLink(config);
  const posts = [
    { label: 'lead', text: formatItemPost(items[0]) },
    { label: 'reply1', text: formatItemPost(items[1]) },
    { label: 'reply2', text: formatItemPost(items[2]) },
    { label: 'closing', text: formatClosingReply(canonicalLink, config.threadsLinkText) },
  ];

  const threadIds = [];
  let replyToId = null;

  for (const post of posts) {
    const result = await createAndPublishPost(userId, accessToken, { text: post.text, replyToId });
    if (result.error) {
      return { threadIds, error: `Threads chain stopped at "${post.label}": ${result.error}`, failedAt: post.label };
    }
    threadIds.push(result.postId);
    replyToId = result.postId;
  }

  return { threadIds };
}
