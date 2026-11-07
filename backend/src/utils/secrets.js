/**
 * Encryption of stored third-party secrets (API keys, client secrets, tokens, passwords) with AES-256-GCM.
 *
 * Key: env CREDENTIALS_KEY (32 bytes as 64 hex characters or base64). Without it, a key is derived from
 * JWT_SECRET with HKDF-SHA256 (distinct salt) and a warning is logged once. Values written with the derived key
 * are re-encrypted with CREDENTIALS_KEY on the next start once that is set (reencryptAll).
 *
 * Stored form: "enc:v1:" + base64(iv[12] | tag[16] | ciphertext). Plain (legacy) values are still read as they
 * are and get encrypted on their next save, or at start-up by reencryptAll.
 *
 * Models declare their secret paths with encryptFields(schema, paths): a setter encrypts on assignment and on
 * updates; a getter decrypts on read, so integration code keeps reading doc.clientSecret etc. as plain text.
 * .lean() results and toObject()/toJSON() (without getters) keep the encrypted form — never send secrets to the
 * browser; models' toJSON removes them anyway.
 */
const crypto = require("crypto");

const PREFIX = "enc:v1:";
const FIELDS = {
  AmazonAccount: ["clientSecret", "refreshToken", "accessToken"],
  ShopifyStore: ["clientSecret", "accessToken"],
  CourierAccount: ["credentials", "token"],
  GspAccount: ["token", "clientSecret", "password", "authToken", "sek"],
  Organization: ["smtp.pass", "smtp.apiKey", "ai.geminiKey"],
  User: ["totp.secret", "totp.pendingSecret"], // two-step login secrets
};

function parseKey(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  if (b.length === 32) return b;
  throw new Error("CREDENTIALS_KEY must be 32 bytes: 64 hex characters or base64 (e.g. openssl rand -hex 32)");
}

let cache = null;
let warned = false;
// [primary, ...fallbacks]
function keys() {
  if (cache) return cache;
  const env = require("../config/env");
  const derived = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(String(env.JWT_SECRET)), Buffer.from("ordexago-credentials-salt-v1"), Buffer.from("stored third-party credentials"), 32));
  const explicit = parseKey(process.env.CREDENTIALS_KEY);
  if (!explicit && !warned) {
    warned = true;
    if (process.env.NODE_ENV !== "test") console.warn("[secrets] CREDENTIALS_KEY is not set — stored API keys are encrypted with a key derived from JWT_SECRET. Set CREDENTIALS_KEY (openssl rand -hex 32) in the server's .env.");
  }
  cache = explicit ? [explicit, derived] : [derived];
  return cache;
}
const resetKeys = () => {
  cache = null;
};

const isEncrypted = (v) => typeof v === "string" && v.startsWith(PREFIX);

function encrypt(plain) {
  if (typeof plain !== "string" || plain === "" || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keys()[0], iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

// { value, keyIndex } — keyIndex -1 when it couldn't be decrypted.
function open(v) {
  const raw = Buffer.from(v.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const ks = keys();
  for (let i = 0; i < ks.length; i++) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", ks[i], iv);
      d.setAuthTag(tag);
      return { value: Buffer.concat([d.update(ct), d.final()]).toString("utf8"), keyIndex: i };
    } catch {}
  }
  return { value: "", keyIndex: -1 };
}

let failWarned = false;
function decrypt(v) {
  if (!isEncrypted(v)) return v;
  const r = open(v);
  if (r.keyIndex < 0 && !failWarned) {
    failWarned = true;
    console.error("[secrets] A stored secret couldn't be decrypted — CREDENTIALS_KEY / JWT_SECRET changed? Re-enter that key in the app.");
  }
  return r.value;
}

const mapDeep = (v, fn) => {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapDeep(x, fn));
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapDeep(x, fn)]));
  return v;
};
const encryptDeep = (v) => mapDeep(v && typeof v.toObject === "function" ? v.toObject() : v, encrypt);
const decryptDeep = (v) => mapDeep(v, decrypt);

// Mongoose: encrypt these paths on write, decrypt on read.
function encryptFields(schema, paths) {
  for (const p of paths) {
    const st = schema.path(p);
    if (!st) throw new Error(`encryptFields: no path ${p}`);
    const mixed = st.instance === "Mixed";
    st.set(mixed ? encryptDeep : encrypt);
    st.get(mixed ? decryptDeep : decrypt);
  }
}

/**
 * Start-up: encrypt every plain secret still stored, and re-encrypt values written with a fallback key under the
 * primary key. Works on the raw collections and updates by _id (idempotent; runs on every start).
 */
async function reencryptAll() {
  const mongoose = require("mongoose");
  const fresh = (v) => (isEncrypted(v) ? (open(v).keyIndex > 0 ? encrypt(open(v).value) : v) : encrypt(v));
  const report = {};
  for (const [name, paths] of Object.entries(FIELDS)) {
    const M = mongoose.models[name] || require(`../models/${name}`);
    const proj = Object.fromEntries(paths.map((p) => [p, 1]));
    const docs = await M.collection.find({}, { projection: proj }).toArray();
    let n = 0;
    for (const d of docs) {
      const set = {};
      for (const p of paths) {
        const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), d);
        if (v == null || v === "") continue;
        const nv = typeof v === "string" ? fresh(v) : mapDeep(v, (x) => (x === "" ? x : fresh(x)));
        if (JSON.stringify(nv) !== JSON.stringify(v)) set[p] = nv;
      }
      if (Object.keys(set).length) {
        await M.collection.updateOne({ _id: d._id }, { $set: set });
        n++;
      }
    }
    if (n) report[name] = n;
  }
  if (Object.keys(report).length) console.log(`[secrets] encrypted stored credentials: ${JSON.stringify(report)}`);
  return report;
}

module.exports = { encrypt, decrypt, encryptDeep, decryptDeep, isEncrypted, encryptFields, reencryptAll, parseKey, resetKeys, FIELDS, PREFIX };
