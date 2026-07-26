import { insertArticle, getArticleCount, getReadyArticleCount, getFetchingArticleCount } from '../db/index.js';
import { validateArticleUrl } from './url-validator.js';
import { sendTelegramMessage as sendMessage, answerCallbackQuery, setTelegramWebhook as setWebhook } from './telegram-api.js';
import { COMPILE_CALLBACK_DATA, KEEP_ADDING_CALLBACK_DATA } from './compile-prompt.js';
import { triggerFetch } from './content-fetcher.js';
import { formatStatusReply, recordStatusMessage } from './status-updater.js';

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// A message with exactly one URL and at least this much leftover text (after
// stripping the URL and trimming) is treated as manually-pasted content
// rather than a bare link to fetch — see handleUrls().
const MANUAL_CONTENT_MIN_CHARS = 40;

/**
 * Handle /status command.
 */
async function handleStatus(botToken, chatId) {
  const readyCount = getReadyArticleCount();
  const processingCount = getArticleCount('processing');
  const usedCount = getArticleCount('used');
  const totalCount = getArticleCount();

  const text = [
    '<b>📊 Status</b>',
    '',
    `New (ready): ${readyCount}`,
    `Processing: ${processingCount}`,
    `Used: ${usedCount}`,
    `Total: ${totalCount}`,
  ].join('\n');

  await sendMessage(botToken, chatId, text);
}

/**
 * Compile all currently-ready articles into a digest. Shared by the
 * "Compile digest" inline-keyboard button and the /compile command — same
 * readiness definition (getNewArticles), same never-compile-empty guard.
 * On completion (success, failure, or nothing to compile) resets the prompt
 * baseline to the current ready count, so the next prompt is counted from
 * here rather than from wherever the last prompt was sent.
 */
async function handleCompileDigest(botToken, chatId, config) {
  const { getNewArticles, getDb, setDigestPromptState } = await import('../db/index.js');
  const { generateDigest } = await import('./digest-generator.js');

  const count = getReadyArticleCount();

  if (count === 0) {
    await sendMessage(botToken, chatId, '⚠️ No ready articles to compile — nothing to do.');
    setDigestPromptState({ pending: 0, baseline: getReadyArticleCount() });
    return;
  }

  await sendMessage(botToken, chatId, `⏳ Compiling a digest from ${count} ready articles...`);

  try {
    const limit = Math.min(count, config.maxArticlesPerDigest);
    // Readiness-filtered (status='new', content fetched) — freshly queried
    // right now, so anything that finished fetching while the prompt was
    // awaiting a decision is included too.
    const articles = getNewArticles(limit);
    const db = getDb();

    const digestId = await generateDigest(db, articles, config);
    await sendMessage(botToken, chatId, `✅ Digest compiled (${articles.length} articles). ID: ${digestId}`);

    if (config.ntfyTopic) {
      const { getDigest } = await import('../db/index.js');
      const { notifyDigestReady } = await import('./notifier.js');
      await notifyDigestReady(config.ntfyTopic, getDigest(digestId));
    }
  } catch (err) {
    console.error('[telegram-bot] Compile error:', err);
    await sendMessage(botToken, chatId, `❌ Compile error: ${err.message}`);
  } finally {
    // Compiled articles are no longer 'new', so getReadyArticleCount() here
    // reflects only whatever arrived (and finished fetching) during the call.
    setDigestPromptState({ pending: 0, baseline: getReadyArticleCount() });
  }
}

/**
 * "Keep adding" — dismiss the current prompt without compiling. The prompt
 * baseline is left untouched (it was already set to the ready count at send
 * time), so the next prompt fires once another batch of 10 accumulates from
 * there.
 */
async function handleKeepAdding(botToken, chatId) {
  const { setDigestPromptState } = await import('../db/index.js');
  setDigestPromptState({ pending: 0 });
  await sendMessage(botToken, chatId, "👍 Keeping the queue open — I'll ask again once 10 more articles are ready.");
}

/**
 * Delete a message via Telegram Bot API. Returns true on success.
 * In private chats the bot can only delete its own messages; in groups/channels
 * it needs admin rights with can_delete_messages.
 */
export async function deleteTelegramMessage(botToken, chatId, messageId) {
  const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const data = await resp.json();
  return !!data.ok;
}

/**
 * Handle incoming message with URLs.
 */
