import { Router } from 'express';
import { handleTelegramUpdate } from '../services/telegram-bot.js';
import config from '../config.js';

const router = Router();

router.post('/webhook', (req, res) => {
  // Fail CLOSED: without a configured secret we cannot authenticate Telegram, so
  // reject rather than accept forged updates that could trigger paid generation.
  // (Previously the check was skipped when the secret was absent — fail-open.)
  if (!config.telegramWebhookSecret) {
    console.warn('[telegram] TELEGRAM_WEBHOOK_SECRET not set — rejecting webhook (fail-closed)');
    return res.sendStatus(403);
  }
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== config.telegramWebhookSecret) {
    console.warn('[telegram] Invalid secret token in webhook request');
    return res.sendStatus(403);
  }

  // Respond immediately (Telegram requires fast response)
  res.sendStatus(200);

  // Process update asynchronously
  const update = req.body;
  handleTelegramUpdate(update, config).catch((err) => {
    console.error('[telegram] Error handling update:', err);
  });
});

export default router;
