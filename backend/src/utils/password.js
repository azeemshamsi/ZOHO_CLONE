/**
 * Password policy.
 *  - at least 12 characters (max 128) with an upper-case letter, a lower-case letter, a number and a symbol
 *  - must not contain the user's name or the part of their email before the @
 *  - must not be a common password (commonPasswords.txt: the 1,000 most common passwords from SecLists'
 *    Pwdb_top-1000, MIT licence, plus a few local words), also with digits/symbols added at the ends
 *  - expires after 365 days (changed at the next sign-in); the last 5 passwords can't be reused
 */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const MIN = 12;
const MAX = 128;
const EXPIRY_DAYS = 365;
const HISTORY = 5;
const RULES_TEXT = "At least 12 characters, with upper- and lower-case letters, a number and a symbol. Not your name or email, and not a common password.";

let common = null;
const commonSet = () => common || (common = new Set(fs.readFileSync(path.join(__dirname, "commonPasswords.txt"), "utf8").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)));

// Error message, or "" when the password is acceptable.
function check(pw, { name = "", email = "" } = {}) {
  const p = String(pw || "");
  if (p.length < MIN) return `Password must be at least ${MIN} characters`;
  if (p.length > MAX) return `Password must be at most ${MAX} characters`;
  if (!/[a-z]/.test(p)) return "Password must contain a lower-case letter";
  if (!/[A-Z]/.test(p)) return "Password must contain an upper-case letter";
  if (!/[0-9]/.test(p)) return "Password must contain a number";
  if (!/[^A-Za-z0-9]/.test(p)) return "Password must contain a symbol (e.g. ! @ # $ %)";
  const low = p.toLowerCase();
  const local = String(email || "").toLowerCase().split("@")[0];
  if (local.length >= 3 && low.includes(local)) return "Password must not contain your email address";
  for (const part of String(name || "").toLowerCase().split(/[^a-z0-9]+/)) if (part.length >= 3 && low.includes(part)) return "Password must not contain your name";
  const set = commonSet();
  const core = low.replace(/^[^a-z]+|[^a-z]+$/g, "");
  const squash = low.replace(/[^a-z0-9]/g, "");
  if (set.has(low) || set.has(squash) || (core.length >= 4 && set.has(core))) return "This password is too common — choose something less guessable";
  return "";
}

// Throws a 400 HttpError when the password breaks the policy.
function assertStrong(pw, user) {
  const msg = check(pw, user);
  if (msg) {
    const { HttpError } = require("./http");
    throw new HttpError(400, msg);
  }
}

// Was this one of the last 5 passwords (the current one + the 4 before it)?
async function reused(pw, user) {
  for (const h of [user.password, ...(user.passwordHistory || [])].filter(Boolean).slice(0, HISTORY)) if (await bcrypt.compare(pw, h)) return true;
  return false;
}

/**
 * Set a new password on a user document (not saved): policy, reuse check, history, expiry date, and a new
 * token version so every other session is signed out. Returns the user.
 */
async function setPassword(user, pw) {
  const { HttpError } = require("./http");
  assertStrong(pw, user);
  if (await reused(pw, user)) throw new HttpError(400, `Choose a password you haven't used before (the last ${HISTORY} can't be reused)`);
  if (user.password) user.passwordHistory = [user.password, ...(user.passwordHistory || [])].slice(0, HISTORY - 1);
  user.password = await bcrypt.hash(pw, 10);
  user.passwordChangedAt = new Date();
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.loginFailures = { count: 0, since: null };
  user.lockedUntil = null;
  return user;
}

const expired = (user, now = Date.now()) => !!user.passwordChangedAt && now - new Date(user.passwordChangedAt).getTime() > EXPIRY_DAYS * 86400000;

module.exports = { check, assertStrong, reused, setPassword, expired, RULES_TEXT, MIN, EXPIRY_DAYS, HISTORY };
