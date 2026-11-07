// Encrypted off-site backups (no database, no network: the DB and the S3 client are fakes).
const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const B = require("../src/utils/backup");

const KEY = "c".repeat(64);
const ENV = { BACKUP_KEY: KEY, OCI_BACKUP_BUCKET: "ordexago-backups", OCI_BACKUP_NAMESPACE: "axabc123", OCI_BACKUP_ACCESS_KEY: "ak", OCI_BACKUP_SECRET: "sk" };

test("not configured: skipped quietly", async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  const c = B.config();
  assert.equal(c.configured, false);
  assert.equal(c.region, "ap-hyderabad-1");
  assert.deepEqual((await B.runBackup()).skipped, true);
});

test("endpoint for OCI's S3-compatible API", () => {
  Object.assign(process.env, ENV);
  assert.equal(B.config().endpoint, "https://axabc123.compat.objectstorage.ap-hyderabad-1.oraclecloud.com");
});

test("encrypt / decrypt; wrong key or tampering fails", () => {
  const k = B.backupKey(KEY);
  const blob = B.encryptBlob(Buffer.from("hello"), k);
  assert.equal(B.decryptBlob(blob, k).toString(), "hello");
  assert.throws(() => B.decryptBlob(blob, B.backupKey("d".repeat(64))));
  blob[20] ^= 1;
  assert.throws(() => B.decryptBlob(blob, k));
});

test("schedule: once a night after 02:00 IST", () => {
  assert.equal(B.due(new Date("2026-11-07T20:29:00Z"), "2026-11-07"), false); // 01:59 IST on the 8th... last ran the 7th
  assert.equal(B.due(new Date("2026-11-07T20:31:00Z"), "2026-11-07"), true); // 02:01 IST on the 8th
  assert.equal(B.due(new Date("2026-11-07T22:00:00Z"), "2026-11-08"), false); // already ran tonight
});

test("retention: folders older than 30 days", () => {
  const now = Date.parse("2026-12-10T00:00:00Z");
  const keys = ["ordexago-backups/2026-11-08T0200/manifest.json", "ordexago-backups/2026-11-08T0200/users.ndjson.gz.enc", "ordexago-backups/2026-11-12T0200/manifest.json", "ordexago-backups/junk/x"];
  assert.deepEqual(B.expiredFolders(keys, now), ["2026-11-08T0200"]);
});

test("a backup run: every collection encrypted, manifest with counts + sha256, restore round trip", async () => {
  Object.assign(process.env, ENV);
  const oid = new mongoose.Types.ObjectId();
  const data = {
    users: [{ _id: oid, email: "a@b.in", createdAt: new Date("2026-11-01T00:00:00Z") }],
    invoices: [{ _id: new mongoose.Types.ObjectId(), total: 1180.5, lines: [{ qty: 2 }] }, { _id: new mongoose.Types.ObjectId(), total: 10 }],
    backup_status: [],
  };
  const status = {};
  const fakeDb = {
    listCollections: () => ({ toArray: async () => Object.keys(data).map((name) => ({ name })) }),
    collection: (name) => ({
      find: () => (async function* () { yield* data[name] || []; })(),
      findOne: async () => status.doc || null,
      updateOne: async (q, u) => (status.doc = { ...(status.doc || {}), ...u.$set }),
    }),
  };
  Object.defineProperty(mongoose.connection, "db", { value: fakeDb, configurable: true, writable: true });
  const put = {};
  const client = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === "PutObjectCommand") put[cmd.input.Key] = Buffer.from(cmd.input.Body);
      if (n === "ListObjectsV2Command") return { Contents: [...Object.keys(put), "ordexago-backups/2026-09-01T0200/users.ndjson.gz.enc"].map((Key) => ({ Key })) };
      if (n === "DeleteObjectCommand") put.deleted = (put.deleted || 0) + 1;
      return {};
    },
  };
  const r = await B.runBackup({ client, now: new Date("2026-11-07T20:30:00Z") });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.folder, "2026-11-08T0200");
  assert.equal(r.records, 3);
  assert.equal(put.deleted, 1, "the September backup is removed");
  const manifest = JSON.parse(put["ordexago-backups/2026-11-08T0200/manifest.json"]);
  assert.deepEqual(manifest.collections.map((c) => [c.name, c.count]), [["backup_status", 0], ["invoices", 2], ["users", 1]]);
  const u = manifest.collections.find((c) => c.name === "users");
  const enc = put[u.key];
  assert.ok(!enc.toString("latin1").includes("a@b.in"), "encrypted");
  assert.equal(B.sha256(enc), u.sha256);
  const docs = B.loadDocs(B.decryptBlob(enc, B.backupKey(KEY)));
  assert.equal(String(docs[0]._id), String(oid));
  assert.ok(docs[0]._id instanceof mongoose.mongo.ObjectId, "ObjectIds kept");
  assert.ok(docs[0].createdAt instanceof Date, "dates kept");
  assert.equal(status.doc.last.ok, true);
  assert.equal(status.doc.lastDay, "2026-11-08");
});
