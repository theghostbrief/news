import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenvConfig();

const __dirname = dirname(fileURLToPath(import.meta.url));
const parentDir = join(__dirname, '..');  // news-digest-pipeline root
const newsRoot = join(parentDir, '..');   // News/ directory with prompt files

// Docker mounts prompts at /app/prompts/; locally they live in the parent News/ dir
const dockerPromptsDir = '/app/prompts';
const promptsDir = existsSync(join(dockerPromptsDir, 'prompt.md'))
  ? dockerPromptsDir
  : newsRoot;

// Absolute paths to all editable source files. Exported so the settings API
// can read/write the exact same files config.js loads from.
export const paths = {
  promptsDir,
  commentaryPrompt: join(promptsDir, 'prompt.md'),
  assemblyPrompt: join(promptsDir, 'assembly_prompt.md'),
  deepPrompt: join(promptsDir, 'prompt_deep.md'),
  configMd: join(promptsDir, 'config.md'),
  env: join(parentDir, '.env'),
};

function readFileOrWarn(filePath, label) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[config] Warning: could not read ${label} at ${filePath}`);
    return '';
  }
}

function parseConfigMd(text) {
  const result = {
    hashtag: '#новости',
    courseMention: '',
    boundaryIntent: '',
    hashtagsSuffix: '',
  };

  if (!text) return result;

  const sections = text.split(/^## /m);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const heading = lines[0]?.trim().toLowerCase() || '';
    const body = lines.slice(1).join('\n').trim();

    if (heading.startsWith('хэштег') || heading.startsWith('хештег')) {
      result.hashtag = body.trim() || '#новости';
    } else if (heading.includes('упоминание курса')) {
      result.courseMention = body.trim();
    } else if (heading.includes('граница') || heading.includes('отписка')) {
      result.boundaryIntent = body.trim();
    }
  }

  // Extract hashtags suffix from boundary section or end of file
  const hashtagMatch = text.match(/добавлять в конце поста хе[шс]теги:\s*\n+([\s\S]*?)(?:\n##|\n\n\n|$)/i);
  if (hashtagMatch) {
    result.hashtagsSuffix = hashtagMatch[1].trim();
  }

  return result;
}

/**
 * Build the full settings object from the current environment and source files.
 * Pure read — does not mutate anything.
 */
function buildConfig() {
  const commentaryPrompt = readFileOrWarn(paths.commentaryPrompt, 'prompt.md');
  const assemblyPrompt = readFileOrWarn(paths.assemblyPrompt, 'assembly_prompt.md');
  const deepPrompt = readFileOrWarn(paths.deepPrompt, 'prompt_deep.md');
  const configMdRaw = readFileOrWarn(paths.configMd, 'config.md');
  const parsedConfig = parseConfigMd(configMdRaw);

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    falKey: process.env.FAL_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    dbPath: process.env.DB_PATH || './data/news-digest.db',
    ntfyTopic: process.env.NTFY_TOPIC || '',
    articleThreshold: parseInt(process.env.ARTICLE_THRESHOLD || '13', 10),
    maxArticlesPerDigest: parseInt(process.env.MAX_ARTICLES_PER_DIGEST || '17', 10),
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    // Active commentary scenario for Phase A: 'sarcastic' (prompt.md) or
    // 'architect' (prompt_deep.md). Assembly (Phase B) is scenario-independent.
    activeScenario: process.env.ACTIVE_SCENARIO || 'sarcastic',

    // Publishers
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    facebookPageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramPublishChatId: process.env.TELEGRAM_PUBLISH_CHAT_ID || '',
    youtubeAccessToken: process.env.YOUTUBE_ACCESS_TOKEN || '',
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',

    // Telegram webhook
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    baseUrl: process.env.BASE_URL || '',

    // Raw config.md text (kept for the settings editor)
    configMdRaw,

    // Prompts (loaded from parent directory files)
    commentaryPrompt,
    assemblyPrompt,
    deepPrompt,

    // Parsed config.md values
    hashtag: parsedConfig.hashtag,
    courseMention: parsedConfig.courseMention,
    boundaryIntent: parsedConfig.boundaryIntent,
    hashtagsSuffix: parsedConfig.hashtagsSuffix,
  };
}

// Live config object. NOT frozen — importers hold this reference and read
// properties at call time, so reloadConfig() mutating it in place propagates.
const appConfig = buildConfig();

/**
 * Reload configuration in place: re-read .env (override existing process.env),
 * re-read the four source files, re-parse config.md, then reassign every
 * property on the SAME appConfig object so existing importers see new values.
 * Returns the same appConfig reference.
 */
export function reloadConfig() {
  dotenvConfig({ path: paths.env, override: true });
  const fresh = buildConfig();

  // Drop properties that no longer exist, then copy fresh values in place.
  for (const key of Object.keys(appConfig)) {
    if (!(key in fresh)) delete appConfig[key];
  }
  Object.assign(appConfig, fresh);

  return appConfig;
}

export default appConfig;
