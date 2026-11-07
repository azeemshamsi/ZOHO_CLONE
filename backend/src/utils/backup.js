/**
 * Encrypted off-site backups to OCI Object Storage (S3-compatible API). Inactive until configured.
 *
 * Nightly at 02:00 IST: every collection → newline-delimited Extended JSON (types kept) → gzip → AES-256-GCM with
 * BACKUP_KEY → one object per collection under ordexago-backups/<YYYY-MM-DDTHHmm>/, plus manifest.json
 * (record counts and SHA-256 of each object). Backups older than 30 days are deleted. Restore with
 * backend/scripts/restore-backup.js (dry run by default).
 *
 * Env: BACKUP_KEY (32 bytes, hex or base64), OCI_BACKUP_BUCKET, OCI_BACKUP_NAMESPACE, OCI_BACKUP_REGION
 * (default ap-hyderabad-1), OCI_BACKUP_ACCESS_KEY, OCI_BACKUP_SECRET (an OCI "Customer Secret Key").
 */
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT = "ordexago-backups/";
const RETAIN_DAYS = 30;
const MAGIC = Buffer.from("OXBK1");
const STATUS_ID = "backup";

function config() {
  const e = process.env;
  const c = {
    key: e.BACKUP_KEY || "",
    bucket: e.OCI_BACKUP_BUCKET || "",
    namespace: e.OCI_BACKUP_NAMESPACE || "",
    region: e.OCI_BACKUP_REGION || "ap-hyderabad-1",
    accessKey: e.OCI_BACKUP_ACCESS_KEY || "",
    secret: e.OCI_BACKUP_SECRET || "",
  };
  c.missing = ["BACKUP_KEY", "OCI_BACKUP_BUCKET", "OCI_BACKUP_NAMESPACE", "OCI_BACKUP_ACCESS_KEY", "OCI_BACKUP_SECRET"].filter((k) => !e[k]);
  c.configured = c.missing.length === 0;
  c.endpoint = c.namespace ? `https://${c.namespace}.compat.objectstorage.${c.region}.oraclecloud.com` : "";
  return c;
}

function backupKey(v = process.env.BACKUP_KEY) {
  const s = String(v || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  if (b.length === 32) return b;
  throw new Error("BACKUP_KEY must be 32 bytes: 64 hex characters or base64 (openssl rand -hex 32)");
}

// "OXBK1" | iv(12) | ciphertext | tag(16)
function encryptBlob(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]);
}
function decryptBlob(blob, key) {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error("Not an OrdexaGo backup file");
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(blob.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(17, blob.length - 16)), d.final()]);
}
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const EJSON = () => require("mongoose").mongo.BSON.EJSON;
// Documents (async iterable) → gzipped NDJSON of canonical Extended JSON. Returns { gz, count }.
async function dumpDocs(docs) {
  const ej = EJSON();
  const parts = [];
  let count = 0;
  for await (const d of docs) {
    parts.push(ej.stringify(d, { relaxed: false }), "\n");
    count++;
  }
  return { gz: zlib.gzipSync(Buffer.from(parts.join(""), "utf8"), { level: 6 }), count };
}
// gzipped NDJSON → documents
function loadDocs(gz) {
  const ej = EJSON();
  return zlib
    .gunzipSync(gz)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ej.parse(l, { relaxed: false }));
}

function s3(c = config()) {
  const { S3Client } = require("@aws-sdk/client-s3");
  // Checksums only when required: S3-compatible stores (OCI) don't all accept the SDK's newer default CRC headers.
  return new S3Client({ region: c.region, endpoint: c.endpoint, forcePathStyle: true, credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secret }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
}
async function getObject(client, bucket, Key) {
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
async function listAll(client, bucket, Prefix) {
  const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const out = [];
  let ContinuationToken;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix, ContinuationToken }));
    out.push(...(r.Contents || []));
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

// Folder name for a backup taken at `d` (IST): 2026-11-08T0200
const folderOf = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 16).replace(":", "");
// Backup folders older than the retention period (from the folder name).
function expiredFolders(keys, now = Date.now(), days = RETAIN_DAYS) {
  const folders = new Set(keys.map((k) => k.slice(ROOT.length).split("/")[0]).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{4}$/.test(f)));
  return [...folders].filter((f) => {
    const t = Date.parse(`${f.slice(0, 13)}:${f.slice(13)}:00+05:30`);
    return Number.isFinite(t) && now - t > days * 86400000;
  });
}

/* ---------------- status ---------------- */
const statusCol = () => require("mongoose").connection.db.collection("backup_status");
async function status() {
  const c = config();
  const last = await statusCol().findOne({ _id: STATUS_ID }).catch(() => null);
  return { configured: c.configured, missing: c.missing, bucket: c.bucket, region: c.region, schedule: "Every night at 02:00 IST, kept 30 days", last: last || null, running };
}
async function saveStatus(s) {
  await statusCol().updateOne({ _id: STATUS_ID }, { $set: s }, { upsert: true });
}

