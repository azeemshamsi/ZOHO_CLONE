/**
 * Database compatibility check: runs every kind of query OrdexaGo uses against the database in
 * MONGODB_URI, in throw-away collections, and prints PASS/FAIL for each. Nothing of yours is touched.
 *
 *   cd backend && node scripts/dbcheck.js        (reads backend/.env)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const connect = require("../src/config/database");

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || "value"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

(async () => {
  await connect();
  const P = `zz_dbcheck_${Date.now().toString(36)}`;
  const Org = new mongoose.Types.ObjectId();
  const Line = new mongoose.Schema({ name: String, qty: Number, rate: Number, taxRate: Number }, { _id: false });
  const Doc = mongoose.model(
    `${P}_doc`,
    new mongoose.Schema(
      {
        organization: { type: mongoose.Schema.Types.ObjectId, index: true },
        number: String,
        name: String,
        status: String,
        date: Date,
        total: Number,
        tags: [String],
        lines: [Line],
        meta: { a: String, b: Number },
        party: { type: mongoose.Schema.Types.ObjectId, ref: `${P}_party` },
        importRef: { type: String, index: true },
      },
      { timestamps: true }
    ),
    `${P}_docs`
  );
  const Party = mongoose.model(`${P}_party`, new mongoose.Schema({ organization: mongoose.Schema.Types.ObjectId, displayName: String, gstin: String }), `${P}_parties`);
  const Uniq = mongoose.model(`${P}_uniq`, (() => {
    const s = new mongoose.Schema({ organization: mongoose.Schema.Types.ObjectId, key: String, seq: Number });
    s.index({ organization: 1, key: 1 }, { unique: true });
    return s;
  })(), `${P}_uniqs`);

  try {
    await check("insert + find by id", async () => {
      const p = await Party.create({ organization: Org, displayName: "Acme Traders", gstin: "09ABCDE1234F1Z5" });
      const d = await Doc.create({ organization: Org, number: "INV-000001", name: "Teak Table", status: "sent", date: new Date("2026-07-05"), total: 1180.5, tags: ["a", "b"], lines: [{ name: "x", qty: 2, rate: 500, taxRate: 18 }], meta: { a: "x", b: 2 }, party: p._id });
      const back = await Doc.findById(d._id).lean();
      eq(back.total, 1180.5, "total");
      eq(back.lines[0].qty, 2, "nested array");
      eq(String(back.party), String(p._id), "ObjectId");
      if (!(back.date instanceof Date)) throw new Error("date did not come back as a Date");
    });
    await Doc.insertMany(
      Array.from({ length: 30 }, (_, i) => ({ organization: Org, number: `INV-${String(i + 2).padStart(6, "0")}`, name: i % 2 ? "Sheesham Chair" : "metal table", status: ["draft", "sent", "paid", "void"][i % 4], date: new Date(Date.UTC(2026, 6, 1 + i)), total: 100 * (i + 1), tags: i % 3 ? ["x"] : [], lines: [{ name: "l", qty: i, rate: 10, taxRate: i % 2 ? 5 : 18 }] }))
    );
    await check("comparison, $in, $nin, $ne, ranges on dates", async () => {
      const n = await Doc.countDocuments({ organization: Org, status: { $nin: ["draft", "void"] }, date: { $gte: new Date("2026-07-01"), $lte: new Date("2026-07-15T23:59:59Z") }, total: { $gt: 0 } });
      if (!n) throw new Error("no rows");
      return `${n} rows`;
    });
    await check("case-insensitive search (RegExp)", async () => {
      const r = await Doc.find({ organization: Org, name: new RegExp("METAL", "i") }).lean();
      if (r.length !== 15) throw new Error(`expected 15, got ${r.length}`);
      const s = await Doc.find({ organization: Org, $or: [{ number: { $regex: "inv-00000[2-3]", $options: "i" } }, { name: { $regex: "^sheesham", $options: "i" } }] }).lean();
      if (!s.length) throw new Error("$regex with $options found nothing");
      const exact = await Party.findOne({ organization: Org, displayName: new RegExp("^acme traders$", "i") }).lean();
      if (!exact) throw new Error("anchored RegExp found nothing");
    });
    await check("$exists, $size, $elemMatch, $all, dotted paths", async () => {
      await Doc.find({ importRef: { $exists: false }, organization: Org }).limit(1);
      const e = await Doc.find({ organization: Org, tags: { $size: 0 } }).lean();
      const m = await Doc.find({ organization: Org, lines: { $elemMatch: { taxRate: 5, qty: { $gte: 3 } } } }).lean();
      const d = await Doc.find({ organization: Org, "lines.taxRate": 18, "meta.b": { $exists: false } }).lean();
      if (!e.length || !m.length || !d.length) throw new Error(`empty: size=${e.length} elemMatch=${m.length} dotted=${d.length}`);
    });
    await check("sort, skip, limit, projection (include, exclude, dotted)", async () => {
      const r = await Doc.find({ organization: Org }, { number: 1, total: 1, "lines.qty": 1 }).sort({ date: -1, number: 1 }).skip(2).limit(5).lean();
      eq(r.length, 5, "rows");
      if (r[0].name !== undefined) throw new Error("projection not applied");
      const x = await Doc.findOne({ organization: Org }, { lines: 0 }).lean();
      if (x.lines) throw new Error("exclusion projection not applied");
    });
    await check("populate", async () => {
      const r = await Doc.findOne({ organization: Org, party: { $ne: null } }).populate("party", "displayName gstin").lean();
      eq(r.party.displayName, "Acme Traders", "populated name");
    });
    await check("update operators ($set, $inc, $push, $pull, $addToSet, $unset, positional)", async () => {
      const d = await Doc.findOne({ organization: Org, number: "INV-000001" });
      await Doc.updateOne({ _id: d._id }, { $set: { status: "paid", "meta.a": "y" }, $inc: { total: 10 }, $push: { tags: "c" }, $unset: { importRef: "" } });
      await Doc.updateOne({ _id: d._id }, { $pull: { tags: "a" } });
      await Doc.updateOne({ _id: d._id }, { $addToSet: { tags: "b" } });
      await Doc.updateOne({ _id: d._id, "lines.name": "x" }, { $set: { "lines.$.qty": 9 } });
      const b = await Doc.findById(d._id).lean();
      eq([b.status, b.total, b.meta.a, b.tags, b.lines[0].qty], ["paid", 1190.5, "y", ["b", "c"], 9], "after updates");
    });
    await check("findOneAndUpdate with upsert ($inc counter)", async () => {
      const a = await Uniq.findOneAndUpdate({ organization: Org, key: "invoice" }, { $inc: { seq: 1 } }, { upsert: true, new: true });
      const b = await Uniq.findOneAndUpdate({ organization: Org, key: "invoice" }, { $inc: { seq: 1 } }, { upsert: true, new: true });
      eq([a.seq, b.seq], [1, 2], "counter");
    });
    await check("unique index blocks duplicates", async () => {
      await Uniq.syncIndexes();
      try {
        await Uniq.create({ organization: Org, key: "invoice", seq: 99 });
      } catch (e) {
        if (e.code === 11000 || /duplicate|unique/i.test(e.message)) return "duplicate rejected";
        throw e;
      }
      throw new Error("duplicate was accepted — unique indexes aren't enforced");
    });
    await check("countDocuments, estimatedDocumentCount, distinct", async () => {
      const c = await Doc.countDocuments({ organization: Org, status: "paid" });
      const all = await Doc.estimatedDocumentCount();
      const ds = await Doc.distinct("status", { organization: Org });
      if (!c || !all || ds.length !== 4) throw new Error(`count=${c} est=${all} distinct=${ds}`);
    });
    await check("aggregate $match + $group + $sort", async () => {
      const r = await Doc.aggregate([{ $match: { organization: Org } }, { $group: { _id: "$status", n: { $sum: 1 }, amount: { $sum: "$total" } } }, { $sort: { _id: 1 } }]);
      eq(r.length, 4, "groups");
    });
    await check("deleteOne, deleteMany", async () => {
      await Doc.deleteOne({ organization: Org, number: "INV-000031" });
      const r = await Doc.deleteMany({ organization: Org, status: "void" });
      if (!r.deletedCount) throw new Error("deleted nothing");
    });
    await check("bulkWrite", async () => {
      const ids = (await Doc.find({ organization: Org }, { _id: 1 }).limit(3).lean()).map((x) => x._id);
      const r = await Doc.bulkWrite(ids.map((_id) => ({ updateOne: { filter: { _id }, update: { $set: { status: "bulk" } } } })));
      eq(r.modifiedCount, 3, "modified");
    });
    await check("GridFS upload, read back, delete (attachments)", async () => {
      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: `${P}_files` });
      const buf = Buffer.alloc(700 * 1024, 7); // spans several chunks
      buf.write("%PDF-1.7 test", 0);
      const id = await new Promise((resolve, reject) => {
        const up = bucket.openUploadStream("test.pdf", { contentType: "application/pdf" });
        up.on("error", reject).on("finish", () => resolve(up.id));
        up.end(buf);
      });
      const chunks = [];
      await new Promise((resolve, reject) => bucket.openDownloadStream(id).on("data", (c) => chunks.push(c)).on("error", reject).on("end", resolve));
      const back = Buffer.concat(chunks);
      if (!back.equals(buf)) throw new Error(`file came back different (${back.length} of ${buf.length} bytes)`);
      await bucket.delete(id);
      await mongoose.connection.db.collection(`${P}_files.files`).drop().catch(() => {});
      await mongoose.connection.db.collection(`${P}_files.chunks`).drop().catch(() => {});
    });
    await check("TTL index can be created (login tokens)", async () => {
      await mongoose.connection.db.collection(`${P}_ttl`).createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    });
    await check("large document (bank statement import)", async () => {
      const big = await Doc.create({ organization: Org, number: "BIG", name: "x".repeat(200000), lines: Array.from({ length: 500 }, (_, i) => ({ name: `line ${i}`, qty: i, rate: 1, taxRate: 0 })) });
      const b = await Doc.findById(big._id).lean();
      eq(b.lines.length, 500, "lines");
    });
  } finally {
    for (const c of [`${P}_docs`, `${P}_parties`, `${P}_uniqs`, `${P}_ttl`]) await mongoose.connection.db.collection(c).drop().catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — failing: ${failed.map((f) => f.name).join("; ")}` : ". This database works with OrdexaGo."}`);
    await mongoose.disconnect();
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => {
  console.error("Couldn't run the check:", e.message);
  process.exit(2);
});
