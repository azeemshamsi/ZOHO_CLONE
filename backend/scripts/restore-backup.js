#!/usr/bin/env node
/**
 * Restore an OrdexaGo backup from OCI Object Storage. DRY RUN by default: downloads, verifies each file's SHA-256,
 * decrypts with BACKUP_KEY, and checks the record counts against the manifest — nothing is written.
 *
 *   cd /opt/ordexago/backend
 *   node scripts/restore-backup.js --list                       # backups in the bucket
 *   node scripts/restore-backup.js                              # verify the latest backup (dry run)
 *   node scripts/restore-backup.js --backup 2026-11-08T0200     # verify that one
 *   node scripts/restore-backup.js --backup … --apply --uri "mongodb://…"            # restore into an EMPTY database
 *   node scripts/restore-backup.js --backup … --apply --uri "…" --only users,invoices --drop   # replace collections
 *
 * Reads BACKUP_KEY and OCI_BACKUP_* from backend/.env. --apply needs --uri (the target database) so a restore is
 * never written over the live database by accident; collections that already have data are skipped unless --drop.
 */
require("../src/config/env");
const B = require("../src/utils/backup");

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

(async () => {
  const c = B.config();
  if (!c.configured) throw new Error(`Missing in .env: ${c.missing.join(", ")}`);
  const client = B.s3(c);
  const objects = await B.listAll(client, c.bucket, B.ROOT);
  const folders = [...new Set(objects.map((o) => o.Key.slice(B.ROOT.length).split("/")[0]))].filter((f) => objects.some((o) => o.Key === `${B.ROOT}${f}/manifest.json`)).sort();
  if (flag("list")) {
    for (const f of folders) console.log(f);
    if (!folders.length) console.log("No backups found");
    return;
  }
  const folder = opt("backup") || folders[folders.length - 1];
  if (!folder) throw new Error("No backups found in the bucket");
  if (!folders.includes(folder)) throw new Error(`No backup named ${folder}. Backups in the bucket:\n${folders.join("\n")}\n(or leave out --backup to check the latest)`);
  const manifest = JSON.parse((await B.getObject(client, c.bucket, `${B.ROOT}${folder}/manifest.json`)).toString("utf8"));
  const key = B.backupKey(c.key);
  const only = opt("only") ? opt("only").split(",").map((s) => s.trim()) : null;
  const apply = flag("apply");
  let target = null;
  if (apply) {
    const uri = opt("uri");
    if (!uri) throw new Error("--apply needs --uri <target database connection string>");
    const { MongoClient } = require("mongoose").mongo;
    const mc = new MongoClient(uri, { retryWrites: false });
    await mc.connect();
    target = { mc, db: mc.db() };
  }
  console.log(`Backup ${folder} (${manifest.createdAt}): ${manifest.collections.length} collections, ${manifest.totalRecords} records${apply ? "" : " — DRY RUN, nothing is written"}`);
  let problems = 0;
  for (const col of manifest.collections) {
    if (only && !only.includes(col.name)) continue;
    const enc = await B.getObject(client, c.bucket, col.key);
    if (B.sha256(enc) !== col.sha256) {
      console.log(`✗ ${col.name}: checksum doesn't match the manifest`);
      problems++;
      continue;
    }
    let docs;
    try {
      const gz = B.decryptBlob(enc, key);
      if (col.gzSha256 && B.sha256(gz) !== col.gzSha256) throw new Error("decrypted data checksum mismatch");
      docs = B.loadDocs(gz);
    } catch (e) {
      console.log(`✗ ${col.name}: ${e.message} (wrong BACKUP_KEY?)`);
      problems++;
      continue;
    }
    if (docs.length !== col.count) {
      console.log(`✗ ${col.name}: ${docs.length} records, manifest says ${col.count}`);
      problems++;
      continue;
    }
    if (!apply) {
      console.log(`✓ ${col.name}: ${docs.length} records verified`);
      continue;
    }
    const tc = target.db.collection(col.name);
    const existing = await tc.countDocuments({});
    if (existing && !flag("drop")) {
      console.log(`- ${col.name}: target already has ${existing} records — skipped (use --drop to replace)`);
      continue;
    }
    if (existing) await tc.deleteMany({});
    for (let i = 0; i < docs.length; i += 500) await tc.insertMany(docs.slice(i, i + 500), { ordered: false });
    console.log(`✓ ${col.name}: ${docs.length} records restored`);
  }
  if (target) await target.mc.close();
  console.log(problems ? `${problems} problem(s) found` : "All checks passed");
  process.exitCode = problems ? 2 : 0;
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
