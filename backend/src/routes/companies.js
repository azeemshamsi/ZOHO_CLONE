// The companies the signed-in user belongs to: list, create, set as default. Mounted at /api/companies.
const router = require("express").Router();
const Joi = require("joi");
const Organization = require("../models/Organization");
const Membership = require("../models/Membership");
const User = require("../models/User");
const { ah, validate, HttpError } = require("../utils/http");

router.get(
  "/",
  ah(async (req, res) => {
    const ms = await Membership.find({ user: req.user._id, status: "active" }).populate("organization", "name gstin state").lean();
    const { resolveRole } = require("../utils/roles");
    const out = [];
    for (const m of ms.filter((x) => x.organization)) out.push({ _id: m.organization._id, name: m.organization.name, gstin: m.organization.gstin, state: m.organization.state, role: (await resolveRole(m.role, m.organization._id)).label, current: String(m.organization._id) === String(req.org) });
    res.send(out);
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const d = validate(Joi.object({ name: Joi.string().trim().min(2).max(150).required().label("Company name"), state: Joi.string().required().label("State"), gstin: Joi.string().allow("").uppercase().pattern(/^$|^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).message("GSTIN doesn't look right") }), req.body);
    const org = await Organization.create({ name: d.name, state: d.state, gstin: d.gstin || "", email: req.user.email, address: { state: d.state } });
    await Membership.create({ user: req.user._id, organization: org._id, role: "admin", status: "active" });
    res.status(201).send(org);
  })
);

// Remember the company to open next time (on any device).
router.post(
  "/:id/default",
  ah(async (req, res) => {
    if (!(await Membership.exists({ user: req.user._id, organization: req.params.id, status: "active" }))) throw new HttpError(404, "Company not found");
    await User.updateOne({ _id: req.user._id }, { organization: req.params.id });
    res.send({ ok: true });
  })
);
/**
 * Delete a company and everything in it — for good. Only an admin of that company can, and they
 * must type the company's name. Users left without any company are removed too.
 */
router.delete(
  "/:id",
  ah(async (req, res) => {
    const mongoose = require("mongoose");
    const { confirmName } = validate(Joi.object({ confirmName: Joi.string().allow("").required() }), req.body || {});
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Company not found");
    const org = await Organization.findById(req.params.id);
    const m = org && (await Membership.findOne({ user: req.user._id, organization: org._id, status: "active" }));
    if (!m) throw new HttpError(404, "Company not found");
    if (m.role !== "admin") throw new HttpError(403, "Only an admin of this company can delete it");
    if (confirmName.trim().toLowerCase() !== org.name.trim().toLowerCase()) throw new HttpError(400, `Type the company name exactly ("${org.name}") to confirm`);
    const id = org._id;

    // Files in GridFS (attachments)
    const Attachment = require("../models/Attachment");
    const files = await Attachment.find({ organization: id }, { fileId: 1 }).lean();
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "attachments" });
    for (const f of files) await bucket.delete(f.fileId).catch(() => {});

    // A store shared with other companies stops being shared; this company leaves stores it was shared into.
    const ShopifyStore = require("../models/ShopifyStore");
    await ShopifyStore.updateMany({ sharedWith: id }, { $pull: { sharedWith: id } });

    // Every collection that belongs to a company (load all models so none is missed).
    const dir = require("path").join(__dirname, "..", "models");
    for (const f of require("fs").readdirSync(dir)) if (f.endsWith(".js") && f !== "shared.js") require(require("path").join(dir, f));
    const counts = {};
    for (const name of mongoose.modelNames()) {
      if (["Organization", "User", "Membership"].includes(name)) continue;
      const M = mongoose.model(name);
      if (!M.schema.path("organization")) continue;
      const r = await M.deleteMany({ organization: id });
      if (r.deletedCount) counts[name] = r.deletedCount;
    }

    // People: drop their membership; anyone left with no company is removed; default company moves on.
    const members = await Membership.find({ organization: id }).lean();
    await Membership.deleteMany({ organization: id });
    let signedOut = false;
    for (const mm of members) {
      const other = await Membership.findOne({ user: mm.user, status: { $ne: "inactive" } }).sort({ createdAt: 1 }).lean();
      if (!other) {
        await User.deleteOne({ _id: mm.user });
        await require("../models/Token").deleteMany({ userId: mm.user });
        if (String(mm.user) === String(req.user._id)) signedOut = true;
      } else {
        await User.updateOne({ _id: mm.user, organization: id }, { organization: other.organization });
      }
    }
    const Token = require("../models/Token");
    for (const u of await User.find({ organization: id }, { _id: 1 }).lean()) {
      const other = await Membership.findOne({ user: u._id }).lean();
      if (other) await User.updateOne({ _id: u._id }, { organization: other.organization });
      else {
        await User.deleteOne({ _id: u._id });
        await Token.deleteMany({ userId: u._id });
        if (String(u._id) === String(req.user._id)) signedOut = true;
      }
    }
    await org.deleteOne();
    const next = signedOut ? null : await Membership.findOne({ user: req.user._id, status: "active" }).lean();
    res.send({ message: `${org.name} has been deleted`, deleted: counts, next: next ? String(next.organization) : null, signedOut });
  })
);
module.exports = router;
