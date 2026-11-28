// Security hardening (Nov 2026): NoSQL operator stripping, per-IP rate limits, safe seller HTML, AI redaction.
const test = require("node:test");
const assert = require("node:assert");

test("noOperators removes $ keys from query and body, keeps the rest", () => {
  const { noOperators } = require("../src/utils/noOperators");
  const req = { method: "POST", originalUrl: "/api/x", ip: "1.2.3.4", query: { status: { $ne: "x" }, q: "abc" }, body: { email: { $gt: "" }, items: [{ $where: "1", name: "a" }], ok: 1 }, params: {} };
  let called = false;
  noOperators(req, {}, () => (called = true));
  assert.ok(called);
  assert.deepEqual(req.query, { status: {}, q: "abc" });
  assert.deepEqual(req.body, { email: {}, items: [{ name: "a" }], ok: 1 });
});

test("rate limiter refuses after the limit, exempts loopback", () => {
  const { limiter } = require("../src/utils/rateLimit");
  const l = limiter({ name: "t", windowMs: 60000, max: 3 });
  const codes = [];
  const res = () => ({ set() {}, status(c) { codes.push(c); return { send() {} }; } });
  for (let i = 0; i < 5; i++) l({ ip: "9.9.9.9", originalUrl: "/api/auth/login", method: "POST" }, res(), () => codes.push(200));
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const lo = [];
  for (let i = 0; i < 5; i++) l({ ip: "127.0.0.1" }, res(), () => lo.push(200));
  assert.equal(lo.length, 5);
});

test("seller HTML keeps formatting, drops scripts, handlers and links", () => {
  const { safeHtml } = require("../src/utils/sellerListings");
  const out = safeHtml('<p style="x" onclick=alert(1)>Hi <b>x</b><img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">l</a><svg onload=alert(1)></svg></p>');
  assert.equal(out, "<p>Hi <b>x</b>l</p>");
  assert.ok(!/on\w+=|<script|javascript:|<img|<svg/i.test(out));
});

test("AI tool results never carry phone, email or addresses", () => {
  const { compact } = require("../src/utils/ai/assistant");
  const out = JSON.stringify(compact({ rows: [{ name: "#1", phone: "99", email: "a@b.c", shippingAddress: { city: "X" }, billingAddress: {}, total: 5, customer: { displayName: "Amazon", email: "x@y", mobile: "1" } }] }));
  assert.ok(!/99"|a@b|x@y|shippingAddress|mobile/.test(out));
  assert.ok(/"total":5/.test(out) && /Amazon/.test(out));
});
