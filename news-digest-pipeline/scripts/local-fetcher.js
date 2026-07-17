#!/usr/bin/env node

/**
 * Local Mac Fetcher for News Digest Pipeline
 *
 * Checks server for articles without content, opens them in Chrome,
 * extracts content via AppleScript, sends back to server.
 *
 * No special Chrome flags needed — uses AppleScript to interact with
 * the real Chrome browser, which bypasses Perplexity's bot detection
 * (Cloudflare challenge; a headless browser does NOT pass it, the real
 * warmed profile does).
 *
 * Non-intrusive: all navigation happens in a DEDICATED background Chrome
 * window addressed by id, and Chrome is never `activate`d. The user's own
 * window and tabs are never touched and focus is never stolen. If Chrome is
 * not running it is launched in the background (`open -g`).
 *
 * Usage:
 *   node scripts/local-fetcher.js
 *
 * Requirements:
 *   - macOS with Google Chrome installed
 *   - Node.js 20+ (for native fetch and WebSocket)
 *   - cheerio package (already in project dependencies)
 */

import { execSync } from 'child_process';
import { load as cheerioLoad } from 'cheerio';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateArticleUrl } from '../src/services/url-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(__dirname, '..', '.env') });

const SERVER = process.env.BASE_URL;
const API_KEY = process.env.API_SECRET_KEY;

if (!SERVER || !API_KEY) {
  console.error('Missing BASE_URL or API_SECRET_KEY in .env');
  process.exit(1);
}

