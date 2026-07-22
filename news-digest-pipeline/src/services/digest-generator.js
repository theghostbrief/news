import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  updateArticleStatus,
  updateArticleCommentary,
  createDigest,
  updateDigest,
  assignArticlesToDigest,
  getDigests,
  getDigest,
} from '../db/index.js';
import { priceFor } from '../data/model-catalog.js';
import { callModel, sleep } from './llm.js';
import { findUnquotedNonLatinRuns, describeScriptIssues } from './script-guard.js';

const MAX_CONTENT_LENGTH = 3000;
const INTER_CALL_DELAY_MS = 200;

// callModel/withRetry/sleep now live in ./llm.js (shared with the pro moderation
// judge). Called here with no model/vendor override, so it uses
// config.claudeModel / config.llmVendor exactly as the inlined version did.

export async function generateDigest(db, articles, config) {
  const log = [];

  // Token accounting across every successful model call (Phase A + Phase B).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  log.push(`Starting digest generation for ${articles.length} articles`);

  // Select Phase A system prompt by active scenario. 'ghost' is the English
  // edition and also switches Phase B (assembly prompt + wrapper + completion
  // marker, all handled below) — 'sarcastic'/'architect' share Krol's
  // Russian assembly path exactly as before.
  const scenario = config.activeScenario || 'ghost';
  const isGhost = scenario === 'ghost';
  let commentarySystem;
  if (isGhost) {
    commentarySystem = config.ghostCommentaryPrompt;
    log.push(`Scenario: ${scenario}`);
  } else if (scenario === 'architect') {
    if (config.deepPrompt && config.deepPrompt.trim()) {
      commentarySystem = config.deepPrompt;
      log.push(`Scenario: ${scenario}`);
    } else {
      commentarySystem = config.commentaryPrompt;
      log.push('Scenario: architect requested but deepPrompt is empty — falling back to commentaryPrompt');
    }
  } else {
    commentarySystem = config.commentaryPrompt;
    log.push(`Scenario: ${scenario}`);
  }

  // Phase A: Generate commentary for each article
  for (const article of articles) {
    if (article.commentary) {
      log.push(`Skipping article ${article.id} — commentary already exists`);
      continue;
    }

    try {
      updateArticleStatus(article.id, 'processing');

      const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);

      const userMessage = article.title
        ? `${article.title}\n\n${contentTruncated}`
        : contentTruncated;

      const res = await callModel(config, {
        system: commentarySystem,
        user: userMessage,
        maxTokens: 512,
      });
      let commentary = res.text;
      totalInputTokens += res.inputTokens;
      totalOutputTokens += res.outputTokens;

      // Script guard: only meaningful for English-output scenarios (Krol's
      // Russian scenarios legitimately output Cyrillic — flagging that would
      // be a false positive). Catches stray non-English-script words a model
      // sometimes drops into otherwise-English text (seen with gpt-5.6-terra,
      // 2026-07-22) — auto-retry the single item once before falling back to
      // flagging the whole digest for manual review.
      if (isGhost) {
        const issues = findUnquotedNonLatinRuns(commentary);
        if (issues.length > 0) {
          log.push(`Non-Latin script in article ${article.id}: ${describeScriptIssues(issues)} — retrying once`);
          const retryRes = await callModel(config, {
            system: commentarySystem,
            user: userMessage,
            maxTokens: 512,
          });
          totalInputTokens += retryRes.inputTokens;
          totalOutputTokens += retryRes.outputTokens;
          const retryIssues = findUnquotedNonLatinRuns(retryRes.text);
          commentary = retryRes.text;
          log.push(retryIssues.length === 0
            ? `Retry for article ${article.id} is clean`
            : `Retry for article ${article.id} still has non-Latin script: ${describeScriptIssues(retryIssues)} — will flag digest`);
        }
      }

      updateArticleCommentary(article.id, commentary);
      article.commentary = commentary;

      log.push(`Generated commentary for article ${article.id}: ${commentary.slice(0, 60)}...`);

      await sleep(INTER_CALL_DELAY_MS);
    } catch (err) {
      log.push(`Error generating commentary for article ${article.id}: ${err.message}`);
      updateArticleStatus(article.id, 'error');
      // Continue with other articles
    }
  }

  // Filter articles that have commentary
  const articlesWithCommentary = articles.filter((a) => a.commentary);

  if (articlesWithCommentary.length === 0) {
    throw new Error('No articles with commentary — cannot assemble digest');
  }

  // Phase B: Assembly
  const today = new Date().toISOString().slice(0, 10);

  // Build the user message for assembly. 'ghost' uses an English wrapper with
  // per-item ids (needed for the <!--SEG article_id=...--> markers) and the
  // footer/hashtags from prompts/en/config.md; other scenarios keep Krol's
  // exact Russian wrapper and config.md fields, unchanged.
  const commentaryList = articlesWithCommentary
    .map((a, i) => isGhost
      ? `${i + 1}. [id: ${a.id}]\n${a.commentary}\n${a.url}`
      : `${i + 1}. ${a.commentary}\n${a.url}`)
    .join('\n\n');

  const assemblySystem = isGhost ? config.ghostAssemblyPrompt : config.assemblyPrompt;

  const assemblyUserMessage = isGhost
    ? [
        `Here are ${articlesWithCommentary.length} processed commentary items to assemble into a digest:`,
        '',
        commentaryList,
        '',
        '---',
        `Footer (insert verbatim at the very end): ${config.ghostFooter}`,
        '',
        `Hashtags (insert verbatim at the very end, after the footer): ${config.ghostHashtags}`,
      ].join('\n')
    : [
        `Вот ${articlesWithCommentary.length} обработанных комментариев для сборки в дайджест:`,
        '',
        commentaryList,
        '',
        '---',
        `Упоминание курса (вставить в середине списка): ${config.courseMention}`,
        '',
        `Граница/дисклеймер (в конце): ${config.boundaryIntent}`,
        '',
        `Хэштеги (в самом конце): ${config.hashtagsSuffix}`,
      ].join('\n');

  log.push('Assembling digest...');

  const assemblyRes = await callModel(config, {
    system: assemblySystem,
    user: assemblyUserMessage,
    maxTokens: 16384,
  });
  let digestContent = assemblyRes.text;
  totalInputTokens += assemblyRes.inputTokens;
  totalOutputTokens += assemblyRes.outputTokens;

  // Post-processing: remove any preamble before the digest's real start marker.
  // Claude sometimes adds explanatory text before the actual digest.
  const startMarker = isGhost ? '👻 THE GHOST BRIEF' : '#новости';
  const digestStart = digestContent.indexOf(startMarker);
  if (digestStart > 0) {
    digestContent = digestContent.substring(digestStart);
    log.push(`Removed ${digestStart} chars of preamble before ${startMarker}`);
  }

  // Final script-guard sweep over the fully assembled digest — the per-item
  // retry above already catches most cases, but this is the last line of
  // defense (also covers headlines/the "Ghost's read" line, which Phase B
  // generates itself and which the per-item retry can't reach). English-only
  // scenario, same reasoning as above.
  let scriptWarning = null;
  if (isGhost) {
    const finalIssues = findUnquotedNonLatinRuns(digestContent);
    if (finalIssues.length > 0) {
      scriptWarning = `Non-Latin script detected: ${describeScriptIssues(finalIssues)} — review before publishing.`;
      log.push(`WARNING: ${scriptWarning}`);
    } else {
      log.push('Script check: clean (no unquoted non-Latin script detected)');
    }
  }

  // Create digest record
  const digestId = createDigest({
    date: today,
    part: 1,
    articlesCount: articlesWithCommentary.length,
  });

  // Compute cost from accumulated token usage and the model's base pricing.
  const p = priceFor(config.claudeModel);
  let costUsd = null;
  if (p) {
    const raw = (totalInputTokens / 1e6) * p.input + (totalOutputTokens / 1e6) * p.output;
    costUsd = Math.round(raw * 1e6) / 1e6;
  }

  const costLabel = costUsd === null ? 'n/a' : `$${costUsd}`;
  log.push(`Tokens: in=${totalInputTokens} out=${totalOutputTokens} | Model: ${config.claudeModel} | Cost: ${costLabel}`);

  updateDigest(digestId, {
    content: digestContent,
    status: 'draft',
    generation_log: log.join('\n'),
    model: config.claudeModel,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: costUsd,
    script_warning: scriptWarning,
  });

  // Assign articles to digest
  const articleIds = articlesWithCommentary.map((a) => a.id);
  assignArticlesToDigest(articleIds, digestId);

  // Save digest as .txt file
  const filePath = saveDigestToFile(today, digestContent);
  log.push(`Digest saved to file: ${filePath}`);
  log.push(`Digest created: ${digestId}`);

  // Clean up source Telegram messages ONLY after confirming the digest was
  // assembled successfully: digest row exists, content is non-empty, and the
  // scenario's start marker is present. If anything looks off, skip cleanup so
  // the source messages remain available for retry.
  const saved = getDigest(digestId);
  const digestOk = saved && typeof saved.content === 'string'
    && saved.content.length > 100
    && saved.content.includes(startMarker);

  if (!digestOk) {
    log.push('Skipping source cleanup: digest not confirmed valid');
  } else if (config.telegramBotToken) {
    const { deleteTelegramMessage } = await import('./telegram-bot.js');
    const seen = new Set();
    let deleted = 0;
    let failed = 0;
    for (const a of articlesWithCommentary) {
      if (!a.source_chat_id || !a.source_message_id) continue;
      const key = `${a.source_chat_id}:${a.source_message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const ok = await deleteTelegramMessage(config.telegramBotToken, a.source_chat_id, Number(a.source_message_id));
        if (ok) deleted++; else failed++;
      } catch {
        failed++;
      }
    }
    log.push(`Telegram source cleanup: deleted=${deleted}, failed=${failed}`);
  }

  return digestId;
}

function saveDigestToFile(date, content) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(__dirname, '../../output');
  mkdirSync(outputDir, { recursive: true });

  // Determine part number based on existing files for this date
  const existing = getDigests().filter((d) => d.date === date);
  const part = existing.length || 1;

  const filename = `digest_${date}_part${part}.txt`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[digest-generator] Saved digest to ${filePath}`);
  return filePath;
}
