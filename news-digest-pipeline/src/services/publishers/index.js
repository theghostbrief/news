import { publishToFacebook } from './facebook.js';
import { publishToTelegram } from './telegram.js';
import { publishToYouTube } from './youtube.js';
import { updateDigest } from '../../db/index.js';

/**
 * Publish a digest to selected platforms.
 *
 * @param {Object} digest     - Digest record from DB (must have id and content)
 * @param {Object} config     - App config object
 * @param {string[]} platforms - Optional: ["telegram", "facebook", "youtube"]. If omitted, publishes to all enabled.
 * @returns {{ facebook, telegram, youtube }} results per platform (or null if skipped)
 */
export async function publishDigest(digest, config, platforms) {
  const all = !platforms || !Array.isArray(platforms) || platforms.length === 0;
  const shouldPublish = (name) => all || platforms.includes(name);

  const results = {
    facebook: null,
    telegram: null,
    youtube: null,
  };

  const updateFields = {};

  // Facebook — a Facebook outage/token failure must never crash the rest of
  // the run (Telegram, etc.), so this is wrapped defensively even though
  // publishToFacebook() already catches its own network/parse errors.
  if (shouldPublish('facebook') && config.facebookPageAccessToken && config.facebookPageId) {
    try {
      results.facebook = await publishToFacebook(
        config.facebookPageAccessToken,
        config.facebookPageId,
        digest.content,
      );
    } catch (err) {
      console.error('[publishers] Unexpected Facebook publish error:', err.message);
      results.facebook = { error: `Unexpected error: ${err.message}` };
    }

    if (results.facebook?.postId) {
      updateFields.facebook_post_id = results.facebook.postId;
      updateFields.facebook_status = 'published';
      updateFields.facebook_error = null;
    } else {
      updateFields.facebook_status = 'failed';
      updateFields.facebook_error = results.facebook?.error || 'Unknown Facebook publish failure';
    }
  }

  // Telegram (publish to channel, not personal chat)
  if (shouldPublish('telegram')) {
    const tgPublishChat = config.telegramPublishChatId || config.telegramChatId;
    if (config.telegramBotToken && tgPublishChat) {
      results.telegram = await publishToTelegram(
        config.telegramBotToken,
        tgPublishChat,
        digest.content,
      );
      if (results.telegram?.messageId) {
        updateFields.telegram_message_id = String(results.telegram.messageId);
      }
    }
  }

  // YouTube (placeholder)
  if (shouldPublish('youtube') && config.youtubeAccessToken && config.youtubeChannelId) {
    results.youtube = await publishToYouTube(
      config.youtubeAccessToken,
      config.youtubeChannelId,
      digest.content,
    );
    if (results.youtube?.postId) {
      updateFields.youtube_post_id = results.youtube.postId;
    }
  }

  // A genuine success (not just facebook_status/facebook_error bookkeeping)
  // is what flips the digest to 'published' — a Facebook failure alone must
  // not mark the digest as published.
  const hasGenuineSuccess = Boolean(
    updateFields.facebook_post_id || updateFields.telegram_message_id || updateFields.youtube_post_id
  );
  if (hasGenuineSuccess) {
    updateFields.status = 'published';
    updateFields.published_at = new Date().toISOString();
  }

  // Persist whatever we have — including a Facebook failure alone — so the
  // digest row always reflects the true per-platform outcome.
  if (Object.keys(updateFields).length > 0) {
    updateDigest(digest.id, updateFields);
  }

  return results;
}
