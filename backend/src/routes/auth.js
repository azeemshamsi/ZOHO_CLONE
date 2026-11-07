const router = require("express").Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Joi = require("joi");
const env = require("../config/env");
const User = require("../models/User");
const Organization = require("../models/Organization");
const Token = require("../models/Token");
const sendEmail = require("../utils/sendEmail");
const auth = require("../middleware/auth");
const { ah, validate, HttpError } = require("../utils/http");
const audit = require("../utils/audit");
const L = require("../utils/lockout");
const P = require("../utils/password");
const T = require("../utils/totp");
const twoFactor = require("../utils/twoFactor");

// The policy itself is checked by utils/password.js (needs the user's name and email).
const password = Joi.string().min(1).max(200).required().label("Password");

async function createToken(userId, purpose) {
  await Token.deleteMany({ userId, purpose });
  return Token.create({ userId, purpose, token: crypto.randomBytes(32).toString("hex") });
}

// Companies this user can open.
async function companiesOf(user) {
  const Membership = require("../models/Membership");
  const ms = await Membership.find({ user: user._id, status: "active" }).populate("organization", "name gstin state").lean();
  const { resolveRole } = require("../utils/roles");
  const out = [];
  for (const m of ms) if (m.organization) out.push({ _id: m.organization._id, name: m.organization.name, gstin: m.organization.gstin, role: (await resolveRole(m.role, m.organization._id, m.extraRoles)).label });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function sessionPayload(user, wanted, mfa = false) {
  const { membershipFor } = require("../middleware/auth");
  const m = await membershipFor(user, wanted);
  if (!m) throw new HttpError(403, "You don't have access to any company. Contact your admin.");
  const subscription = await require("../utils/subscription").assertAccess(user, m.organization);
  const r = await require("../utils/roles").resolveRole(m.role, m.organization, m.extraRoles);
  user.role = m.role;
  const organization = await Organization.findById(m.organization);
  return { token: user.generateAuthToken(mfa), user: user.toPublic(r), organization, organizations: await companiesOf(user), subscription };
}

/* ---------------- sign-in steps ----------------
 * password → [change an expired password] → [two-step code | set up two-step login] → session.
 * Between steps the browser holds a short "ticket" (15 min) instead of a session token.
 */
const ticketFor = (user, stage, wanted) => jwt.sign({ _id: user._id, tv: user.tokenVersion || 0, typ: "t", stage, org: wanted || "" }, env.JWT_SECRET, { expiresIn: "15m" });

async function fromTicket(ticket, stage) {
  let p;
  try {
    p = jwt.verify(String(ticket || ""), env.JWT_SECRET);
  } catch {
    throw new HttpError(401, "This sign-in took too long. Please start again.");
  }
  if (p.typ !== "t" || p.stage !== stage) throw new HttpError(401, "Please start signing in again.");
  const user = await User.findById(p._id);
  if (!user || (user.tokenVersion || 0) !== p.tv) throw new HttpError(401, "Please start signing in again.");
  const ms = L.lockedFor(user);
  if (ms) throw new HttpError(423, `Too many wrong attempts. This account is locked — try again in ${L.minutesLeft(ms)} minute${L.minutesLeft(ms) > 1 ? "s" : ""}.`);
  return { user, wanted: p.org || undefined };
}

// A wrong password or code: count it, lock after 5 in 10 minutes.
async function failed(req, user, action, reason) {
  audit.log(req, action, { user: user._id, organization: user.organization, email: user.email, meta: { reason } });
  const r = L.recordFailure(user);
  await User.updateOne({ _id: user._id }, { $set: { loginFailures: user.loginFailures, lockedUntil: user.lockedUntil || null } });
  if (r.locked) {
    audit.log(req, "account_locked", { user: user._id, organization: user.organization, email: user.email, meta: { minutes: L.LOCK_MS / 60000, after: action } });
    audit.alert(user.organization, `Account locked after ${L.MAX_FAILURES} failed logins: ${user.email}`, `${L.MAX_FAILURES} wrong ${action === "2fa_failed" ? "two-step codes" : "passwords"} were entered for ${user.name} <${user.email}> within 10 minutes. The account is locked for 15 minutes.\nLast attempt from IP: ${audit.info(req).ip}`, `lock:${user._id}`);
    throw new HttpError(423, "Too many wrong attempts. This account is locked for 15 minutes.");
  }
}

async function startSetup(user) {
  if (!user.totp?.pendingSecret) {
    user.set("totp.pendingSecret", T.newSecret());
    await user.save();
  }
  const secret = user.totp.pendingSecret;
  const url = T.otpauthUrl(secret, user.email);
  return { secret, otpauthUrl: url, qr: await require("qrcode").toDataURL(url, { margin: 1, width: 220 }) };
}

// What comes after a correct password (or after the previous step).
async function nextStep(req, user, wanted) {
  if (P.expired(user)) return { step: "change_password", ticket: ticketFor(user, "password", wanted), rules: P.RULES_TEXT, message: "Your password is more than a year old. Choose a new one to continue." };
  if (user.totp?.enabled) return { step: "totp", ticket: ticketFor(user, "totp", wanted) };
  if (await twoFactor.required(user)) return { step: "totp_setup", ticket: ticketFor(user, "setup", wanted), ...(await startSetup(user)) };
  return finish(req, user, wanted, false);
}

async function finish(req, user, wanted, mfa, extra = {}) {
  user.lastLogin = new Date();
  L.clearFailures(user);
  await user.save();
  const payload = await sessionPayload(user, wanted, mfa);
  audit.log(req, "login", { user: user._id, organization: payload.organization?._id || user.organization, email: user.email, meta: { twoStep: !!mfa } });
  await require("../utils/devices").touch(req, { user, org: payload.organization?._id, admin: user.superadmin || user.role === "admin" });
  return { ...payload, ...extra };
}

// Sign up: creates the organization and its first (admin) user.
router.post(
  "/signup",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({
        name: Joi.string().trim().min(2).max(100).required().label("Name"),
        email: Joi.string().email().required().label("Email"),
        password,
        organizationName: Joi.string().trim().min(2).max(150).required().label("Organization name"),
        state: Joi.string().required().label("State"),
      }),
      req.body
    );

    // Accounts are created by OrdexaGo (superadmin → Subscribers). Only a brand-new installation can sign up,
    // and that first user becomes the superadmin.
    const first = !(await User.exists({}));
    if (!first) throw new HttpError(403, "OrdexaGo accounts are set up by OrdexaGo. To subscribe, write to help@ordexago.com.");
    const email = data.email.toLowerCase();
    if (await User.findOne({ email })) throw new HttpError(409, "An account with this email already exists");
    P.assertStrong(data.password, { name: data.name, email });

    const organization = await Organization.create({
      name: data.organizationName,
      state: data.state,
      email,
      address: { state: data.state },
    });
    const needsVerification = env.REQUIRE_EMAIL_VERIFICATION && env.emailEnabled;
    const user = new User({ name: data.name, email, organization: organization._id, verified: !needsVerification, superadmin: first });
    await P.setPassword(user, data.password);
    await user.save();

    if (needsVerification) {
      const t = await createToken(user._id, "verify");
      await sendEmail(email, "Verify your OrdexaGo account", `Verify your email: ${env.APP_URL}/verify/${user._id}/${t.token}`);
      return res.status(201).send({ message: "We sent a verification link to your email." });
    }
    res.status(201).send(await nextStep(req, user));
  })
);

