/**
 * Inbox media (received WhatsApp photos / documents, files staff attach to replies) in GridFS bucket
 * "inbox_media", like transaction attachments. Served to signed-in users at /api/inbox/media/:id.
 * Kept for MarketingConfig.retention.mediaDays (default 180).
 */
const mongoose = require("mongoose");
const { Readable } = require("stream");

const MAX = 16 * 1024 * 1024;
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "inbox_media" });

async function storeMedia(org, buf, { name = "file", mime = "application/octet-stream" } = {}) {
  if (!buf?.length) throw new Error("Empty file");
  if (buf.length > MAX) throw new Error("Files can be up to 16 MB");
  const id = new mongoose.Types.ObjectId();
  await new Promise((resolve, reject) => {
    Readable.from(buf).pipe(bucket().openUploadStreamWithId(id, name, { metadata: { organization: String(org), type: mime } })).on("finish", resolve).on("error", reject);
  });
  return { fileId: id, url: `/api/inbox/media/${id}`, mime, name, size: buf.length };
}

async function fileOf(org, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const f = await mongoose.connection.db.collection("inbox_media.files").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  if (!f || String(f.metadata?.organization) !== String(org)) return null;
  return f;
}
const streamOf = (id) => bucket().openDownloadStream(new mongoose.Types.ObjectId(String(id)));

async function readMedia(org, id) {
  const f = await fileOf(org, id);
  if (!f) return null;
  const chunks = [];
  for await (const c of streamOf(f._id)) chunks.push(c);
  return { buf: Buffer.concat(chunks), mime: f.metadata?.type || "application/octet-stream", name: f.filename };
}

// Delete media older than `days` for one company (files only; the message keeps its text and a "removed" note).
async function purgeMedia(org, days) {
  const files = mongoose.connection.db.collection("inbox_media.files");
  const old = (await files.find({ uploadDate: { $lt: new Date(Date.now() - days * 86400000) } }, { projection: { _id: 1, metadata: 1 } }).toArray()).filter((f) => String(f.metadata?.organization) === String(org));
  for (const f of old) await bucket().delete(f._id).catch(() => {});
  return old.length;
}

module.exports = { storeMedia, fileOf, streamOf, readMedia, purgeMedia, MAX };
