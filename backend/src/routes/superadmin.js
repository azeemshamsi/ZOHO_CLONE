// OrdexaGo's own operator (User.superadmin): subscribers (businesses using OrdexaGo), their plans and validity.
// Mounted at /api/superadmin behind auth; every route needs a superadmin.
const router = require("express").Router();
const crypto = require("crypto");
const Joi = require("joi");
const env = require("../config/env");
const Plan = require("../models/Plan");
const Subscriber = require("../models/Subscriber");
const Organization = require("../models/Organization");
const User = require("../models/User");
const Membership = require("../models/Membership");
const { ah, validate, HttpError } = require("../utils/http");
const { stateOf, usageOf, clearCache } = require("../utils/subscription");

router.use((req, res, next) => (req.user?.superadmin ? next() : res.status(403).send({ message: "Only the OrdexaGo superadmin can do this" })));

/* ---------------- Backups ---------------- */
router.get(
  "/backup",
  ah(async (req, res) => res.send(await require("../utils/backup").status()))
);
router.post(
  "/backup/run",
  ah(async (req, res) => {
    const b = require("../utils/backup");
    if (!b.config().configured) throw new HttpError(400, "Backups aren't configured on the server yet");
    b.runBackup().catch(() => {});
    res.send({ started: true });
  })
);

const limit = Joi.number().integer().min(0).allow(null, "");
const nil = (v) => (v === "" || v === undefined ? null : v);

/* ---------------- Plans ---------------- */
const planJoi = Joi.object({
  name: Joi.string().trim().min(1).max(80).required().label("Plan name"),
  description: Joi.string().allow("").max(500),
  price: Joi.number().min(0),
  period: Joi.string().valid("monthly", "quarterly", "half_yearly", "yearly"),
  maxCompanies: limit,
  maxUsers: limit,
  maxShopifyStores: limit,
  active: Joi.boolean(),
});
const planData = (d) => ({ ...d, maxCompanies: nil(d.maxCompanies), maxUsers: nil(d.maxUsers), maxShopifyStores: nil(d.maxShopifyStores) });

router.get(
  "/plans",
  ah(async (req, res) => {
    const plans = await Plan.find({}).sort({ price: 1, name: 1 }).lean();
    const subs = await Subscriber.find({}, { plan: 1 }).lean();
    res.send(plans.map((p) => ({ ...p, subscribers: subs.filter((s) => String(s.plan) === String(p._id)).length })));
  })
);
router.post(
  "/plans",
  ah(async (req, res) => {
    res.status(201).send(await Plan.create(planData(validate(planJoi, req.body))));
  })
);
router.put(
  "/plans/:id",
  ah(async (req, res) => {
    const p = await Plan.findByIdAndUpdate(req.params.id, planData(validate(planJoi, req.body)), { new: true });
    if (!p) throw new HttpError(404, "Plan not found");
    clearCache();
    res.send(p);
  })
);
router.delete(
  "/plans/:id",
  ah(async (req, res) => {
    if (await Subscriber.exists({ plan: req.params.id })) throw new HttpError(400, "Subscribers are on this plan. Move them to another plan first, or mark it inactive.");
    await Plan.deleteOne({ _id: req.params.id });
    res.send({ ok: true });
  })
);

/* ---------------- Subscribers ---------------- */
async function summary(s) {
  const u = await usageOf(s._id);
  const st = stateOf(s);
  const { orgIds, userIds, ...usage } = u;
  return { ...s, plan: s.plan || null, usage, state: st.state, daysLeft: st.daysLeft, graceLeft: st.graceLeft, payments: undefined, paid: (s.payments || []).reduce((t, p) => t + (p.amount || 0), 0), lastPayment: (s.payments || []).slice(-1)[0] || null };
}

router.get(
  "/subscribers",
  ah(async (req, res) => {
    const subs = await Subscriber.find({}).populate("plan").sort({ owner: -1, name: 1 }).lean();
    const out = [];
    for (const s of subs) out.push(await summary(s));
    res.send(out);
  })
);

router.get(
  "/subscribers/:id",
  ah(async (req, res) => {
    const s = await Subscriber.findById(req.params.id).populate("plan").lean();
    if (!s) throw new HttpError(404, "Subscriber not found");
    const orgs = await Organization.find({ subscriber: s._id }, { name: 1, gstin: 1, state: 1, createdAt: 1 }).lean();
    const ms = orgs.length ? await Membership.find({ organization: { $in: orgs.map((o) => o._id) } }).populate("user", "name email status lastLogin").lean() : [];
    const users = new Map();
    for (const m of ms) {
      if (!m.user) continue;
      const k = String(m.user._id);
      const u = users.get(k) || { _id: m.user._id, name: m.user.name, email: m.user.email, status: m.user.status, lastLogin: m.user.lastLogin, companies: [] };
      u.companies.push({ name: orgs.find((o) => String(o._id) === String(m.organization))?.name || "", role: m.role, status: m.status });
      users.set(k, u);
    }
    res.send({ ...(await summary(s)), payments: s.payments || [], companies: orgs, users: [...users.values()] });
  })
);

const subJoi = {
  name: Joi.string().trim().min(2).max(150).label("Business name"),
  contactName: Joi.string().allow("").max(100),
  email: Joi.string().email().label("Email"),
  phone: Joi.string().allow("").max(20),
  plan: Joi.string().allow("", null),
  validTill: Joi.date().allow(null, ""),
  graceDays: Joi.number().integer().min(0).max(365),
  notes: Joi.string().allow("").max(2000),
};