router.post(
  "/login",
  ah(async (req, res) => {
    const data = validate(Joi.object({ email: Joi.string().email().required().label("Email"), password: Joi.string().required() }), req.body);
    const email = data.email.toLowerCase();
    const user = await User.findOne({ email });
    if (user) {
      const ms = L.lockedFor(user);
      if (ms) {
        audit.log(req, "login_blocked_locked", { user: user._id, organization: user.organization, email });
        throw new HttpError(423, `Too many wrong attempts. This account is locked — try again in ${L.minutesLeft(ms)} minute${L.minutesLeft(ms) > 1 ? "s" : ""}.`);
      }
    }
    if (!user || !user.password || !(await bcrypt.compare(data.password, user.password))) {
      if (user && user.password) await failed(req, user, "login_failed", "wrong_password");
      else audit.log(req, "login_failed", { user: user?._id || null, organization: user?.organization || null, email, meta: { reason: user ? "no_password_yet" : "unknown_email" } });
      throw new HttpError(401, "Invalid email or password");
    }
    if (user.status === "inactive" && !(await require("../models/Membership").exists({ user: user._id, status: "active" }))) throw new HttpError(403, "Your access has been turned off. Contact your admin.");
    if (!user.verified) {
      const t = await createToken(user._id, "verify");
      await sendEmail(user.email, "Verify your OrdexaGo account", `Verify your email: ${env.APP_URL}/verify/${user._id}/${t.token}`);
      throw new HttpError(403, "Please verify your email. We sent you a new link.");
    }
    res.send(await nextStep(req, user, req.get("x-org")));
  })
);

// Step: new password (the old one expired).
router.post(
  "/login/change-password",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ticket: Joi.string().required(), password }), req.body);
    const { user, wanted } = await fromTicket(d.ticket, "password");
    await P.setPassword(user, d.password);
    await user.save();
    audit.log(req, "password_changed", { user: user._id, organization: user.organization, email: user.email, meta: { reason: "expired" } });
    res.send(await nextStep(req, user, wanted));
  })
);

