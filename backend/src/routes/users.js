const router = require("express").Router();
const crypto = require("crypto");
const Joi = require("joi");
const env = require("../config/env");
const User = require("../models/User");
const Organization = require("../models/Organization");
const Membership = require("../models/Membership");
const Role = require("../models/Role");
const { ROLES, resolveRole } = require("../utils/roles");
const { ah, validate, HttpError } = require("../utils/http");

// A role key is a built-in role or "custom:<id>" of a role in this company.
async function checkRole(org, role) {
  if (ROLES[role]) return role;
  if (/^custom:[a-f0-9]{24}$/.test(role) && (await Role.exists({ _id: role.slice(7), organization: org }))) return role;
  throw new HttpError(400, "Choose a valid role");
}
const pub = (u, m) => ({ _id: u._id, name: u.name, email: u.email, role: m.role, status: m.status === "invited" || u.status === "invited" ? "invited" : m.status, lastLogin: u.lastLogin, createdAt: m.createdAt });

async function invite(req, user, role) {
  user.inviteToken = crypto.randomBytes(24).toString("hex");
  user.inviteExpires = new Date(Date.now() + 7 * 86400000);
  await user.save();
  // Use the address the admin is on, so the link works whatever APP_URL says.
  const base = req.get("origin") || (req.get("host") ? `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}` : env.APP_URL);
  const link = `${base.replace(/\/+$/, "")}/invite/${user._id}/${user.inviteToken}`;
  const org = await Organization.findById(req.org);
  // Send from the organization's email account (or the server's); if that fails, the admin still gets the link to share.
  let sent = false;
  const { canEmail, sendOrgMail } = require("../utils/mailer");
  if (canEmail(org))
    try {
      await sendOrgMail(org, {
        to: [user.email],
        subject: `${req.user.name} invited you to ${org.name} on OrdexaGo`,
        text: `Hi ${user.name},\n\n${req.user.name} has invited you to join ${org.name} on OrdexaGo as ${(await resolveRole(role, req.org)).label}.\n\nAccept the invitation and set your password: ${link}\n\nThe link works for 7 days.`,
      });
      sent = true;
    } catch (e) {
      console.error(`[invite] email failed: ${e.message}`);
    }
  return { link, emailed: sent };
}

router.get(
  "/roles",
  ah(async (req, res) => {
    const custom = await Role.find({ organization: req.org }).sort({ name: 1 }).lean();
    res.send([...Object.entries(ROLES).map(([key, r]) => ({ key, ...r, builtIn: true })), ...custom.map((r) => ({ key: `custom:${r._id}`, _id: r._id, label: r.name, desc: r.desc, perms: r.perms, home: r.home, builtIn: false }))]);
  })
);

router.get(
  "/",
  ah(async (req, res) => {
    const ms = await Membership.find({ organization: req.org }).populate("user").sort({ createdAt: 1 });
    res.send(ms.filter((m) => m.user).map((m) => ({ ...pub(m.user, m), you: String(m.user._id) === String(req.user._id) })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(100).required().label("Name"),
        email: Joi.string().email().required().label("Email"),
        role: Joi.string().required().label("Role"),
      }),
      req.body
    );
    const role = await checkRole(req.org, data.role);
    const email = data.email.toLowerCase();
    let user = await User.findOne({ email });
    if (user) {
      // Already has an OrdexaGo login (e.g. in your other company): just give access here.
      if (await Membership.exists({ user: user._id, organization: req.org })) throw new HttpError(409, "This person already has access to this company");
      const m = await Membership.create({ user: user._id, organization: req.org, role, status: user.status === "invited" ? "invited" : "active", invitedBy: req.user._id });
      if (user.status === "invited") return res.status(201).send({ user: pub(user, m), ...(await invite(req, user, role)) });
      return res.status(201).send({ user: pub(user, m), added: true, message: `${user.name} already has an OrdexaGo login and can now open this company from the company switcher.` });
    }
    user = new User({ name: data.name, email, role, organization: req.org, status: "invited", invitedBy: req.user._id, verified: true });
    const r = await invite(req, user, role);
    const m = await Membership.create({ user: user._id, organization: req.org, role, status: "invited", invitedBy: req.user._id });
    res.status(201).send({ user: pub(user, m), ...r });
  })
);

router.post(
  "/:id/resend",
  ah(async (req, res) => {
    const m = await Membership.findOne({ user: req.params.id, organization: req.org });
    const user = m && (await User.findById(req.params.id));
    if (!user) throw new HttpError(404, "User not found");
    if (user.status !== "invited") throw new HttpError(400, "This user has already joined");
    res.send(await invite(req, user, m.role));
  })
);

// Make sure a company always keeps at least one active admin.
async function guardLastAdmin(req, m, next) {
  if (m.role !== "admin" || m.status !== "active") return;
  if (next.role === "admin" && next.status === "active") return;
  const admins = await Membership.countDocuments({ organization: req.org, role: "admin", status: "active" });
  if (admins <= 1) throw new HttpError(400, "There must be at least one active admin");
}

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(Joi.object({ name: Joi.string().trim().min(2).max(100), role: Joi.string(), status: Joi.string().valid("active", "inactive") }), req.body);
    const m = await Membership.findOne({ user: req.params.id, organization: req.org });
    const user = m && (await User.findById(req.params.id));
    if (!user) throw new HttpError(404, "User not found");
    if (data.role) data.role = await checkRole(req.org, data.role);
    if (data.status && m.status === "invited") throw new HttpError(400, "This user hasn't accepted the invitation yet");
    await guardLastAdmin(req, m, { role: data.role || m.role, status: data.status || m.status });
    if (data.role) m.role = data.role;
    if (data.status) m.status = data.status;
    await m.save();
    if (data.name) {
      user.name = data.name;
      await user.save();
    }
    res.send(pub(user, m));
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const m = await Membership.findOne({ user: req.params.id, organization: req.org });
    if (!m) throw new HttpError(404, "User not found");
    if (String(m.user) === String(req.user._id)) throw new HttpError(400, "You can't remove yourself");
    await guardLastAdmin(req, m, { role: "none", status: "inactive" });
    await m.deleteOne();
    const user = await User.findById(req.params.id);
    if (user && !(await Membership.exists({ user: user._id }))) await user.deleteOne();
    else if (user && String(user.organization) === String(req.org)) {
      const other = await Membership.findOne({ user: user._id });
      user.organization = other.organization;
      await user.save();
    }
    res.send({ message: "User removed from this company" });
  })
);

module.exports = router;
