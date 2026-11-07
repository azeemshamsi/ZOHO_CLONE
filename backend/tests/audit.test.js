// Security audit log helpers and login lockout (no database: models are stubbed).
const test = require("node:test");
const assert = require("node:assert");
const audit = require("../src/utils/audit");
const L = require("../src/utils/lockout");
const AuditLog = require("../src/models/AuditLog");

test("meta is cleaned of passwords, tokens and buyer details", () => {
  const m = audit.clean({ password: "x", refreshToken: "y", clientSecret: "z", buyerName: "Ravi", shippingAddress: { city: "Pune" }, phone: "98", name: "Ravi", rows: 3, nested: { apiKey: "k", ok: 1 }, email: "a@b.c" });
  assert.deepEqual(m, { rows: 3, nested: { ok: 1 }, email: "a@b.c" });
});

test("secret fields are named, never valued", () => {
  assert.deepEqual(audit.secretFields({ name: "Amazon", clientSecret: "abc", refreshToken: "", credentials: { apiKey: "k", user: "u" } }), ["clientSecret", "credentials.apiKey"]);
});

test("Amazon access hours are 08:00–21:00 IST", () => {
  assert.equal(audit.outsideHours(new Date("2026-11-07T02:29:00Z")), true); // 07:59 IST
  assert.equal(audit.outsideHours(new Date("2026-11-07T02:30:00Z")), false); // 08:00 IST
  assert.equal(audit.outsideHours(new Date("2026-11-07T15:29:00Z")), false); // 20:59 IST
  assert.equal(audit.outsideHours(new Date("2026-11-07T15:30:00Z")), true); // 21:00 IST
});

test("volume alert needs 30/hour and twice the trailing average", () => {
  const H = 3600000;
  const t0 = 1000 * H;
  // 24 hours of 40/hour → average 40, threshold 80
  for (let h = 24; h >= 1; h--) for (let i = 0; i < 40; i++) audit.bump("orgA", t0 - h * H);
  let v;
  for (let i = 0; i < 79; i++) v = audit.bump("orgA", t0);
  assert.equal(v.over, false);
  assert.equal(Math.round(v.threshold), 80);
  v = audit.bump("orgA", t0);
  assert.equal(v.over, true);
  // a quiet company: minimum of 30
  for (let i = 0; i < 29; i++) v = audit.bump("orgB", t0);
  assert.equal(v.over, false);
  assert.equal(audit.bump("orgB", t0).over, true);
  // a bulk label download counts each label
  assert.equal(audit.bump("orgC", t0, 30).over, true);
});

test("5 wrong passwords within 10 minutes lock the account for 15 minutes", () => {
  const u = {};
  const t = Date.parse("2026-11-07T10:00:00Z");
  for (let i = 0; i < 4; i++) assert.equal(L.recordFailure(u, t + i * 60000).locked, false);
  assert.equal(L.lockedFor(u, t + 4 * 60000), 0);
  assert.equal(L.recordFailure(u, t + 5 * 60000).locked, true);
  assert.ok(L.lockedFor(u, t + 6 * 60000) > 13 * 60000);
  assert.equal(L.lockedFor(u, t + 21 * 60000), 0);
});

test("failures more than 10 minutes apart don't add up", () => {
  const u = {};
  const t = Date.parse("2026-11-07T10:00:00Z");
  for (let i = 0; i < 4; i++) L.recordFailure(u, t + i * 1000);
  assert.equal(L.recordFailure(u, t + 11 * 60000).locked, false);
  assert.equal(u.loginFailures.count, 1);
  L.clearFailures(u);
  assert.equal(L.lockedFor(u), 0);
});

test("the security log refuses updates and deletes", async () => {
  await assert.rejects(() => AuditLog.updateOne({}, { action: "x" }), /append-only/);
  await assert.rejects(() => AuditLog.deleteMany({}), /append-only/);
});

test("log() writes a cleaned entry with request details", async () => {
  const orig = AuditLog.create;
  let saved;
  AuditLog.create = async (d) => (saved = d);
  const req = { org: "o1", user: { _id: "u1", email: "A@B.com" }, ip: "::ffff:1.2.3.4", get: (h) => ({ "x-device-id": "dev-1", "user-agent": "UA" })[h], res: { locals: {} } };
  await audit.log(req, "login", { meta: { password: "p", ok: true } });
  AuditLog.create = orig;
  assert.equal(saved.ip, "1.2.3.4");
  assert.equal(saved.deviceId, "dev-1");
  assert.equal(saved.email, "a@b.com");
  assert.deepEqual(saved.meta, { ok: true });
  assert.equal(req.res.locals.audited, true);
});