// Step: the 6-digit code from the authenticator app, or a recovery code.
router.post(
  "/login/totp",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ticket: Joi.string().required(), code: Joi.string().trim().max(40).required().label("Code") }), req.body);
    const { user, wanted } = await fromTicket(d.ticket, "totp");
    const code = d.code.replace(/\s+/g, "");
    if (/^\d{6}$/.test(code)) {
      const step = T.verify(user.totp.secret, code, { afterStep: user.totp.lastStep ?? -1 });
      if (step < 0) {
        await failed(req, user, "2fa_failed", "wrong_code");
        throw new HttpError(401, "That code isn't right. Check the time on your phone and try the newest code.");
      }
      user.totp.lastStep = step;
      return res.send(await finish(req, user, wanted, true));
    }
    const i = T.matchRecovery(code, user.totp.recoveryCodes);
    if (i < 0) {
      await failed(req, user, "2fa_failed", "wrong_recovery_code");
      throw new HttpError(401, "That recovery code isn't right or was already used.");
    }
    user.totp.recoveryCodes = user.totp.recoveryCodes.filter((_, k) => k !== i);
    audit.log(req, "2fa_recovery_used", { user: user._id, organization: user.organization, email: user.email, meta: { left: user.totp.recoveryCodes.length } });
    audit.alert(user.organization, `Recovery code used by ${user.email}`, `${user.name} <${user.email}> signed in with a two-step recovery code (${user.totp.recoveryCodes.length} left).\nIP: ${audit.info(req).ip}`, `rec:${user._id}`);
    res.send(await finish(req, user, wanted, true, { recoveryLeft: user.totp.recoveryCodes.length }));
  })
);

// Turn on two-step login with the code shown by the app; returns the recovery codes once.
async function enableTotp(req, user, code) {
  const secret = user.totp?.pendingSecret;
  if (!secret) throw new HttpError(400, "Start the two-step setup again");
  const step = T.verify(secret, code);
  if (step < 0) {
    await failed(req, user, "2fa_failed", "wrong_setup_code");
    throw new HttpError(400, "That code isn't right. Scan the QR code again and enter the newest 6-digit code.");
  }
  const rc = T.recoveryCodes();
  user.totp = { enabled: true, secret, pendingSecret: "", recoveryCodes: rc.hashes, enabledAt: new Date(), lastStep: step };
  audit.log(req, "2fa_enabled", { user: user._id, organization: user.organization, email: user.email });
  return rc.codes;
}

router.post(
  "/login/totp-setup",
  ah(async (req, res) => {
    const d = validate(Joi.object({ ticket: Joi.string().required(), code: Joi.string().trim().max(10).required().label("Code") }), req.body);
    const { user, wanted } = await fromTicket(d.ticket, "setup");
    const codes = await enableTotp(req, user, d.code);
    res.send(await finish(req, user, wanted, true, { recoveryCodes: codes }));
  })
);

router.post(
  "/logout",
  auth,
  ah(async (req, res) => {
    await audit.log(req, "logout");
    res.send({ ok: true });
  })
);

/* ---------------- signed in: password and two-step login ---------------- */
router.post(
  "/change-password",
  auth,
  ah(async (req, res) => {
    const d = validate(Joi.object({ current: Joi.string().required().label("Current password"), password }), req.body);
    const user = await User.findById(req.user._id);
    if (!(await bcrypt.compare(d.current, user.password || ""))) {
      await failed(req, user, "login_failed", "wrong_current_password");
      throw new HttpError(400, "Your current password isn't right");
    }
    await P.setPassword(user, d.password);
    await user.save();
    audit.log(req, "password_changed", { meta: { reason: "user" } });
    // This session continues; every other session is signed out (new token version).
    res.send({ token: user.generateAuthToken(req.session?.mfa), message: "Password changed. You've been signed out everywhere else." });
  })
);

router.get(
  "/2fa",
  auth,
  ah(async (req, res) => {
    res.send({ enabled: !!req.user.totp?.enabled, required: await twoFactor.required(req.user), recoveryLeft: (req.user.totp?.recoveryCodes || []).length, enabledAt: req.user.totp?.enabledAt || null, rules: P.RULES_TEXT });
  })
);

router.post(
  "/2fa/setup",
  auth,
  ah(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (user.totp?.enabled) throw new HttpError(400, "Two-step login is already on");
    res.send(await startSetup(user));
  })
);

router.post(
  "/2fa/enable",
  auth,
  ah(async (req, res) => {
    const { code } = validate(Joi.object({ code: Joi.string().trim().max(10).required().label("Code") }), req.body);
    const user = await User.findById(req.user._id);
    if (user.totp?.enabled) throw new HttpError(400, "Two-step login is already on");
    const codes = await enableTotp(req, user, code);
    await user.save();
    res.send({ recoveryCodes: codes, token: user.generateAuthToken(true) });
  })
);

