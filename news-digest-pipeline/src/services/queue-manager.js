import { getReadyArticleCount, getDigestPromptState, setDigestPromptState } from '../db/index.js';
import { sendCompilePrompt } from './compile-prompt.js';

/**
 * Check readiness and send the compile prompt if the threshold is crossed.
 * Called both by the interval loop below AND reactively by content-fetcher.js
 * right after an article becomes ready, so the prompt doesn't wait on the
 * next timer tick (or a further incoming message) to appear.
 *
 * The pending-state claim (setDigestPromptState) happens BEFORE the awaited
 * sendCompilePrompt call, not after — the read-check-claim sequence above it
 * is entirely synchronous (better-sqlite3 is sync), so nothing can interleave
 * between "is a prompt already pending?" and "claim the slot". Without this
 * ordering, two overlapping callers (e.g. the interval tick firing at the
 * same moment content-fetcher finishes an article) could both read
 * pending=0 before either finished awaiting the network call, and send two
 * prompts.
 */
export async function checkReadyAndPrompt(config) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    // Nothing to prompt into — no auto-generation fallback by design (that's
    // exactly the race this replaced).
    return;
  }

  const state = getDigestPromptState();
  if (state.pending) {
    // Already have an outstanding prompt awaiting a decision — don't re-send.
    return;
  }

  const readyCount = getReadyArticleCount();
  if (readyCount - state.baseline < config.articleThreshold) {
    return;
  }

  setDigestPromptState({ pending: 1, baseline: readyCount });
  await sendCompilePrompt(config, readyCount);
}

let running = false;

export async function processQueue(config) {
  if (running) {
    return;
  }

  running = true;

  try {
    await checkReadyAndPrompt(config);
  } catch (err) {
    console.error('[queue-manager] Error checking readiness:', err.message);
  } finally {
    running = false;
  }
}

export function startQueueManager(config) {
  console.log(
    `[queue-manager] Started (interval: ${config.checkIntervalMs}ms, prompt batch size: ${config.articleThreshold} ready articles)`
  );

  const intervalId = setInterval(() => processQueue(config), config.checkIntervalMs);

  // Run once immediately
  processQueue(config);

  return intervalId;
}
