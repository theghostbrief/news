// ─────────────────────────────────────────────────────────────────────────────
// Low-level Telegram Bot API HTTP calls — no business logic, no imports from
// other local services. Kept as a leaf module deliberately: telegram-bot.js,
// compile-prompt.js, and content-fetcher.js/queue-manager.js all need to send
// Telegram messages, and none of them should have to import telegram-bot.js
// (which itself needs to trigger content-fetcher and read the compile-prompt
// constants) just to get an HTTP helper — that's exactly the shape of a
// circular import.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a message via Telegram Bot API using fetch.
 */
export async function sendTelegramMessage(botToken, chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[telegram-api] sendMessage failed: ${resp.status} ${body}`);
    return null;
  }

  const data = await resp.json();
  return data.result || null;
}

/**
 * Edit an already-sent message's text in place.
 */
export async function editMessageText(botToken, chatId, messageId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // Telegram 400s with "message is not modified" when the new text is
    // identical to what's already there (e.g. a failure right after a success
    // left the counts unchanged) — expected, not a real failure.
    if (!body.includes('message is not modified')) {
      console.error(`[telegram-api] editMessageText failed: ${resp.status} ${body}`);
    }
    return null;
  }

  const data = await resp.json();
  return data.result || null;
}

/**
 * Acknowledge a callback query so Telegram stops the button's loading spinner.
 */
export async function answerCallbackQuery(botToken, callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[telegram-api] answerCallbackQuery failed: ${resp.status} ${body}`);
  }
}

/**
 * Register webhook URL with Telegram.
 */
export async function setTelegramWebhook(botToken, webhookUrl, secretToken) {
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      // callback_query is required for the "Compile digest" / "Keep adding"
      // inline-keyboard buttons to reach the webhook.
      allowed_updates: ['message', 'callback_query'],
    }),
  });

  const data = await resp.json();
  if (data.ok) {
    console.log(`[telegram-api] Webhook set: ${webhookUrl}`);
  } else {
    console.error(`[telegram-api] Failed to set webhook:`, data);
  }
  return data;
}
