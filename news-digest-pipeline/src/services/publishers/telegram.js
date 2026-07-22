/**
 * Telegram publisher.
 * Sends content to a Telegram chat/channel via Bot API.
 * Splits long messages at item boundaries (max 4096 chars per message).
 */
import { stripDigestMarkers } from '../digest-format.js';

const TG_MAX_LENGTH = 4096;
const INTER_MESSAGE_DELAY = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split digest text into chunks that fit Telegram's 4096 char limit.
 * Splits at numbered item boundaries (e.g. "\n\n2. ") to keep items intact.
 */
function splitMessage(text) {
  if (text.length <= TG_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > TG_MAX_LENGTH) {
    let cutAt = -1;

    // Find the last item boundary within the limit
    // Look for patterns like "\n\n5. " or "\n\n12. "
    const searchArea = remaining.slice(0, TG_MAX_LENGTH);
    const itemPattern = /\n\n\d+\.\s/g;
    let match;
    while ((match = itemPattern.exec(searchArea)) !== null) {
      cutAt = match.index;
    }

    // Fallback: split at last double newline
    if (cutAt <= 0) {
      const lastBreak = searchArea.lastIndexOf('\n\n');
      if (lastBreak > 0) cutAt = lastBreak;
    }

    // Last resort: hard cut
    if (cutAt <= 0) cutAt = TG_MAX_LENGTH;

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// Returns { messageId } on success, { error } on failure — never throws a raw
// JSON.parse error up to the caller (same class of bug as the Facebook
// publisher's "Unexpected non-whitespace character after JSON", 2026-07-22:
// a non-JSON response body must produce a readable error, not an exception).
async function sendOne(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[telegram] Network error:', err.message);
    return { error: `Network error contacting Telegram: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[telegram] Non-JSON response:', raw.slice(0, 500));
    return { error: 'Telegram returned an unreadable response — the bot token is likely missing or invalid.' };
  }

  if (!data.ok) {
    console.error('[telegram] API error:', data.description || JSON.stringify(data));
    return { error: `Telegram API error: ${data.description || 'unknown error'}` };
  }

  return { messageId: data.result.message_id };
}

export async function publishToTelegram(botToken, chatId, content) {
  if (!botToken || !chatId) {
    console.error('[telegram] Missing botToken or chatId');
    return { error: 'Telegram bot token or chat ID is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_PUBLISH_CHAT_ID in .env).' };
  }

  try {
    const clean = stripDigestMarkers(content);
    const chunks = splitMessage(clean);
    console.log(`[telegram] Sending ${chunks.length} message(s) to ${chatId}`);

    const messageIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const result = await sendOne(botToken, chatId, chunks[i]);
      if (result.error) return { error: result.error };
      messageIds.push(result.messageId);
      if (i < chunks.length - 1) await sleep(INTER_MESSAGE_DELAY);
    }

    if (messageIds.length === 0) return { error: 'No messages were sent.' };

    return { messageId: messageIds[0], totalMessages: messageIds.length };
  } catch (err) {
    console.error('[telegram] Error publishing:', err.message);
    return { error: err.message };
  }
}
