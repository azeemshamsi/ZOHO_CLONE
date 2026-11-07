/**
 * Login lockout: 5 failed passwords on an account within 10 minutes lock it for 15 minutes.
 * Works on the User document's `loginFailures` ({ count, since }) and `lockedUntil` fields.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

// Milliseconds the account stays locked (0 = not locked).
function lockedFor(user, now = Date.now()) {
  const t = user?.lockedUntil ? new Date(user.lockedUntil).getTime() : 0;
  return t > now ? t - now : 0;
}

// Count one failed password. Returns { count, locked } — locked is true when this failure locked the account.
function recordFailure(user, now = Date.now()) {
  const f = user.loginFailures || {};
  const since = f.since ? new Date(f.since).getTime() : 0;
  let count = since && now - since <= WINDOW_MS ? (f.count || 0) + 1 : 1;
  user.loginFailures = { count, since: new Date(count === 1 ? now : since) };
  let locked = false;
  if (count >= MAX_FAILURES) {
    user.lockedUntil = new Date(now + LOCK_MS);
    user.loginFailures = { count: 0, since: null };
    locked = true;
  }
  return { count, locked };
}

function clearFailures(user) {
  user.loginFailures = { count: 0, since: null };
  user.lockedUntil = null;
}

const minutesLeft = (ms) => Math.max(1, Math.ceil(ms / 60000));

module.exports = { lockedFor, recordFailure, clearFailures, minutesLeft, MAX_FAILURES, WINDOW_MS, LOCK_MS };
