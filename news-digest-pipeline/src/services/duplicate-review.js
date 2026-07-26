import { sendTelegramMessage } from './telegram-api.js';
import { getDuplicateReview, setDuplicateReview, getArticlesByIds } from '../db/index.js';

export const DUP_CALLBACK_PREFIX = 'dup:';

function shortLabel(article) {
  const title = (article.title || '').trim();
  if (title) return title.length > 80 ? `${title.slice(0, 77)}...` : title;
  return article.url;
}

/**
 * Whether a duplicate review is already in progress. A fresh compile action
 * must refuse to start a second one on top rather than clobbering it.
 */
export function isDuplicateReviewActive() {
  return getDuplicateReview().active;
}

/**
 * Persist the review state and send one Telegram message per suspected
 * group, each with inline buttons to pick which article(s) to keep. Compile
 * is paused (the caller must not call generateDigest yet) until every group
 * is resolved via resolveDuplicateCallback().
 *
 * @param {string} botToken
 * @param {string} chatId
 * @param {Array<{id,url,title}>} allArticles - the full ready-set for this compile attempt
 * @param {Array<Array<{id,url,title}>>} groups - suspected-duplicate clusters from findDuplicateGroups()
 */
export async function startDuplicateReview(botToken, chatId, allArticles, groups) {
  setDuplicateReview({
    active: true,
    chatId,
    candidateArticleIds: allArticles.map((a) => a.id),
    groups: groups.map((g) => ({ articleIds: g.map((a) => a.id), keepArticleIds: null })),
  });

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const lines = [
      `🔎 <b>Possible duplicate story</b>${groups.length > 1 ? ` (group ${groupIdx + 1} of ${groups.length})` : ''}:`,
      '',
      ...group.map((a, i) => `${i + 1}. ${shortLabel(a)}\n${a.url}`),
      '',
      'Nothing is dropped automatically — pick which should stay in this digest.',
    ];

    const keepButtons = group.map((a, i) => ({
      text: `Keep #${i + 1}`,
      callback_data: `${DUP_CALLBACK_PREFIX}${groupIdx}:${i}`,
    }));
    const keepAllButton = {
      text: group.length > 2 ? 'Keep all' : 'Keep both',
      callback_data: `${DUP_CALLBACK_PREFIX}${groupIdx}:all`,
    };

    await sendTelegramMessage(botToken, chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: [keepButtons, [keepAllButton]] },
    });
  }
}

/**
 * Process a "dup:<groupIndex>:<choice>" callback (choice is either an index
 * into that group's articles, or "all").
 *
 * @returns {{resolved: true, finalArticles: Array}
 *         | {resolved: false}
 *         | {resolved: null}} null means the callback didn't match an active
 *   review (e.g. a stale button from an already-completed one) — safe to
 *   ignore. finalArticles never omits an article the user didn't explicitly
 *   choose to drop for THIS digest; excluded articles stay 'new'/ready in the
 *   DB and can appear in a future compile — nothing is deleted.
 */
export function resolveDuplicateCallback(callbackData) {
  const review = getDuplicateReview();
  if (!review.active) return { resolved: null };

  const [, groupIdxRaw, choice] = callbackData.split(':');
  const groupIdx = parseInt(groupIdxRaw, 10);
  const group = review.groups[groupIdx];
  if (!group) return { resolved: null };

  group.keepArticleIds = choice === 'all' ? group.articleIds : [group.articleIds[parseInt(choice, 10)]];

  const stillPending = review.groups.some((g) => g.keepArticleIds === null);
  if (stillPending) {
    setDuplicateReview(review);
    return { resolved: false };
  }

  const excluded = new Set();
  for (const g of review.groups) {
    for (const id of g.articleIds) {
      if (!g.keepArticleIds.includes(id)) excluded.add(id);
    }
  }
  const finalArticleIds = review.candidateArticleIds.filter((id) => !excluded.has(id));

  setDuplicateReview({ active: false, chatId: null, candidateArticleIds: [], groups: [] });

  return { resolved: true, finalArticles: getArticlesByIds(finalArticleIds) };
}