// Invite link for a user who hasn't set a password yet (14 days), emailed from the server's email account.
async function inviteAdmin(req, user, sub, orgName) {
  user.inviteToken = crypto.randomBytes(24).toString("hex");
  user.inviteExpires = new Date(Date.now() + 14 * 86400000);
  await user.save();
  const base = req.get("origin") || env.APP_URL;
  const link = `${base.replace(/\/+$/, "")}/invite/${user._id}/${user.inviteToken}`;
  let emailed = false;
  try {
    await require("../utils/sendEmail")(
      user.email,
      "Your OrdexaGo account is ready",
      `Hi ${user.name},\n\nYour OrdexaGo account for ${sub.name} is ready${orgName ? ` (company: ${orgName})` : ""}.\n\nSet your password and log in: ${link}\n\nThe link works for 14 days. After that, log in at ${base}/login.\n\nOrdexaGo`
    );
    emailed = true;
  } catch (e) {
    console.error(`[superadmin invite] email failed: ${e.message}`);
  }
  return { link, emailed };
}

router.post(
  "/subscribers",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        ...subJoi,
        name: subJoi.name.required(),
        email: subJoi.email.required(),
        contactName: Joi.string().trim().min(2).max(100).required().label("Contact person"),
        companyName: Joi.string().trim().min(2).max(150).required().label("Company name"),
        state: Joi.string().required().label("State"),
        gstin: Joi.string().allow("").uppercase().pattern(/^$|^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).message("GSTIN doesn't look right"),
      }),
      req.body
    );
    const email = d.email.toLowerCase();
    if (await User.exists({ email })) throw new HttpError(409, "Someone already has an OrdexaGo login with this email");
    if (d.plan && !(await Plan.exists({ _id: d.plan }))) throw new HttpError(400, "Choose a valid plan");
    const sub = await Subscriber.create({ name: d.name, contactName: d.contactName, email, phone: d.phone || "", plan: d.plan || undefined, validTill: d.validTill || undefined, graceDays: d.graceDays ?? 7, notes: d.notes || "", createdBy: req.user._id });
    const org = await Organization.create({ name: d.companyName, state: d.state, gstin: d.gstin || "", email, phone: d.phone || "", address: { state: d.state }, subscriber: sub._id });
    const user = new User({ name: d.contactName, email, role: "admin", organization: org._id, status: "invited", invitedBy: req.user._id, verified: true });
    const inv = await inviteAdmin(req, user, sub, org.name);
    await Membership.create({ user: user._id, organization: org._id, role: "admin", status: "invited", invitedBy: req.user._id });
    res.status(201).send({ subscriber: sub, ...inv });
  })
);

router.put(
  "/subscribers/:id",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ...subJoi, status: Joi.string().valid("active", "suspended") }), req.body);
    const s = await Subscriber.findById(req.params.id);
    if (!s) throw new HttpError(404, "Subscriber not found");
    if (s.owner && d.status === "suspended") throw new HttpError(400, "Your own account can't be suspended");
    if (d.plan && !(await Plan.exists({ _id: d.plan }))) throw new HttpError(400, "Choose a valid plan");
    for (const k of ["name", "contactName", "phone", "graceDays", "notes", "status"]) if (d[k] !== undefined) s[k] = d[k];
    if (d.email) s.email = d.email.toLowerCase();
    if (d.plan !== undefined) s.plan = d.plan || undefined;
    if (d.validTill !== undefined) s.validTill = d.validTill || undefined;
    await s.save();
    clearCache();
    res.send(s);
  })
);

// Payment received outside the app: record it and set the new validity.
router.post(
  "/subscribers/:id/payments",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        date: Joi.date().required().label("Payment date"),
        amount: Joi.number().min(0).required().label("Amount"),
        reference: Joi.string().allow("").max(100),
        note: Joi.string().allow("").max(500),
        validTill: Joi.date().required().label("Valid till"),
      }),
      req.body
    );
    const s = await Subscriber.findById(req.params.id);
    if (!s) throw new HttpError(404, "Subscriber not found");
    s.payments.push({ ...d, validFrom: s.validTill, recordedBy: req.user._id });
    s.validTill = d.validTill;
    if (s.status === "suspended") s.status = "active";
    await s.save();
    clearCache();
    res.status(201).send(s);
  })
);

router.delete(
  "/subscribers/:id/payments/:pid",
  ah(async (req, res) => {
    const s = await Subscriber.findById(req.params.id);
    if (!s) throw new HttpError(404, "Subscriber not found");
    s.payments = s.payments.filter((p) => String(p._id) !== req.params.pid);
    await s.save();
    res.send(s);
  })
);

// Send the set-password link again to the subscriber's users who haven't joined yet.
router.post(
  "/subscribers/:id/resend-invite",
  ah(async (req, res) => {
    const s = await Subscriber.findById(req.params.id);
    if (!s) throw new HttpError(404, "Subscriber not found");
    const orgs = await Organization.find({ subscriber: s._id }, { name: 1 }).lean();
    const ms = orgs.length ? await Membership.find({ organization: { $in: orgs.map((o) => o._id) }, role: "admin" }).lean() : [];
    const users = await User.find({ _id: { $in: ms.map((m) => m.user) } });
    const pending = users.filter((u) => u.status === "invited");
    if (!pending.length) throw new HttpError(400, "Everyone has already set a password. They can use “Forgot password” on the login page.");
    const out = [];
    for (const u of pending) out.push({ email: u.email, ...(await inviteAdmin(req, u, s, orgs.find((o) => String(o._id) === String(u.organization))?.name)) });
    res.send({ invites: out });
  })
);

module.exports = router;
