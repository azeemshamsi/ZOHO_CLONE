const router = require("express").Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Joi = require("joi");
const env = require("../config/env");
const User = require("../models/User");
const Organization = require("../models/Organization");
const Token = require("../models/Token");
const sendEmail = require("../utils/sendEmail");
const auth = require("../middleware/auth");
const { ah, validate, HttpError } = require("../utils/http");

const password = Joi.string()
  .min(8)
  .max(100)
  .pattern(/[A-Za-z]/)
  .pattern(/[0-9]/)
  .required()
  .label("Password")
  .messages({ "string.pattern.base": "Password must contain letters and numbers" });

async function createToken(userId, purpose) {
  await Token.deleteMany({ userId, purpose });
  return Token.create({ userId, purpose, token: crypto.randomBytes(32).toString("hex") });
}

async function sessionPayload(user) {
  const organization = await Organization.findById(user.organization);
  return { token: user.generateAuthToken(), user: user.toPublic(), organization };
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

    const email = data.email.toLowerCase();
    if (await User.findOne({ email })) throw new HttpError(409, "An account with this email already exists");

    const organization = await Organization.create({
      name: data.organizationName,
      state: data.state,
      email,
      address: { state: data.state },
    });
    const needsVerification = env.REQUIRE_EMAIL_VERIFICATION && env.emailEnabled;
    const user = await User.create({
      name: data.name,
      email,
      password: await bcrypt.hash(data.password, 10),
      organization: organization._id,
      verified: !needsVerification,
    });

    if (needsVerification) {
      const t = await createToken(user._id, "verify");
      await sendEmail(email, "Verify your MGI account", `Verify your email: ${env.APP_URL}/verify/${user._id}/${t.token}`);
      return res.status(201).send({ message: "We sent a verification link to your email." });
    }
    res.status(201).send(await sessionPayload(user));
  })
);

router.post(
  "/login",
  ah(async (req, res) => {
    const data = validate(
      Joi.object({ email: Joi.string().email().required().label("Email"), password: Joi.string().required() }),
      req.body
    );
    const user = await User.findOne({ email: data.email.toLowerCase() });
    if (!user || !user.password || !(await bcrypt.compare(data.password, user.password))) {
      throw new HttpError(401, "Invalid email or password");
    }
    if (user.status === "inactive") throw new HttpError(403, "Your access to this organization has been turned off. Contact your admin.");
    if (!user.verified) {
      const t = await createToken(user._id, "verify");
      await sendEmail(user.email, "Verify your MGI account", `Verify your email: ${env.APP_URL}/verify/${user._id}/${t.token}`);
      throw new HttpError(403, "Please verify your email. We sent you a new link.");
    }
    user.lastLogin = new Date();
    await user.save();
    res.send(await sessionPayload(user));
  })
);

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
    res.send({ name: user.name, email: user.email, organization: org?.name, role: user.role });
  })
);
router.post(
  "/invite/:id/:token",
  ah(async (req, res) => {
    const data = validate(Joi.object({ password, name: Joi.string().trim().min(2).max(100) }), req.body);
    const user = await findInvite(req.params);
    user.password = await bcrypt.hash(data.password, 10);
    if (data.name) user.name = data.name;
    user.status = "active";
    user.verified = true;
    user.lastLogin = new Date();
    user.inviteToken = "";
    await user.save();
    res.send(await sessionPayload(user));
  })
);

router.get(
  "/verify/:id/:token",
  ah(async (req, res) => {
    const token = await Token.findOne({ userId: req.params.id, token: req.params.token, purpose: "verify" });
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
      const t = await createToken(user._id, "reset");
      await sendEmail(user.email, "Reset your MGI password", `Reset your password: ${env.APP_URL}/reset-password/${user._id}/${t.token}`);
    }
    // Same answer whether or not the account exists, so emails can't be probed.
    res.send({ message: "If that email has an account, a reset link is on its way." });
  })
);

router.post(
  "/reset-password/:id/:token",
  ah(async (req, res) => {
    const data = validate(Joi.object({ password }), req.body);
    const token = await Token.findOne({ userId: req.params.id, token: req.params.token, purpose: "reset" });
    if (!token) throw new HttpError(400, "This link is invalid or has expired");
    await User.updateOne(
      { _id: req.params.id },
      { password: await bcrypt.hash(data.password, 10), verified: true }
    );
    await token.deleteOne();
    res.send({ message: "Password updated. You can log in now." });
  })
);

router.get(
  "/me",
  auth,
  ah(async (req, res) => {
    const organization = await Organization.findById(req.org);
    res.send({ user: req.user.toPublic(), organization });
  })
);

module.exports = router;
