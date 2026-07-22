import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import config, { paths, reloadConfig } from '../config.js';
import { MODEL_CATALOG } from '../data/model-catalog.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

const MAX_TEXT_BYTES = 100 * 1024; // ~100KB per text field

// .env keys that this API is allowed to write. Everything else is preserved
// untouched. Secrets are deliberately NOT in this list.
const ENV_WRITABLE = {
  claudeModel: 'CLAUDE_MODEL',
  llmVendor: 'LLM_VENDOR',
  anthropicBaseUrl: 'ANTHROPIC_BASE_URL',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  openaiReasoningEffort: 'OPENAI_REASONING_EFFORT',
  articleThreshold: 'ARTICLE_THRESHOLD',
  maxArticlesPerDigest: 'MAX_ARTICLES_PER_DIGEST',
  checkIntervalMs: 'CHECK_INTERVAL_MS',
  activeScenario: 'ACTIVE_SCENARIO',
};

const LLM_VENDORS = ['anthropic', 'openai'];

// Suggested reasoning-effort levels for the OpenAI path. Empty string clears the
// setting (nothing is sent — current runtime default). The list is a hint, not
// an exhaustive contract: the generator tolerates an unsupported value by
// dropping `reasoning_effort` and retrying (see digest-generator.js), so any
// short token is accepted here rather than hard-validating against a vendor enum
// that changes between model families.
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

// Suggested model ids per vendor come from the shared catalog
// (src/data/model-catalog.js), which also carries pricing. The UI always
// allows entering a custom id, so this list is not exhaustive.