// New recovery codes (the old ones stop working). Needs a current code.
router.post(
  "/2fa/recovery-codes",
  auth,
  ah(async (req, res) => {
    const { code } = validate(Joi.object({ code: Joi.string().trim().max(10).required().label("Code") }), req.body);
    const user = await User.findById(req.user._id);
    if (!user.totp?.enabled) throw new HttpError(400, "Two-step login isn't on");
    const step = T.verify(user.totp.secret, code, { afterStep: user.totp.lastStep ?? -1 });
    if (step < 0) {
      await failed(req, user, "2fa_failed", "wrong_code");
      throw new HttpError(400, "That code isn't right");
    }
    const rc = T.recoveryCodes();
    user.totp.lastStep = step;
    user.totp.recoveryCodes = rc.hashes;
    await user.save();
    audit.log(req, "2fa_enabled", { meta: { recoveryCodesRenewed: true } });
    res.send({ recoveryCodes: rc.codes });
  })
);

/* ---------------- invitations, verification, reset ---------------- */
async function findInvite({ id, token }) {
  const user = await User.findById(id).catch(() => null);
  if (!user || user.status !== "invited" || !user.inviteToken || user.inviteToken !== token) throw new HttpError(400, "This invitation is invalid or has already been used");
  if (user.inviteExpires && user.inviteExpires < new Date()) throw new HttpError(400, "This invitation has expired. Ask your admin to resend it.");
  return user;
}

// Invited user: look up the invite, then set a password to join.
router.get(
  "/invite/:id/:token",
  ah(async (req, res) => {
    const user = await findInvite(req.params);
    const org = await Organization.findById(user.organization);
    res.send({ name: user.name, email: user.email, organization: org?.name, role: user.role, rules: P.RULES_TEXT });
  })
);
router.post(
  "/invite/:id/:token",
  ah(async (req, res) => {
    const data = validate(Joi.object({ password, name: Joi.string().trim().min(2).max(100) }), req.body);
    const user = await findInvite(req.params);
    if (data.name) user.name = data.name;
    await P.setPassword(user, data.password);
    user.status = "active";
    user.verified = true;
    user.inviteToken = "";
    await user.save();
    await require("../models/Membership").updateMany({ user: user._id, status: "invited" }, { status: "active" });
    audit.log(req, "invite_accepted", { user: user._id, organization: user.organization, email: user.email });
    res.send(await nextStep(req, user, String(user.organization)));
  })
);

router.get(
  "/verify/:id/:token",
  ah(async (req, res) => {
    const token = await Token.findOne({ userId: req.params.id, token: req.params.token, purpose: "verify", createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
    if (!token) throw new HttpError(400, "This link is invalid or has expired");
    await User.updateOne({ _id: req.params.id }, { verified: true });
    await token.deleteOne();
    res.send({ message: "Email verified. You can log in now." });
  })
);

router.post(
  "/forgot-password",
  ah(async (req, res) => {
    const { email } = validate(Joi.object({ email: Joi.string().email().required().label("Email") }), req.body);
    if (!env.emailEnabled) {
      throw new HttpError(503, "Email is not set up on this server yet. Ask your administrator to reset your password.");
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      audit.log(req, "password_reset_requested", { user: user._id, organization: user.organization, email: user.email });
      const t = await createToken(user._id, "reset");
      await sendEmail(user.email, "Reset your OrdexaGo password", `Reset your password: ${env.APP_URL}/reset-password/${user._id}/${t.token}`);
    }
    // Same answer whether or not the account exists, so emails can't be probed.
    res.send({ message: "If that email has an account, a reset link is on its way." });
  })
);

router.post(
  "/reset-password/:id/:token",
  ah(async (req, res) => {
    const data = validate(Joi.object({ password }), req.body);
    const token = await Token.findOne({ userId: req.params.id, token: req.params.token, purpose: "reset", createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } });
    if (!token) throw new HttpError(400, "This link is invalid or has expired");
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(400, "This link is invalid or has expired");
    await P.setPassword(user, data.password);
    user.verified = true;
    await user.save();
    await token.deleteOne();
    audit.log(req, "password_reset", { user: user._id, organization: user.organization, email: user.email });
    res.send({ message: "Password updated. You can log in now." });
  })
);

router.get(
  "/me",
  auth,
  ah(async (req, res) => {
    const organization = await Organization.findById(req.org);
    await require("../utils/devices").touch(req);
    res.send({ user: req.user.toPublic(req.roleInfo), organization, organizations: await companiesOf(req.user), subscription: req.subscription });
  })
);

router.get("/password-rules", (req, res) => res.send({ rules: P.RULES_TEXT }));

module.exports = router;
