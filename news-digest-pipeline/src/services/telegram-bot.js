import { insertArticle, getArticleCount, getReadyArticleCount, getFetchingArticleCount } from '../db/index.js';
import { validateArticleUrl, allowedDomainsForDisplay } from './url-validator.js';

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

const COMPILE_CALLBACK_DATA = 'compile_digest';
const KEEP_ADDING_CALLBACK_DATA = 'keep_adding';

/**
 * Send a message via Telegram Bot API using fetch.
 */
async function sendMessage(botToken, chatId, text, extra = {}) {
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
    console.error(`[telegram-bot] sendMessage failed: ${resp.status} ${body}`);
    return null;
  }

  const data = await resp.json();
  return data.result || null;
}

/**
 * Acknowledge a callback query so Telegram stops the button's loading spinner.
 */
async function answerCallbackQuery(botToken, callbackQueryId, text) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[telegram-bot] answerCallbackQuery failed: ${resp.status} ${body}`);
  }
}

/**
 * Register webhook URL with Telegram.
 */
async function setWebhook(botToken, webhookUrl, secretToken) {
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
    console.log(`[telegram-bot] Webhook set: ${webhookUrl}`);
  } else {
    console.error(`[telegram-bot] Failed to set webhook:`, data);
  }
  return data;
}

/**
 * Send the interactive "compile now or keep adding?" prompt. Called by
 * queue-manager.js once ready-article count crosses a batch threshold.
 */
export async function sendCompilePrompt(config, readyCount) {
  const text = [
    `📝 <b>${readyCount} articles ready</b> for a digest.`,
    '',
    'Compile now, or keep adding?',
  ].join('\n');

  await sendMessage(config.telegramBotToken, config.telegramChatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '📝 Compile digest', callback_data: COMPILE_CALLBACK_DATA },
        { text: '➕ Keep adding', callback_data: KEEP_ADDING_CALLBACK_DATA },
      ]],
    },
  });
}

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
async function handleUrls(botToken, chatId, messageId, text) {
  const urls = text.match(URL_REGEX);

  if (!urls || urls.length === 0) {
    await sendMessage(botToken, chatId, '⚠️ No links found in the message.');
    return;
  }

  // Deduplicate URLs within the same message
  const uniqueUrls = [...new Set(urls)];

  // Filter + normalize via the shared article-URL contract (HTTPS +
  // perplexity.ai + no control chars). Store only the normalized href.
  const validUrls = [];
  for (const u of uniqueUrls) {
    const v = validateArticleUrl(u);
    if (v.ok) validUrls.push(v.href);
  }

  const rejected = uniqueUrls.length - validUrls.length;
  if (validUrls.length === 0) {
    let reply = `⚠️ No valid links found (accepted: ${allowedDomainsForDisplay().join(', ')}).`;
    if (rejected > 0) reply += `\nRejected: ${rejected}`;
    await sendMessage(botToken, chatId, reply);
    return;
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

  // Ready vs fetching are shown separately rather than collapsed into one
  // number: right after a save, a just-added article is real (saved) but its
  // content hasn't been fetched yet, so it wouldn't count as ready — showing
  // only the readiness count made a successful save look like "Total new: 0".
  const readyCount = getReadyArticleCount();
  const fetchingCount = getFetchingArticleCount();

  let reply = `Saved: ${saved} | Ready: ${readyCount} | Fetching: ${fetchingCount}`;
  if (duplicates > 0) {
    reply += ` | Duplicates: ${duplicates}`;
  }
  if (rejected > 0) {
    reply += ` | Rejected: ${rejected}`;
  }

  await sendMessage(botToken, chatId, reply);
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
  await handleUrls(botToken, chatId, message.message_id, text);
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