async function handleUrls(botToken, chatId, messageId, text, config) {
  const urls = text.match(URL_REGEX);

  if (!urls || urls.length === 0) {
    await sendMessage(botToken, chatId, '⚠️ No links found in the message.');
    return;
  }

  // Deduplicate URLs within the same message
  const uniqueUrls = [...new Set(urls)];

  // Filter + normalize via the shared article-URL contract (HTTPS, well-formed,
  // no control chars — no source domain restriction). Store only the
  // normalized href.
  const validUrls = [];
  for (const u of uniqueUrls) {
    const v = validateArticleUrl(u);
    if (v.ok) validUrls.push(v.href);
  }

  const rejected = uniqueUrls.length - validUrls.length;
  if (validUrls.length === 0) {
    let reply = '⚠️ No valid links found — check the URL format (must be HTTPS).';
    if (rejected > 1) reply += `\nRejected: ${rejected}`;
    await sendMessage(botToken, chatId, reply);
    return;
  }

  // Manual-content mode: exactly one URL, plus enough surrounding text that
  // it reads as pasted article content rather than a caption. Store the text
  // directly as content (same "content present -> status='new', immediately
  // ready" contract PATCH /api/articles/:id uses to accept manually-pasted
  // content for fetch_failed articles) — no fetch, no triggerFetch, and no
  // silent loss of what was typed. Title stays empty, same as the fetch path;
  // digest-generator.js already tolerates that.
  if (uniqueUrls.length === 1 && validUrls.length === 1) {
    const leftoverText = text.replace(uniqueUrls[0], '').trim();
    if (leftoverText.length >= MANUAL_CONTENT_MIN_CHARS) {
      const result = insertArticle({
        url: validUrls[0],
        title: '',
        content: leftoverText,
        source: 'telegram',
        sourceChatId: String(chatId),
        sourceMessageId: messageId != null ? String(messageId) : null,
      });

      const readyCount = getReadyArticleCount();
      const reply = result.duplicate
        ? `⚠️ Already saved (duplicate) — manual content not stored.\nReady: ${readyCount}`
        : `Saved (manual content): 1 | Ready: ${readyCount}`;

      // Not recorded as the live-edit target: there's no fetch in flight for
      // this save, so nothing would ever update it — and a later edit from
      // an unrelated fetch would overwrite this message with the generic
      // "Saved | Ready | Fetching" format, erasing the "(manual content)"
      // label that's the whole point of this reply.
      await sendMessage(botToken, chatId, reply);
      return;
    }
  }

  let saved = 0;
  let duplicates = 0;

  for (const url of validUrls) {
    const result = insertArticle({
      url,
      title: '',
      content: '',
      source: 'telegram',
      sourceChatId: String(chatId),
      sourceMessageId: messageId != null ? String(messageId) : null,
    });

    if (result.duplicate) {
      duplicates++;
    } else {
      saved++;
    }
  }

  // Ask content-fetcher to fetch the new saves right away instead of
  // waiting for its own interval tick — debounced, so a burst of links (or
  // several messages in a row) collapses into one triggered pass.
  if (saved > 0) {
    triggerFetch(config);
  }

  // Ready vs fetching are shown separately rather than collapsed into one
  // number: right after a save, a just-added article is real (saved) but its
  // content hasn't been fetched yet, so it wouldn't count as ready — showing
  // only the readiness count made a successful save look like "Total new: 0".
  // This reply is necessarily a snapshot taken before the just-triggered
  // fetch can finish — status-updater.js live-edits it in place as each
  // article actually completes, so the number doesn't just sit stale.
  const readyCount = getReadyArticleCount();
  const fetchingCount = getFetchingArticleCount();
  const reply = formatStatusReply({ saved, duplicates, rejected, readyCount, fetchingCount });

  const sent = await sendMessage(botToken, chatId, reply);
  if (sent?.message_id) {
    recordStatusMessage(chatId, sent.message_id, { saved, duplicates, rejected });
  }
}

/**
 * Handle a callback_query update — the "Compile digest" / "Keep adding"
 * inline-keyboard buttons on the readiness prompt.
 */
async function handleCallbackQuery(callbackQuery, config) {
  const botToken = config.telegramBotToken;
  const chatId = String(callbackQuery.message?.chat?.id || '');
  const allowedChatId = String(config.telegramChatId);

  // Always acknowledge, even for a rejected chat — otherwise the button spins
  // forever on the sender's end.
  await answerCallbackQuery(botToken, callbackQuery.id);

  if (chatId !== allowedChatId) {
    console.warn(`[telegram-bot] Rejected callback_query from chat_id=${chatId} (allowed: ${allowedChatId})`);
    return;
  }

  if (callbackQuery.data === COMPILE_CALLBACK_DATA) {
    await handleCompileDigest(botToken, chatId, config);
  } else if (callbackQuery.data === KEEP_ADDING_CALLBACK_DATA) {
    await handleKeepAdding(botToken, chatId);
  }
}

/**
 * Process a single Telegram update object.
 */
export async function handleTelegramUpdate(update, config) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, config);
    return;
  }

  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const allowedChatId = String(config.telegramChatId);
  const botToken = config.telegramBotToken;

  // Security: only accept messages from the configured chat
  if (chatId !== allowedChatId) {
    console.warn(`[telegram-bot] Rejected message from chat_id=${chatId} (allowed: ${allowedChatId})`);
    return;
  }

  const text = message.text || '';

  // Handle commands
  if (text.startsWith('/status')) {
    await handleStatus(botToken, chatId);
    return;
  }

  if (text.startsWith('/compile') || text.startsWith('/generate')) {
    await handleCompileDigest(botToken, chatId, config);
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    const helpText = [
      '<b>News Digest Bot</b>',
      '',
      'Send a link — it will be saved for the digest.',
      "Once 10 articles are ready, I'll ask whether to compile a digest.",
      '',
      '/status — article count',
      '/compile — compile all ready articles into a digest now',
    ].join('\n');
    await sendMessage(botToken, chatId, helpText);
    return;
  }

  // Otherwise try to extract URLs
  await handleUrls(botToken, chatId, message.message_id, text, config);
}

/**
 * Setup Telegram bot: register webhook with Telegram API.
 */
export async function setupTelegramBot(config) {
  if (!config.telegramBotToken) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN not set, skipping webhook setup');
    return;
  }

  if (!config.baseUrl) {
    console.warn('[telegram-bot] BASE_URL not set, skipping webhook setup');
    return;
  }

  const webhookUrl = `${config.baseUrl}/api/telegram/webhook`;
  await setWebhook(config.telegramBotToken, webhookUrl, config.telegramWebhookSecret);
}
