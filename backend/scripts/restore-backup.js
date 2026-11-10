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
 *   node scripts/restore-backup.js --download                   # verify the latest + save it as ~/ordexago-backup-<name>.tar.gz
 *   node scripts/restore-backup.js --from ~/ordexago-backup-<name>.tar.gz   # use a downloaded copy instead of the bucket
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
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { execFileSync } = require("child_process");
  const c = B.config();
  let folder, manifest, get;
  const from = opt("from");
  if (from) {
    // A downloaded copy (folder or .tar.gz made by --download): needs only BACKUP_KEY, not the bucket.
    if (!c.key) throw new Error("Missing in .env: BACKUP_KEY");
    let dir = path.resolve(from.replace(/^~/, os.homedir()));
    if (/\.tar\.gz$|\.tgz$/.test(dir)) {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "oxbk-"));
      execFileSync("tar", ["xzf", dir, "-C", out]);
      const sub = fs.readdirSync(out);
      dir = sub.length === 1 && fs.statSync(path.join(out, sub[0])).isDirectory() ? path.join(out, sub[0]) : out;
    }
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    folder = manifest.folder || path.basename(dir);
    get = async (key) => fs.readFileSync(path.join(dir, path.basename(key)));
  } else {
    if (!c.configured) throw new Error(`Missing in .env: ${c.missing.join(", ")}`);
    const client = B.s3(c);
    const objects = await B.listAll(client, c.bucket, B.ROOT);
    const folders = [...new Set(objects.map((o) => o.Key.slice(B.ROOT.length).split("/")[0]))].filter((f) => objects.some((o) => o.Key === `${B.ROOT}${f}/manifest.json`)).sort();
    if (flag("list")) {
      for (const f of folders) console.log(f);
      if (!folders.length) console.log("No backups found");
      return;
    }
    folder = opt("backup") || folders[folders.length - 1];
    if (!folder) throw new Error("No backups found in the bucket");
    if (!folders.includes(folder)) throw new Error(`No backup named ${folder}. Backups in the bucket:\n${folders.join("\n")}\n(or leave out --backup to check the latest)`);
    get = (key) => B.getObject(client, c.bucket, key);
    manifest = JSON.parse((await get(`${B.ROOT}${folder}/manifest.json`)).toString("utf8"));
  }
  const saveDir = flag("download") ? path.join(os.homedir(), `ordexago-backup-${folder}`) : null;
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(path.join(saveDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  }
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
    const enc = await get(col.key);
    if (saveDir) fs.writeFileSync(path.join(saveDir, path.basename(col.key)), enc);
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
  if (saveDir) {
    const tgz = `${saveDir}.tar.gz`;
    execFileSync("tar", ["czf", tgz, "-C", path.dirname(saveDir), path.basename(saveDir)]);
    fs.rmSync(saveDir, { recursive: true, force: true });
    console.log(`Saved (still encrypted): ${tgz}`);
    console.log(`To copy it to your PC, run this in PowerShell on your PC (not on the server):`);
    console.log(`  scp -i "<path to your ssh key>" ubuntu@ordexago.com:${tgz} .`);
  }
  process.exitCode = problems ? 2 : 0;
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
