/**
 * Attachments on any transaction, stored in MongoDB GridFS (Render's disk is wiped on every deploy).
 *   GET    /?docType=bill&docId=…    list
 *   POST   /                         { docType, docId, name, type, data(base64) }  (max 10 MB)
 *   GET    /:id/file                 the file
 *   DELETE /:id
 */
const router = require("express").Router();
const mongoose = require("mongoose");
const Joi = require("joi");
const { Readable } = require("stream");
const Attachment = require("../models/Attachment");
const { ah, validate, HttpError } = require("../utils/http");

// Which permission each document type needs.
const MODULE = {
  invoice: "sales", quote: "sales", salesOrder: "sales", creditNote: "sales", payment: "sales", customer: "sales",
  bill: "purchases", expense: "purchases", purchaseOrder: "purchases", vendorCredit: "purchases", vendorPayment: "purchases", vendor: "purchases",
  journal: "accountant", fixedAsset: "accountant", item: "items", inventoryAdjustment: "items", bankTransaction: "banking",
};
const MAX = 10 * 1024 * 1024;
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "attachments" });

function need(req, docType, level) {
  const mod = MODULE[docType];
  if (!mod) throw new HttpError(400, "Unknown document type");
  const have = req.perms?.[mod] || "none";
  if (have === "none" || (level === "full" && have !== "full")) throw new HttpError(403, "You don't have access to this");
}

router.get(
  "/",
  ah(async (req, res) => {
    const { docType, docId } = req.query;
    need(req, docType, "view");
    if (!mongoose.isValidObjectId(docId)) throw new HttpError(400, "Bad document");
    res.send(await Attachment.find({ organization: req.org, docType, docId }).sort({ createdAt: 1 }).lean());
  })
);

async function store(req, { docType, docId, name, type, buf }) {
  if (buf.length > MAX) throw new HttpError(400, "Files can be up to 10 MB");
  const id = new mongoose.Types.ObjectId();
  await new Promise((resolve, reject) => {
    Readable.from(buf).pipe(bucket().openUploadStreamWithId(id, name, { metadata: { organization: req.org, type } })).on("finish", resolve).on("error", reject);
  });
  return Attachment.create({ organization: req.org, docType, docId, name, type, size: buf.length, fileId: id, uploadedBy: req.user?.name || "" });
}

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(Joi.object({ docType: Joi.string().required(), docId: Joi.string().required(), name: Joi.string().max(200).required(), type: Joi.string().allow(""), data: Joi.string().required() }), req.body);
    need(req, d.docType, "full");
    if (!mongoose.isValidObjectId(d.docId)) throw new HttpError(400, "Bad document");
    const buf = Buffer.from(d.data.replace(/^data:.*?;base64,/, ""), "base64");
    if (!buf.length) throw new HttpError(400, "The file is empty");
    res.status(201).send(await store(req, { ...d, type: d.type || "application/octet-stream", buf }));
  })
);

router.get(
  "/:id/file",
  ah(async (req, res) => {
    const a = await Attachment.findOne({ _id: req.params.id, organization: req.org });
    if (!a) throw new HttpError(404, "File not found");
    need(req, a.docType, "view");
    res.setHeader("Content-Type", a.type || "application/octet-stream");
    res.setHeader("Content-Disposition", `${/^(image|application\/pdf)/.test(a.type) ? "inline" : "attachment"}; filename="${encodeURIComponent(a.name)}"`);
    bucket().openDownloadStream(a.fileId).on("error", () => res.status(404).end()).pipe(res);
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const a = await Attachment.findOne({ _id: req.params.id, organization: req.org });
    if (!a) throw new HttpError(404, "File not found");
    need(req, a.docType, "full");
    await bucket().delete(a.fileId).catch(() => {});
    await a.deleteOne();
    res.send({ ok: true });
  })
);

module.exports = router;
module.exports.store = store;
module.exports.MODULE = MODULE;
