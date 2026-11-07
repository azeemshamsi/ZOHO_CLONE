/**
 * Two-step login: TOTP (RFC 6238 — HMAC-SHA1, 30-second steps, 6 digits, ±1 step allowed) with Node's crypto,
 * and one-time recovery codes (stored as SHA-256 hashes).
 */
const crypto = require("crypto");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const STEP = 30;
const newSecret = () => base32(crypto.randomBytes(20));

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", unbase32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}
const stepAt = (t = Date.now()) => Math.floor(t / 1000 / STEP);
const totp = (secret, t = Date.now()) => hotp(secret, stepAt(t));

// The matching time step, or -1. Steps at or before `afterStep` are refused (no replay of a used code).
function verify(secret, code, { t = Date.now(), window = 1, afterStep = -1 } = {}) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return -1;
  const now = stepAt(t);
  for (let w = -window; w <= window; w++) {
    const s = now + w;
    if (s <= afterStep) continue;
    const a = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(a, Buffer.from(c))) return s;
  }
  return -1;
}

const otpauthUrl = (secret, account, issuer = "OrdexaGo") => `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// Recovery codes: 10 × "xxxxx-xxxxx" (base32, lower case).
const hashCode = (c) => crypto.createHash("sha256").update(String(c || "").toLowerCase().replace(/[^a-z2-7]/g, "")).digest("hex");
function recoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => {
    const s = base32(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}
// Index of the matching hash, or -1.
function matchRecovery(code, hashes = []) {
  const h = hashCode(code);
  return hashes.findIndex((x) => typeof x === "string" && x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
}

module.exports = { newSecret, totp, hotp, verify, otpauthUrl, recoveryCodes, matchRecovery, hashCode, base32, unbase32, stepAt };
