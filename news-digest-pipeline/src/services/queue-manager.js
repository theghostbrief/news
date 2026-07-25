import { getReadyArticleCount, getDigestPromptState, setDigestPromptState } from '../db/index.js';
import { sendCompilePrompt } from './telegram-bot.js';

let running = false;

export async function processQueue(config) {
  if (running) {
    return;
  }

  running = true;

  try {
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
    if (readyCount - state.baseline >= config.articleThreshold) {
      await sendCompilePrompt(config, readyCount);
      setDigestPromptState({ pending: 1, baseline: readyCount });
    }
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
