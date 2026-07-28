import { editMessageText } from './telegram-api.js';
import { getReadyArticleCount, getFetchingArticleCount, getRetryingArticleCount } from '../db/index.js';

// Coalesce a burst of fetch completions into one edit per window, so a batch
// of articles landing close together can't trip Telegram's rate limit.
const EDIT_DEBOUNCE_MS = 1000;

// The most recent "Saved | Ready | Fetching" reply, kept live-updated as
// fetches complete. Only ever one target — a later save's reply replaces it,
// same "most recent wins" shape as the compile-prompt state.
let lastStatusMessage = null; // { chatId, messageId, saved, duplicates, rejected }
let editTimer = null;
let pendingConfig = null;

/**
 * Build the status reply text. Shared by the initial send (telegram-bot.js)
 * and every later live edit, so the two can never drift out of format.
 */
export function formatStatusReply({ saved, duplicates, rejected, readyCount, fetchingCount, retryingCount }) {
  // Retrying shown unconditionally, same as Ready/Fetching — a Jina-blocked
  // article must never look like it silently vanished from both of those.
  let text = `Saved: ${saved} | Ready: ${readyCount} | Fetching: ${fetchingCount} | Retrying: ${retryingCount ?? 0}`;
  if (duplicates > 0) text += ` | Duplicates: ${duplicates}`;
  if (rejected > 0) text += ` | Rejected: ${rejected}`;
  return text;
}

/**
 * Remember which message to keep live-updating, plus the fixed parts of its
 * text (saved/duplicates/rejected) that a later edit must preserve — only
 * Ready/Fetching get recomputed per edit.
 */
export function recordStatusMessage(chatId, messageId, { saved, duplicates, rejected }) {
  lastStatusMessage = { chatId, messageId, saved, duplicates, rejected };
}

async function flushStatusUpdate() {
  editTimer = null;
  const target = lastStatusMessage;
  const config = pendingConfig;
  pendingConfig = null;
  if (!target || !config) return;

  const readyCount = getReadyArticleCount();
  const fetchingCount = getFetchingArticleCount();
  const retryingCount = getRetryingArticleCount();
  const text = formatStatusReply({ ...target, readyCount, fetchingCount, retryingCount });
  await editMessageText(config.telegramBotToken, target.chatId, target.messageId, text);
}

/**
 * Request a debounced live update of the last status message's Ready/Fetching
 * counts. Called after every fetch completion — success or failure alike, so
 * a fetch_failed article visibly leaves "Fetching" instead of just vanishing
 * — so the user watches the numbers move without sending anything else.
 * No-ops if no status message has been recorded yet (e.g. a background
 * interval tick processing articles saved before this process started).
 */
export function scheduleStatusUpdate(config) {
  if (!lastStatusMessage) return;
  pendingConfig = config;
  if (editTimer) return;
  editTimer = setTimeout(() => {
    flushStatusUpdate().catch((err) => {
      console.error('[status-updater] Failed to update status message:', err.message);
    });
  }, EDIT_DEBOUNCE_MS);
}