/* ---------------- run ---------------- */
let running = false;

async function runBackup({ client, now = new Date() } = {}) {
  const c = config();
  if (!c.configured) return { skipped: true, reason: "not configured", missing: c.missing };
  if (running) return { skipped: true, reason: "already running" };
  running = true;
  const started = Date.now();
  const folder = folderOf(now);
  const prefix = `${ROOT}${folder}/`;
  try {
    const key = backupKey(c.key);
    const cli = client || s3(c);
    const { PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
    const db = require("mongoose").connection.db;
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => !n.startsWith("system.")).sort();
    const manifest = { app: "OrdexaGo", version: 1, createdAt: now.toISOString(), folder, encryption: "AES-256-GCM (BACKUP_KEY), file = 'OXBK1' | iv(12) | ciphertext | tag(16)", format: "gzip of newline-delimited canonical Extended JSON", collections: [] };
    let bytes = 0;
    for (const name of names) {
      const { gz, count } = await dumpDocs(db.collection(name).find({}));
      const enc = encryptBlob(gz, key);
      const Key = `${prefix}${encodeURIComponent(name)}.ndjson.gz.enc`;
      await cli.send(new PutObjectCommand({ Bucket: c.bucket, Key, Body: enc, ContentType: "application/octet-stream" }));
      manifest.collections.push({ name, count, key: Key, bytes: enc.length, sha256: sha256(enc), gzSha256: sha256(gz) });
      bytes += enc.length;
    }
    manifest.totalBytes = bytes;
    manifest.totalRecords = manifest.collections.reduce((a, x) => a + x.count, 0);
    await cli.send(new PutObjectCommand({ Bucket: c.bucket, Key: `${prefix}manifest.json`, Body: JSON.stringify(manifest, null, 1), ContentType: "application/json" }));
    // Retention
    const all = await listAll(cli, c.bucket, ROOT);
    const old = expiredFolders(all.map((o) => o.Key), now.getTime());
    let deleted = 0;
    for (const o of all) if (old.some((f) => o.Key.startsWith(`${ROOT}${f}/`))) (await cli.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: o.Key })), deleted++);
    const r = { ok: true, at: now, folder, collections: names.length, records: manifest.totalRecords, bytes, seconds: Math.round((Date.now() - started) / 1000), deletedOld: old.length, error: "" };
    await saveStatus({ last: r, lastOkAt: now, lastDay: folder.slice(0, 10) });
    console.log(`Backup ${folder}: ${names.length} collections, ${manifest.totalRecords} records, ${(bytes / 1048576).toFixed(1)} MB${old.length ? `; removed ${old.length} old backup(s)` : ""}`);
    return r;
  } catch (e) {
    const r = { ok: false, at: now, folder, error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    await saveStatus({ last: r, lastDay: folder.slice(0, 10) }).catch(() => {});
    console.error(`Backup failed: ${e.message}`);
    await failed(e).catch(() => {});
    return r;
  } finally {
    running = false;
  }
}

async function failed(e) {
  const User = require("../models/User");
  const { sendSystemMail } = require("./mailer");
  require("./audit").log(null, "backup_failed", { organization: null, user: null, email: "", meta: { error: String(e.message).slice(0, 300) } });
  for (const u of await User.find({ superadmin: true }, { email: 1 }).lean()) await sendSystemMail(u.email, "[OrdexaGo] Nightly backup failed", `The encrypted nightly backup to OCI Object Storage failed:\n\n${e.message}\n\nSee Superadmin → Backups. It will try again tonight at 02:00 IST.`).catch(() => {});
}

// Due when it's past 02:00 IST and tonight's backup hasn't run yet.
function due(now = new Date(), lastDay = "") {
  const ist = new Date(now.getTime() + 5.5 * 3600e3);
  return ist.getUTCHours() >= 2 && ist.toISOString().slice(0, 10) !== lastDay;
}

async function tick() {
  if (!config().configured || running) return;
  const s = await statusCol().findOne({ _id: STATUS_ID });
  if (due(new Date(), s?.lastDay || "")) await runBackup();
}

function startSchedule() {
  setInterval(() => tick().catch((e) => console.error("Backup check failed:", e.message)), 5 * 60 * 1000).unref();
}

module.exports = { config, backupKey, encryptBlob, decryptBlob, sha256, dumpDocs, loadDocs, s3, getObject, listAll, folderOf, expiredFolders, status, runBackup, due, tick, startSchedule, ROOT, RETAIN_DAYS };
