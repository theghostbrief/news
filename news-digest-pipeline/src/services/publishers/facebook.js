/**
 * Facebook Page publisher.
 * Posts content to a Facebook Page via Graph API.
 *
 * Posting is allowed ONLY to a Page, via a Page Access Token
 * (POST /{pageId}/feed). Posting to a personal profile is deliberately NOT
 * implemented for policy/legality reasons (risk of shadow ban). Do not add it.
 */
import { stripDigestMarkers } from '../digest-format.js';

export async function publishToFacebook(pageAccessToken, pageId, content) {
  if (!pageAccessToken || !pageId) {
    console.error('[facebook] Missing pageAccessToken or pageId');
    return { error: 'Facebook page ID or access token is not configured (FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN in .env).' };
  }

  const clean = stripDigestMarkers(content);
  const url = `https://graph.facebook.com/v19.0/${pageId}/feed`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: clean,
        access_token: pageAccessToken,
      }),
    });
  } catch (err) {
    console.error('[facebook] Network error publishing:', err.message);
    return { error: `Network error contacting Facebook: ${err.message}` };
  }

  // Read as text first — a non-JSON body (HTML error page, empty response,
  // proxy interstitial) must never throw an unreadable JSON.parse error up to
  // the dashboard. This is what produced "Unexpected non-whitespace character
  // after JSON at position 4" in production (2026-07-22): an invalid/missing
  // access token can make the Graph API — or something in front of it — return
  // a body that isn't the JSON response.json() expects.
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[facebook] Non-JSON response from Graph API:', raw.slice(0, 500));
    return { error: 'Facebook returned an unreadable response — the page access token is likely missing, expired, or invalid.' };
  }

  if (!response.ok || data.error) {
    const msg = data.error?.message || `HTTP ${response.status}`;
    console.error('[facebook] API error:', msg);
    return { error: `Facebook API error: ${msg}` };
  }

  const postId = data.id;
  return {
    postId,
    url: `https://www.facebook.com/${postId.replace('_', '/posts/')}`,
  };
}
