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
module.exports = router;
