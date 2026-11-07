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
const audit = require("../utils/audit");

// A role key is a built-in role or "custom:<id>" of a role in this company.
async function checkRole(org, role) {
  if (role === "seller") throw new HttpError(400, "Seller logins are added from Store → Sellers");
  if (ROLES[role]) return role;
  if (/^custom:[a-f0-9]{24}$/.test(role) && (await Role.exists({ _id: role.slice(7), organization: org }))) return role;
  throw new HttpError(400, "Choose a valid role");
}
const pub = (u, m) => ({ _id: u._id, name: u.name, email: u.email, role: m.role, roles: [m.role, ...(m.extraRoles || [])], status: m.status === "invited" || u.status === "invited" ? "invited" : m.status, lastLogin: u.lastLogin, createdAt: m.createdAt });

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
    res.send([...Object.entries(ROLES).filter(([, r]) => !r.hidden).map(([key, r]) => ({ key, ...r, builtIn: true })), ...custom.map((r) => ({ key: `custom:${r._id}`, _id: r._id, label: r.name, desc: r.desc, perms: r.perms, home: r.home, builtIn: false }))]);
  })
);

router.get(
  "/",
  ah(async (req, res) => {
    const ms = await Membership.find({ organization: req.org }).populate("user").sort({ createdAt: 1 });
    res.send(ms.filter((m) => m.user).map((m) => ({ ...pub(m.user, m), you: String(m.user._id) === String(req.user._id) })));
  })
);

// One or more roles → [main, ...extra]. Admin already has everything, so it stands alone; a seller login is separate.
async function checkRoles(org, data) {
  const list = [...new Set([...(data.roles || []), ...(data.role ? [data.role] : [])].filter(Boolean))];
  if (!list.length) throw new HttpError(400, "Choose at least one role");
  for (const r of list) await checkRole(org, r);
  if (list.includes("admin")) return ["admin"];
  return list;
}

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(100).required().label("Name"),
        email: Joi.string().email().required().label("Email"),
        role: Joi.string().allow(""),
        roles: Joi.array().items(Joi.string()).max(10),
      }),
      req.body
    );
    const [role, ...extraRoles] = await checkRoles(req.org, data);
    const email = data.email.toLowerCase();
    let user = await User.findOne({ email });
    await require("../utils/subscription").checkLimit(req.org, "users", { userId: user?._id });
    if (user) {
      // Already has an OrdexaGo login (e.g. in your other company): just give access here.
      if (await Membership.exists({ user: user._id, organization: req.org })) throw new HttpError(409, "This person already has access to this company");
      const m = await Membership.create({ user: user._id, organization: req.org, role, extraRoles, status: user.status === "invited" ? "invited" : "active", invitedBy: req.user._id });
      await roleAudit(req, "user_added", user, null, [role, ...extraRoles]);
      if (user.status === "invited") return res.status(201).send({ user: pub(user, m), ...(await invite(req, user, role)) });
      return res.status(201).send({ user: pub(user, m), added: true, message: `${user.name} already has an OrdexaGo login and can now open this company from the company switcher.` });
    }
    user = new User({ name: data.name, email, role, organization: req.org, status: "invited", invitedBy: req.user._id, verified: true });
    const r = await invite(req, user, role);
    const m = await Membership.create({ user: user._id, organization: req.org, role, extraRoles, status: "invited", invitedBy: req.user._id });
    await roleAudit(req, "user_invited", user, null, [role, ...extraRoles]);
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

// Log a change to someone's access and alert the admins.
async function roleAudit(req, action, user, from, to) {
  const label = async (list) => (list ? (await Promise.all(list.map((r) => resolveRole(r, req.org).then((x) => x.label)))).join(" + ") || "none" : "—");
  const [a, b] = [await label(from), await label(to)];
  audit.log(req, action, { target: user.email, meta: { userId: String(user._id), from: from || [], to, fromLabel: a, toLabel: b } });
  audit.alert(req.org, `User access changed: ${user.email}`, `${req.user.name} <${req.user.email}> changed access for ${user.email}: ${action.replace(/_/g, " ")} (${a} → ${b}).`, `role:${user._id}:${b}`);
}

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
    const data = validate(Joi.object({ name: Joi.string().trim().min(2).max(100), role: Joi.string(), roles: Joi.array().items(Joi.string()).max(10), status: Joi.string().valid("active", "inactive") }), req.body);
    const m = await Membership.findOne({ user: req.params.id, organization: req.org });
    const user = m && (await User.findById(req.params.id));
    if (!user) throw new HttpError(404, "User not found");
    let extra;
    if (data.roles || data.role) {
      if (m.role === "seller") throw new HttpError(400, "A seller login's access is managed under Store → Sellers");
      [data.role, ...extra] = await checkRoles(req.org, { roles: data.roles || [data.role] });
    }
    if (data.status && m.status === "invited") throw new HttpError(400, "This user hasn't accepted the invitation yet");
    await guardLastAdmin(req, m, { role: data.role || m.role, status: data.status || m.status });
    if (data.status === "active" && m.status === "inactive") await require("../utils/subscription").checkLimit(req.org, "users", { userId: user._id });
    const before = { roles: [m.role, ...(m.extraRoles || [])], status: m.status };
    if (data.role) {
      m.role = data.role;
      m.extraRoles = extra;
    }
    if (data.status) m.status = data.status;
    await m.save();
    const after = [m.role, ...(m.extraRoles || [])];
    if (before.roles.join() !== after.join()) await roleAudit(req, "user_role_changed", user, before.roles, after);
    if (before.status !== m.status) audit.log(req, "user_status_changed", { target: user.email, meta: { userId: String(user._id), from: before.status, to: m.status } });
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
    const gone = await User.findById(req.params.id, { email: 1 }).lean();
    await roleAudit(req, "user_removed", gone || { _id: req.params.id, email: "" }, [m.role, ...(m.extraRoles || [])], []);
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