const SCENARIO_OPTIONS = [
  {
    id: 'sarcastic',
    name: 'Sarcasm',
    subtitle: 'current',
    promptFile: 'prompt.md',
    description: 'Sarcastic, informal, skeptical authorial tone. Phase A system prompt comes from prompt.md.',
  },
  {
    id: 'architect',
    name: 'Architect',
    subtitle: 'serious · not used yet',
    promptFile: 'prompt_deep.md',
    description: 'Cold intellect, techno-philosophy, the "pulling-back camera" method. Phase A system prompt comes from prompt_deep.md.',
  },
  {
    id: 'ghost',
    name: 'The Ghost',
    subtitle: 'English · defense & security',
    promptFile: 'en/prompt.md',
    description: 'Dry, skeptical defense-analyst voice for the English-language Ghost Brief edition. OSINT confidence markers, sober register for casualties. Phase A and Phase B prompts come from prompts/en/.',
  },
];
const SCENARIO_IDS = SCENARIO_OPTIONS.map((o) => o.id);

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
      llmVendor: { value: config.llmVendor, editable: true },
      model: { value: config.claudeModel, editable: true },
      // kept for backwards compatibility; UI uses `model`
      claudeModel: { value: config.claudeModel, editable: true },
      anthropicBaseUrl: {
        value: config.anthropicBaseUrl,
        editable: true,
        placeholder: 'https://api.anthropic.com',
      },
      openaiBaseUrl: {
        value: config.openaiBaseUrl,
        editable: true,
        placeholder: 'https://api.openai.com/v1',
      },
      openaiReasoningEffort: {
        value: config.openaiReasoningEffort,
        editable: true,
        suggestions: REASONING_EFFORTS,
      },
      modelCatalog: MODEL_CATALOG,
      nodeEnv: { value: config.nodeEnv, editable: false },
      baseUrl: { value: config.baseUrl, editable: false },
      dbPath: { value: config.dbPath, editable: false },
      ntfyTopic: { value: config.ntfyTopic, editable: false },
    },
    queue: {
      articleThreshold: { value: config.articleThreshold, editable: true },
      maxArticlesPerDigest: { value: config.maxArticlesPerDigest, editable: true },
      checkIntervalMs: {
        value: config.checkIntervalMs,
        editable: true,
        note: 'Applied after a server restart',
      },
    },
    commentary: { text: config.commentaryPrompt, editable: true },
    assembly: { text: config.assemblyPrompt, editable: true },
    deep: { text: config.deepPrompt, editable: true },
    ghost: { text: config.ghostCommentaryPrompt, editable: true },
    ghostAssembly: { text: config.ghostAssemblyPrompt, editable: true },
    scenarios: {
      active: config.activeScenario || 'ghost',
      options: SCENARIO_OPTIONS,
    },
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
      openaiApiKey: maskSecret(config.openaiApiKey),
      falKey: maskSecret(config.falKey),
      // Planned integrations — pipelines not implemented yet, status only.
      // Secrets are not editable via API (only via .env), like all other secrets.
      planned: {
        instagram: {
          accessToken: maskSecret(config.instagramAccessToken),
          accountId: maskSecret(config.instagramAccountId),
          status: 'Pipeline not implemented — needs to be added',
        },
        tiktok: {
          accessToken: maskSecret(config.tiktokAccessToken),
          status: 'Pipeline not implemented — needs to be added',
        },
        youtube: {
          accessToken: maskSecret(config.youtubeAccessToken),
          channelId: maskSecret(config.youtubeChannelId),
          status: 'Community Posts API unavailable — coming soon',
        },
        gemini: {
          apiKey: maskSecret(config.geminiApiKey),
          status: 'API key for future pipelines — needs to be added',
        },
      },
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

  // Persist dashboard edits to the overrides file on the mounted ./data volume,
  // NOT the base .env (which is read-only on the server and rebuilt with the
  // image). See paths.settingsEnv in config.js.
  let raw = '';
  if (existsSync(paths.settingsEnv)) {
    raw = readFileSync(paths.settingsEnv, 'utf-8');
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

  // Header for a freshly created overrides file (self-documenting).
  if (raw.length === 0) {
    out.unshift(
      '# Dashboard-editable settings (overrides base .env). Managed by the',
      '# settings API — do not hand-edit while the server is running.',
    );
  }

  atomicWrite(paths.settingsEnv, out.join('\n') + '\n');
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
  // Model id: accept both `model` and `claudeModel` as aliases (UI sends the
  // selected/custom id). Both write to CLAUDE_MODEL.
  const modelValue = body.model !== undefined ? body.model
    : body.claudeModel !== undefined ? body.claudeModel
    : undefined;
  if (modelValue !== undefined) {
    const v = modelValue;
    if (typeof v !== 'string' || v.trim().length === 0) {
      errors.push('claudeModel: must be a non-empty string');
    } else if (v.length > 200) {
      errors.push('claudeModel: string too long (max 200 characters)');
    } else if (/[\n\r]/.test(v)) {
      errors.push('claudeModel: must not contain line breaks');
    } else {
      env[ENV_WRITABLE.claudeModel] = v.trim();
    }
  }

  // LLM vendor selector — strictly anthropic|openai.
  if (body.llmVendor !== undefined) {
    const v = body.llmVendor;
    if (typeof v !== 'string' || !LLM_VENDORS.includes(v)) {
      errors.push(`llmVendor: must be one of ${LLM_VENDORS.join(', ')}`);
    } else {
      env[ENV_WRITABLE.llmVendor] = v;
    }
  }

  // Base URLs. Empty string is allowed (resets to vendor default) and is still
  // written to .env so the user can explicitly clear it. Non-empty must be a
  // valid http(s) URL.
  const baseUrlField = (name, envKey) => {
    if (body[name] === undefined) return;
    const v = body[name];
    if (typeof v !== 'string') {
      errors.push(`${name}: must be a string`);
      return;
    }
    if (v.length > 300) {
      errors.push(`${name}: string too long (max 300 characters)`);
      return;
    }
    if (/[\n\r]/.test(v)) {
      errors.push(`${name}: must not contain line breaks`);
      return;
    }
    if (v.length > 0 && !/^https?:\/\//.test(v)) {
      errors.push(`${name}: must start with http:// or https://`);
      return;
    }
    env[envKey] = v;
  };

  baseUrlField('anthropicBaseUrl', ENV_WRITABLE.anthropicBaseUrl);
  baseUrlField('openaiBaseUrl', ENV_WRITABLE.openaiBaseUrl);

  // OpenAI reasoning effort. Empty string is allowed and written so the user can
  // explicitly clear it (nothing gets sent at runtime). Non-empty must be a short
  // lowercase token; we do not hard-validate against a fixed vendor enum because
  // the generator self-heals unsupported values.
  if (body.openaiReasoningEffort !== undefined) {
    const v = body.openaiReasoningEffort;
    if (typeof v !== 'string') {
      errors.push('openaiReasoningEffort: must be a string');
    } else if (v.length > 20) {
      errors.push('openaiReasoningEffort: string too long (max 20 characters)');
    } else if (v.length > 0 && !/^[a-z]+$/i.test(v)) {
      errors.push('openaiReasoningEffort: Latin letters only (e.g. minimal, low, medium, high)');
    } else {
      env[ENV_WRITABLE.openaiReasoningEffort] = v.trim().toLowerCase();
    }
  }

  const intField = (name, min, max) => {
    if (body[name] === undefined) return;
    const v = body[name];
    if (!isInt(v)) {
      errors.push(`${name}: must be an integer`);
    } else if (v < min || v > max) {
      errors.push(`${name}: must be in range ${min}..${max}`);
    } else {
      env[ENV_WRITABLE[name]] = String(v);
    }
  };

  intField('articleThreshold', 1, 100);
  intField('maxArticlesPerDigest', 1, 100);
  intField('checkIntervalMs', 5000, 3600000);

  // --- scenario selector ---
  if (body.activeScenario !== undefined) {
    const v = body.activeScenario;
    if (typeof v !== 'string' || !SCENARIO_IDS.includes(v)) {
      errors.push(`activeScenario: must be one of ${SCENARIO_IDS.join(', ')}`);
    } else {
      env[ENV_WRITABLE.activeScenario] = v;
    }
  }

  // --- text/file fields ---
  const textField = (name, targetPath) => {
    const group = body[name];
    if (group === undefined) return;
    const text = group && typeof group === 'object' ? group.text : group;
    if (text === undefined) return;
    if (typeof text !== 'string') {
      errors.push(`${name}.text: must be a string`);
    } else if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_BYTES) {
      errors.push(`${name}.text: too large (max 100KB)`);
    } else {
      files.push({ path: targetPath, contents: text });
    }
  };

  textField('commentary', paths.commentaryPrompt);
  textField('assembly', paths.assemblyPrompt);
  textField('deep', paths.deepPrompt);
  textField('ghost', paths.ghostCommentaryPrompt);
  textField('ghostAssembly', paths.ghostAssemblyPrompt);
  textField('content', paths.configMd);

  return { errors, env, files };
}

/**
 * Strip the sensitive prompt/config text for unauthenticated viewers. The
 * prompts are the product's IP: anonymous visitors may browse the settings
 * structure, but must not be able to read or copy the actual prompt/config
 * bodies. Redacting server-side makes copying impossible (not just hidden in
 * the UI) — the text never reaches the client.
 */
function redactForAnon(payload) {
  payload.locked = true;
  const lock = (obj) => { if (obj && typeof obj === 'object') { obj.text = ''; obj.locked = true; obj.editable = false; } };
  lock(payload.commentary);
  lock(payload.assembly);
  lock(payload.deep);
  if (payload.content) {
    payload.content.text = '';
    payload.content.locked = true;
    payload.content.editable = false;
    payload.content.parsed = {};
  }
  return payload;
}

// GET /api/settings — full grouped settings, secrets masked. Prompt/config
// bodies are redacted for unauthenticated callers.
router.get('/', (req, res) => {
  try {
    const payload = buildSettingsPayload();
    if (!isAuthenticated(req)) redactForAnon(payload);
    res.json(payload);
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
    return res.status(400).json({ error: 'No valid fields to update' });
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
