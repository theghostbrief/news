import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import config, { paths, reloadConfig } from '../config.js';

const router = Router();

const MAX_TEXT_BYTES = 100 * 1024; // ~100KB per text field

// .env keys that this API is allowed to write. Everything else is preserved
// untouched. Secrets are deliberately NOT in this list.
const ENV_WRITABLE = {
  claudeModel: 'CLAUDE_MODEL',
  articleThreshold: 'ARTICLE_THRESHOLD',
  maxArticlesPerDigest: 'MAX_ARTICLES_PER_DIGEST',
  checkIntervalMs: 'CHECK_INTERVAL_MS',
};

/**
 * Mask a secret value. Returns { configured, hint } and never the raw secret.
 */
function maskSecret(value) {
  if (!value) return { configured: false, hint: '' };
  const str = String(value);
  const tail = str.length >= 4 ? str.slice(-4) : str;
  return { configured: true, hint: `…${tail}` };
}

/**
 * Build the full grouped settings payload. Secrets are always masked.
 */
function buildSettingsPayload() {
  return {
    general: {
      claudeModel: { value: config.claudeModel, editable: true },
      nodeEnv: { value: config.nodeEnv, editable: false },
      baseUrl: { value: config.baseUrl, editable: false },
      dbPath: { value: config.dbPath, editable: false },
    },
    queue: {
      articleThreshold: { value: config.articleThreshold, editable: true },
      maxArticlesPerDigest: { value: config.maxArticlesPerDigest, editable: true },
      checkIntervalMs: {
        value: config.checkIntervalMs,
        editable: true,
        note: 'Применяется после рестарта сервера',
      },
    },
    commentary: { text: config.commentaryPrompt, editable: true },
    assembly: { text: config.assemblyPrompt, editable: true },
    deep: { text: config.deepPrompt, editable: true },
    content: {
      text: config.configMdRaw,
      editable: true,
      parsed: {
        hashtag: config.hashtag,
        courseMention: config.courseMention,
        boundaryIntent: config.boundaryIntent,
        hashtagsSuffix: config.hashtagsSuffix,
      },
    },
    publishing: {
      editable: false,
      telegram: {
        botToken: maskSecret(config.telegramBotToken),
        chatId: maskSecret(config.telegramChatId),
        publishChatId: maskSecret(config.telegramPublishChatId),
        webhookSecret: maskSecret(config.telegramWebhookSecret),
      },
      facebook: {
        pageId: maskSecret(config.facebookPageId),
        pageAccessToken: maskSecret(config.facebookPageAccessToken),
      },
      anthropicApiKey: maskSecret(config.anthropicApiKey),
      falKey: maskSecret(config.falKey),
    },
  };
}

/**
 * Atomically write a string to a file: write to a temp sibling, then rename.
 */
function atomicWrite(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Update only the allowed keys in .env, preserving all other lines, comments,
 * blank lines and unrelated secrets. Missing keys are appended. Atomic write.
 *
 * @param {Object<string,string>} updates Map of ENV_KEY -> value (already validated)
 */
function updateEnvFile(updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  let raw = '';
  if (existsSync(paths.env)) {
    raw = readFileSync(paths.env, 'utf-8');
  }

  // Preserve original EOL convention.
  const hadTrailingNewline = raw.length === 0 || raw.endsWith('\n');
  const lines = raw.length ? raw.split('\n') : [];
  const remaining = new Set(keys);

  const out = lines.map((line) => {
    // Match `KEY=...` allowing leading whitespace, but not commented lines.
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) {
      const key = m[2];
      if (remaining.has(key)) {
        remaining.delete(key);
        return `${m[1]}${key}=${updates[key]}`;
      }
    }
    return line;
  });

  // If the file ended with a trailing newline, split() produced a final ''
  // element. Drop it before appending so we don't create blank-line drift.
  if (out.length && out[out.length - 1] === '' && hadTrailingNewline) {
    out.pop();
  }

  for (const key of remaining) {
    out.push(`${key}=${updates[key]}`);
  }

  atomicWrite(paths.env, out.join('\n') + '\n');
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate the incoming PATCH body. Returns { errors: [], env: {}, files: [] }.
 * Only known/allowed fields are considered; everything else is ignored.
 */
function validatePatch(body) {
  const errors = [];
  const env = {};   // ENV_KEY -> string value to write
  const files = []; // [{ path, contents }]

  // --- .env scalar fields ---
  if (body.claudeModel !== undefined) {
    const v = body.claudeModel;
    if (typeof v !== 'string' || v.trim().length === 0) {
      errors.push('claudeModel: должна быть непустой строкой');
    } else if (v.length > 200) {
      errors.push('claudeModel: слишком длинная строка (макс. 200 символов)');
    } else if (/[\n\r]/.test(v)) {
      errors.push('claudeModel: не должна содержать переносы строк');
    } else {
      env[ENV_WRITABLE.claudeModel] = v.trim();
    }
  }

  const intField = (name, min, max) => {
    if (body[name] === undefined) return;
    const v = body[name];
    if (!isInt(v)) {
      errors.push(`${name}: должно быть целым числом`);
    } else if (v < min || v > max) {
      errors.push(`${name}: должно быть в диапазоне ${min}..${max}`);
    } else {
      env[ENV_WRITABLE[name]] = String(v);
    }
  };

  intField('articleThreshold', 1, 100);
  intField('maxArticlesPerDigest', 1, 100);
  intField('checkIntervalMs', 5000, 3600000);

  // --- text/file fields ---
  const textField = (name, targetPath) => {
    const group = body[name];
    if (group === undefined) return;
    const text = group && typeof group === 'object' ? group.text : group;
    if (text === undefined) return;
    if (typeof text !== 'string') {
      errors.push(`${name}.text: должно быть строкой`);
    } else if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_BYTES) {
      errors.push(`${name}.text: слишком большой (макс. 100KB)`);
    } else {
      files.push({ path: targetPath, contents: text });
    }
  };

  textField('commentary', paths.commentaryPrompt);
  textField('assembly', paths.assemblyPrompt);
  textField('deep', paths.deepPrompt);
  textField('content', paths.configMd);

  return { errors, env, files };
}

// GET /api/settings — full grouped settings, secrets masked
router.get('/', (req, res) => {
  try {
    res.json(buildSettingsPayload());
  } catch (err) {
    console.error('[settings] GET error:', err.message);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// PATCH /api/settings — partial update of allowed fields only
router.patch('/', (req, res) => {
  const body = req.body || {};
  const { errors, env, files } = validatePatch(body);

  if (errors.length) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  if (Object.keys(env).length === 0 && files.length === 0) {
    return res.status(400).json({ error: 'Нет допустимых полей для изменения' });
  }

  try {
    // Write text files first (each atomic), then .env (atomic).
    for (const f of files) {
      atomicWrite(f.path, f.contents);
    }
    updateEnvFile(env);

    reloadConfig();

    return res.json(buildSettingsPayload());
  } catch (err) {
    console.error('[settings] PATCH error:', err.message);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