const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}` };

const LOAD_WAIT_MS = 8000;       // Wait for page to load
const BETWEEN_TABS_MS = 2000;    // Pause between processing tabs

// Same selectors as extension/popup.js and article-fetcher.js
const CONTENT_SELECTORS = [
  'article',
  '[class*="prose"]',
  '.scrollbar-subtle',
  '.markdown',
  'main',
];

const REMOVE_SELECTORS = 'script, style, nav, header, footer, [class*="sideBarWidth"], .sidebar, aside, [role="navigation"], [role="banner"]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run AppleScript and return stdout. Returns null on error.
 */
function runAppleScript(script) {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch (err) {
    return null;
  }
}

/**
 * Run multi-line AppleScript via heredoc.
 */
function runAppleScriptMulti(script) {
  try {
    return execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      encoding: 'utf-8',
      timeout: 30000,
      shell: '/bin/bash',
    }).trim();
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server API
// ---------------------------------------------------------------------------

async function fetchArticlesWithoutContent() {
  // Fetch both 'new' and 'error' articles — both may lack content
  const [resNew, resError] = await Promise.all([
    fetch(`${SERVER}/api/articles?status=new&limit=50`, { headers: AUTH_HEADERS }),
    fetch(`${SERVER}/api/articles?status=error&limit=50`, { headers: AUTH_HEADERS }),
  ]);
  if (!resNew.ok) throw new Error(`Server returned ${resNew.status}`);
  if (!resError.ok) throw new Error(`Server returned ${resError.status}`);

  const articlesNew = await resNew.json();
  const articlesError = await resError.json();
  const all = [...articlesNew, ...articlesError];

  // Filter: content is null, empty, or very short
  return all.filter(a => !a.content || a.content.trim().length < 100);
}

async function sendContentToServer(articleId, title, content) {
  const res = await fetch(`${SERVER}/api/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) {
    throw new Error(`PATCH failed (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Chrome via AppleScript
// ---------------------------------------------------------------------------

function isChromeRunning() {
  const result = runAppleScript(
    'tell application "System Events" to (name of processes) contains "Google Chrome"'
  );
  return result === 'true';
}

/**
 * Create a dedicated background Chrome window for fetching and return its id.
 * No `activate` — the app is not brought to the foreground, and the user's
 * existing windows/tabs are left completely alone. Returns null on failure.
 */
function openFetchWindow() {
  const script = `
tell application "Google Chrome"
  set newWin to make new window
  return id of newWin
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Point the fetch window's single tab at a URL (reused across articles).
 */
function navigateFetchTab(winId, url) {
  const script = `
tell application "Google Chrome"
  set URL of active tab of window id ${winId} to "${url}"
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Read the current URL of the fetch window's tab.
 */
function getFetchTabUrl(winId) {
  const script = `
tell application "Google Chrome"
  return URL of active tab of window id ${winId}
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Read the full DOM of the fetch window's tab.
 */
function getFetchTabSource(winId) {
  const script = `
tell application "Google Chrome"
  return execute (active tab of window id ${winId}) javascript "document.documentElement.outerHTML"
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Close the dedicated fetch window when the run is done.
 */
function closeFetchWindow(winId) {
  const script = `
tell application "Google Chrome"
  close window id ${winId}
end tell`;
  runAppleScriptMulti(script);
}

// ---------------------------------------------------------------------------
// Content Extraction (mirrors extension logic)
// ---------------------------------------------------------------------------

function extractFromHtml(html) {
  const $ = cheerioLoad(html);

  // Remove unwanted elements
  $(REMOVE_SELECTORS).remove();

  // Extract title
  let title = $('h1').first().text().trim();
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || '';
  }
  if (!title) {
    title = $('title').text().replace(/\s*[-|].*$/, '').trim();
  }

  // Extract content using the same selectors as the extension
  let content = '';
  for (const selector of CONTENT_SELECTORS) {
    const el = $(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 100) {
        content = text;
        break;
      }
    }
  }

  // Fallback: body text
  if (!content || content.length < 200) {
    content = $('body').text().trim();
  }

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return { title, content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Checking server for articles without content...');

  let articles;
  try {
    articles = await fetchArticlesWithoutContent();
  } catch (err) {
    log(`Error connecting to server: ${err.message}`);
    process.exit(1);
  }

  if (articles.length === 0) {
    log('No articles without content. Done.');
    process.exit(0);
  }

  log(`Found ${articles.length} article(s) without content.`);

  // Check Chrome is running — launch in the BACKGROUND (-g) so it never
  // steals focus from whatever the user is doing.
  if (!isChromeRunning()) {
    log('Google Chrome is not running. Starting it in the background...');
    execSync('open -g -a "Google Chrome"');
    await sleep(3000);
  }

  // One dedicated background window for the whole run, addressed by id. The
  // user's own window/tabs are never touched.
  const fetchWin = openFetchWindow();
  if (!fetchWin) {
    log('Could not open a dedicated Chrome window (is "Allow JavaScript from Apple Events" enabled?). Aborting.');
    process.exit(1);
  }

  let enriched = 0;
  let failed = 0;

  try {
    for (const article of articles) {
      log(`Processing: ${article.url}`);

      try {
        // Validate against the shared contract (HTTPS + perplexity.ai + no
        // control chars) before the URL reaches the AppleScript string — the
        // interpolation sink where a crafted URL would be command injection.
        const v = validateArticleUrl(article.url);
        if (!v.ok) {
          log(`  Skipping untrusted URL (${v.error}): ${article.url}`);
          failed++;
          continue;
        }

        // Point the dedicated window's tab at this article (reused per article).
        navigateFetchTab(fetchWin, v.href);

        // Wait for page to load
        await sleep(LOAD_WAIT_MS);

        // Verify the tab navigated
        const currentUrl = getFetchTabUrl(fetchWin);
        if (!currentUrl) {
          log(`  Could not read fetch tab URL, skipping.`);
          failed++;
          continue;
        }

        // Get page source
        const html = getFetchTabSource(fetchWin);
        if (!html || html.length < 200) {
          log(`  Got empty or too short page source (${html?.length || 0} chars), skipping.`);
          failed++;
          continue;
        }

        // Extract content
        const { title, content } = extractFromHtml(html);

        if (!content || content.length < 100) {
          log(`  Content too short (${content?.length || 0} chars), skipping.`);
          failed++;
          continue;
        }

        // Send back to server
        await sendContentToServer(article.id, title, content);
        log(`  Sent to server: "${title}" (${content.length} chars)`);
        enriched++;

        // Small pause between articles
        await sleep(BETWEEN_TABS_MS);

      } catch (err) {
        log(`  Error: ${err.message}`);
        failed++;
      }
    }
  } finally {
    // Always tidy up the dedicated window.
    closeFetchWindow(fetchWin);
  }

  log(`Done. Enriched: ${enriched}, Failed: ${failed}, Total: ${articles.length}`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
