const router = require("express").Router();
const crypto = require("crypto");
const Joi = require("joi");
const env = require("../config/env");
const User = require("../models/User");
const Organization = require("../models/Organization");
const { ROLES } = require("../utils/roles");
const { ah, validate, HttpError } = require("../utils/http");

const roleKeys = Object.keys(ROLES);
const pub = (u) => ({ _id: u._id, name: u.name, email: u.email, role: u.role, status: u.status, lastLogin: u.lastLogin, createdAt: u.createdAt, you: undefined });

async function invite(req, user) {
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
        subject: `${req.user.name} invited you to ${org.name} on MGI`,
        text: `Hi ${user.name},\n\n${req.user.name} has invited you to join ${org.name} on MGI as ${ROLES[user.role].label}.\n\nAccept the invitation and set your password: ${link}\n\nThe link works for 7 days.`,
      });
      sent = true;
    } catch (e) {
      console.error(`[invite] email failed: ${e.message}`);
    }
  return { link, emailed: sent };
}

router.get("/roles", (req, res) => res.send(Object.entries(ROLES).map(([key, r]) => ({ key, ...r }))));

router.get(
  "/",
  ah(async (req, res) => {
    const users = await User.find({ organization: req.org }).sort({ createdAt: 1 });
    res.send(users.map((u) => ({ ...pub(u), you: String(u._id) === String(req.user._id) })));
  })
);

router.post(
  "/",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(100).required().label("Name"),
        email: Joi.string().email().required().label("Email"),
        role: Joi.string().valid(...roleKeys).required().label("Role"),
      }),
      req.body
    );
    const email = data.email.toLowerCase();
    if (await User.findOne({ email })) throw new HttpError(409, "This email already has an MGI account");
    const user = new User({ name: data.name, email, role: data.role, organization: req.org, status: "invited", invitedBy: req.user._id, verified: true });
    const r = await invite(req, user);
    res.status(201).send({ user: pub(user), ...r });
  })
);

router.post(
  "/:id/resend",
  ah(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, organization: req.org });
    if (!user) throw new HttpError(404, "User not found");
    if (user.status !== "invited") throw new HttpError(400, "This user has already joined");
    res.send(await invite(req, user));
  })
);

// Make sure an organization always keeps at least one active admin.
async function guardLastAdmin(req, user, next) {
  if (user.role !== "admin" || user.status !== "active") return;
  if (next.role === "admin" && next.status === "active") return;
  const admins = await User.countDocuments({ organization: req.org, role: "admin", status: "active" });
  if (admins <= 1) throw new HttpError(400, "There must be at least one active admin");
}

router.put(
  "/:id",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(100),
        role: Joi.string().valid(...roleKeys),
        status: Joi.string().valid("active", "inactive"),
      }),
      req.body
    );
    const user = await User.findOne({ _id: req.params.id, organization: req.org });
    if (!user) throw new HttpError(404, "User not found");
    if (data.status && user.status === "invited") throw new HttpError(400, "This user hasn't accepted the invitation yet");
    await guardLastAdmin(req, user, { role: data.role || user.role, status: data.status || user.status });
    user.set(data);
    await user.save();
    res.send(pub(user));
  })
);

router.delete(
  "/:id",
  ah(async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, organization: req.org });
    if (!user) throw new HttpError(404, "User not found");
    if (String(user._id) === String(req.user._id)) throw new HttpError(400, "You can't remove yourself");
    await guardLastAdmin(req, user, { role: "none", status: "inactive" });
    await user.deleteOne();
    res.send({ message: "User removed" });
  })
);

module.exports = router;
