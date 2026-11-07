// Password policy, TOTP two-step login and session tokens (no database: models are stubbed).
const test = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const P = require("../src/utils/password");
const T = require("../src/utils/totp");
const env = require("../src/config/env");
const User = require("../src/models/User");
const Membership = require("../src/models/Membership");
const Organization = require("../src/models/Organization");
Organization.findById = () => ({ lean: async () => null }); // no subscriber: unlimited

const who = { name: "Azeem Shamsi", email: "azeem@zikrziba.com" };

test("password rules", () => {
  assert.match(P.check("Short1!", who), /12 characters/);
  assert.match(P.check("alllowercase123!", who), /upper-case/);
  assert.match(P.check("ALLUPPERCASE123!", who), /lower-case/);
  assert.match(P.check("NoNumbersHere!!", who), /number/);
  assert.match(P.check("NoSymbols12345", who), /symbol/);
  assert.match(P.check("Azeem-Ledger-2026", who), /email|name/);
  assert.match(P.check("Shamsi#Books2026", who), /name/);
  assert.match(P.check("x-ZikrZiba-2026", { name: "Someone", email: "zikrziba@x.in" }), /email/);
  assert.match(P.check("Password1234!", who), /too common/);
  assert.match(P.check("Sunshine2026!!", who), /too common/);
  assert.match(P.check("Qwerty123456!", who), /too common/);
  assert.equal(P.check("Mango-Wood-Table#42", who), "");
});

test("TOTP matches RFC 6238 (SHA-1) and refuses reuse", () => {
  const secret = T.base32(Buffer.from("12345678901234567890"));
  assert.equal(T.totp(secret, 59 * 1000), "287082");
  assert.equal(T.totp(secret, 1111111109 * 1000), "081804");
  assert.equal(T.totp(secret, 1234567890 * 1000), "005924");
  const t = 1234567890 * 1000;
  const step = T.verify(secret, "005924", { t });
  assert.equal(step, T.stepAt(t));
  assert.equal(T.verify(secret, "005924", { t: t + 30000 }), step, "one step of clock drift is fine");
  assert.equal(T.verify(secret, "005924", { t: t + 90000 }), -1, "older codes expire");
  assert.equal(T.verify(secret, "005924", { t, afterStep: step }), -1, "a used code can't be used again");
  assert.equal(T.verify(secret, "12345", { t }), -1);
  assert.equal(T.unbase32(secret).toString(), "12345678901234567890");
});

test("recovery codes: 10, one-time, stored hashed", () => {
  const { codes, hashes } = T.recoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  assert.ok(!hashes.includes(codes[0]));
  assert.equal(T.matchRecovery(codes[3].toUpperCase(), hashes), 3);
  assert.equal(T.matchRecovery("aaaaa-aaaaa", hashes), -1);
});

test("new password: policy, no reuse of the last 5, new token version, expiry", async () => {
  const u = new User({ ...who, organization: new (require("mongoose").Types.ObjectId)() });
  const pw = (i) => `Mango-Wood-Table#${40 + i}`;
  await P.setPassword(u, pw(0));
  assert.equal(u.tokenVersion, 1);
  assert.ok(u.passwordChangedAt);
  for (let i = 1; i <= 5; i++) await P.setPassword(u, pw(i));
  await assert.rejects(() => P.setPassword(u, pw(5)), /haven't used before/);
  await assert.rejects(() => P.setPassword(u, pw(1)), /haven't used before/);
  await P.setPassword(u, pw(0)); // 6 changes ago: allowed again
  await assert.rejects(() => P.setPassword(u, "weak"), /12 characters/);
  assert.equal(P.expired(u), false);
  u.passwordChangedAt = new Date(Date.now() - 366 * 86400000);
  assert.equal(P.expired(u), true);
  assert.equal(P.expired({}), false, "users without a date (before the migration) aren't forced");
});

test("two-step secrets are stored encrypted", () => {
  const u = new User({ ...who, organization: new (require("mongoose").Types.ObjectId)() });
  u.set("totp.pendingSecret", "JBSWY3DPEHPK3PXP");
  assert.ok(u.toObject().totp.pendingSecret.startsWith("enc:v1:"));
  assert.equal(u.totp.pendingSecret, "JBSWY3DPEHPK3PXP");
});

/* ---------------- session tokens in the auth middleware ---------------- */
const auth = require("../src/middleware/auth");
function run(token, user, membership) {
  User.findById = async () => user;
  Membership.findOne = async () => membership;
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, status(c) { this.statusCode = c; return this; }, send(b) { resolve({ status: this.statusCode, body: b, res: this }); }, set(k, v) { this.headers[k] = v; } };
    const req = { headers: { authorization: `Bearer ${token}` }, get: () => undefined };
    auth(req, res, () => resolve({ status: 200, req, res }));
  });
}
const mkUser = (extra = {}) => {
  const u = new User({ ...who, organization: new (require("mongoose").Types.ObjectId)(), superadmin: true, ...extra });
  return u;
};

test("old 7-day tokens and sign-in tickets aren't sessions", async () => {
  const u = mkUser();
  const m = { organization: u.organization, role: "admin", status: "active" };
  assert.equal((await run(jwt.sign({ _id: u._id }, env.JWT_SECRET), u, m)).status, 401);
  assert.equal((await run(jwt.sign({ _id: u._id, typ: "t", tv: 0, stage: "totp" }, env.JWT_SECRET), u, m)).status, 401);
});

test("the superadmin / admins need a session that passed two-step login", async () => {
  const u = mkUser();
  const m = { organization: u.organization, role: "admin", status: "active" };
  const r = await run(u.generateAuthToken(false), u, m);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "mfa_required");
  assert.equal((await run(u.generateAuthToken(true), u, m)).status, 200);
});

test("staff without store roles don't need two-step login; warehouse staff do", async () => {
  const u = mkUser({ superadmin: false });
  assert.equal((await run(u.generateAuthToken(false), u, { organization: u.organization, role: "accountant", status: "active" })).status, 401, "accountant has store orders (full)");
  assert.equal((await run(u.generateAuthToken(false), u, { organization: u.organization, role: "returns", status: "active" })).status, 200);
  assert.equal((await run(u.generateAuthToken(false), u, { organization: u.organization, role: "warehouse", status: "active" })).status, 401);
});

test("changing the password ends other sessions", async () => {
  const u = mkUser({ superadmin: false });
  const m = { organization: u.organization, role: "returns", status: "active" };
  const old = u.generateAuthToken(false);
  u.tokenVersion = 1;
  assert.equal((await run(old, u, m)).status, 401);
  assert.equal((await run(u.generateAuthToken(false), u, m)).status, 200);
});

test("an active session gets a fresh token after 10 minutes", async () => {
  const u = mkUser({ superadmin: false });
  const m = { organization: u.organization, role: "returns", status: "active" };
  const t = jwt.sign({ _id: u._id, tv: 0, typ: "s", mfa: false, iat: Math.floor(Date.now() / 1000) - 11 * 60 }, env.JWT_SECRET, { expiresIn: "12h" });
  const r = await run(t, u, m);
  assert.equal(r.status, 200);
  assert.ok(r.res.headers["X-Session-Token"]);
  assert.equal(jwt.decode(r.res.headers["X-Session-Token"]).exp - jwt.decode(r.res.headers["X-Session-Token"]).iat, 12 * 3600);
});
