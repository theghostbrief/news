/**
 * Threads long-lived access token auto-refresh.
 *
 * Threads User Access Tokens follow the same ~60-day-expiry / refresh-token
 * pattern as Facebook's, but unlike Facebook (rotated manually via the Access
 * Token Debugger — see docs/facebook-page-setup.md), Threads is refreshed
 * automatically here so a stale token never silently breaks publishing.
 *
 * The refreshed token is stored in the DB (threads_token_state), not written
 * back to .env — .env is edited manually over SSH only, per project
 * convention, and is not something the app should rewrite at runtime.
 * resolveThreadsAccessToken() prefers the DB-stored token when present and
 * falls back to the .env value otherwise (i.e. before the first refresh).
 */
import { getThreadsTokenState, setThreadsTokenState } from '../../db/index.js';

const REFRESH_ENDPOINT = 'https://graph.threads.net/refresh_access_token';

// Refresh once the stored token is within this many ms of expiry. Wide
// enough that, ticking once a day, several attempts happen before the token
// would actually go dead.
const REFRESH_MARGIN_MS = 10 * 24 * 60 * 60 * 1000;

// Threads requires a token to be at least 24h old before it can be
// refreshed. We don't know the mint time of a token that has never been
// refreshed yet (it was set directly in .env via the OAuth flow) — so a
// freshly-configured token may fail its first refresh attempt with a
// "too soon" error from the API. That's expected and harmless: it's logged
// to threads_token_state.last_error and retried on the next tick.
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

/** Current access token to use: DB-refreshed value if we have one, else the .env value. */
export function resolveThreadsAccessToken(config) {
  const state = getThreadsTokenState();
  return (state && state.access_token) || config.threadsAccessToken || '';
}

/** Calls the Threads refresh endpoint for a single token. Pure network call, no DB access. */
export async function refreshThreadsAccessToken(accessToken) {
  const url = `${REFRESH_ENDPOINT}?grant_type=th_refresh_token&access_token=${encodeURIComponent(accessToken)}`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { error: `Network error refreshing Threads token: ${err.message}` };
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'Threads token refresh returned an unreadable response.' };
  }

  if (!response.ok || data.error) {
    return { error: `Threads token refresh failed: ${data.error?.message || `HTTP ${response.status}`}` };
  }
  if (!data.access_token || !data.expires_in) {
    return { error: 'Threads token refresh response is missing access_token/expires_in.' };
  }

  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
}

/**
 * Checks whether the current token needs refreshing and does so if it does.
 * Safe to call on every tick — it no-ops when not due. `now` is injectable for tests.
 */
export async function maybeRefreshThreadsToken(config, now = new Date()) {
  const state = getThreadsTokenState();
  const currentToken = (state && state.access_token) || config.threadsAccessToken;

  if (!currentToken) {
    return { skipped: true, reason: 'No Threads access token configured.' };
  }

  const expiresAt = state?.expires_at ? new Date(state.expires_at) : null;
  const refreshedAt = state?.refreshed_at ? new Date(state.refreshed_at) : null;

  if (expiresAt && expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
    return { skipped: true, reason: 'Not due for refresh yet.' };
  }
  if (refreshedAt && now.getTime() - refreshedAt.getTime() < MIN_REFRESH_AGE_MS) {
    return { skipped: true, reason: 'Token was refreshed too recently to refresh again.' };
  }

  const result = await refreshThreadsAccessToken(currentToken);
  if (result.error) {
    console.error('[threads-token-refresh]', result.error);
    setThreadsTokenState({ last_error: result.error });
    return { error: result.error };
  }

  const newExpiresAt = new Date(now.getTime() + result.expiresInSeconds * 1000).toISOString();
  setThreadsTokenState({
    access_token: result.accessToken,
    refreshed_at: now.toISOString(),
    expires_at: newExpiresAt,
    last_error: null,
  });
  console.log(`[threads-token-refresh] Refreshed — new expiry ${newExpiresAt}`);
  return { refreshed: true, expiresAt: newExpiresAt };
}

/** Starts the daily refresh-check interval. Returns the interval id (for clearInterval on shutdown), or null if Threads isn't configured. */
export function startThreadsTokenRefreshScheduler(config, intervalMs = 24 * 60 * 60 * 1000) {
  if (!config.threadsUserId || !config.threadsAccessToken) {
    return null;
  }

  console.log(`[threads-token-refresh] Started (interval: ${intervalMs}ms)`);

  const tick = () => {
    maybeRefreshThreadsToken(config).catch((err) => {
      console.error('[threads-token-refresh] Unexpected error:', err.message);
    });
  };

  const intervalId = setInterval(tick, intervalMs);
  tick(); // run once immediately so a fresh deploy establishes/refreshes its expiry baseline without waiting a full day

  return intervalId;
}
