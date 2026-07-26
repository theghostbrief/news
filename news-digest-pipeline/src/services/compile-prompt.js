import { sendTelegramMessage } from './telegram-api.js';

export const COMPILE_CALLBACK_DATA = 'compile_digest';
export const KEEP_ADDING_CALLBACK_DATA = 'keep_adding';

/**
 * Send the interactive "compile now or keep adding?" prompt. Called by
 * queue-manager.js's checkReadyAndPrompt() once ready-article count crosses
 * a batch threshold — both from the interval loop and reactively from
 * content-fetcher.js right after an article becomes ready.
 */
export async function sendCompilePrompt(config, readyCount) {
  const text = [
    `📝 <b>${readyCount} articles ready</b> for a digest.`,
    '',
    'Compile now, or keep adding?',
  ].join('\n');

  await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '📝 Compile digest', callback_data: COMPILE_CALLBACK_DATA },
        { text: '➕ Keep adding', callback_data: KEEP_ADDING_CALLBACK_DATA },
      ]],
    },
  });
}
