// Seller tickets: seller raises / replies; team replies, internal notes (hidden from the seller), status,
// assignee; desk list counts by status.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");
const SupportTicket = require("../src/models/SupportTicket");
const Seller = require("../src/models/Seller");
const ShopifyOrder = require("../src/models/ShopifyOrder");
const ShopifyStore = require("../src/models/ShopifyStore");
const Membership = require("../src/models/Membership");
const org = new mongoose.Types.ObjectId();
const sellerId = new mongoose.Types.ObjectId();
const sellerUser = { _id: new mongoose.Types.ObjectId(), name: "Nadeem (NR Homes)", email: "nr@example.com" };
const staffUser = { _id: new mongoose.Types.ObjectId(), name: "Sana" };
const orderId = new mongoose.Types.ObjectId();

// In-memory tickets
const db = [];
const match = (d, f) => Object.entries(f).every(([k, v]) => String(d[k]) === String(v));
SupportTicket.create = async (doc) => {
  const t = new SupportTicket(doc);
  t.save = async function () {
    const i = db.findIndex((x) => String(x._id) === String(this._id));
    if (i < 0) db.push(this);
    return this;
  };
  await t.save();
  return t;
};
SupportTicket.findOne = (f, proj) => {
  const r = db.find((t) => match(t, f)) || null;
  const p = Promise.resolve(r);
  p.sort = () => ({ lean: async () => (db.length ? { number: Math.max(...db.map((t) => t.number)) } : null) });
  p.lean = async () => (r ? r.toObject() : null);
  return p;
};
SupportTicket.find = (f) => {
  const rows = db.filter((t) => match(t, f)).map((t) => t.toObject());
  const q = { sort: () => q, limit: () => q, lean: async () => rows };
  return q;
};
Seller.findOne = async () => ({ _id: sellerId, organization: org, name: "N.R.HOMESDECOR", active: true, email: "nr@example.com" });
ShopifyOrder.findOne = () => ({ lean: async () => ({ _id: orderId, name: "#201265" }) });
ShopifyStore.exists = async () => true;
Membership.findOne = () => ({ populate: () => ({ lean: async () => ({ user: staffUser }) }) });
require("../src/utils/mailer").sendSystemMail = async () => true;

const sellerApp = express();
sellerApp.use(express.json());
sellerApp.use((req, res, next) => ((req.membership = { role: "seller", seller: sellerId, organization: org }), (req.user = sellerUser), next()));
sellerApp.use("/sp", require("../src/routes/sellerPortal"));
const teamApp = express();
teamApp.use(express.json());
teamApp.use((req, res, next) => ((req.org = org), (req.user = staffUser), (req.perms = { tickets: "full" }), next()));
teamApp.use("/t", require("../src/routes/tickets"));
const err = (e, req, res, next) => res.status(e.status || 500).send({ message: e.message }); // eslint-disable-line no-unused-vars
sellerApp.use(err);
teamApp.use(err);
const s1 = sellerApp.listen(0);
const s2 = teamApp.listen(0);
test.after(() => (s1.close(), s2.close()));
const call = async (srv, path, method = "GET", body) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

test("seller raises a ticket about their order", async () => {
  const r = await call(s1, "/sp/tickets", "POST", { category: "shipping", subject: "Pickup not done", text: "Courier didn't come for #201265", orderId: String(orderId) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.number, "TKT-0001");
  assert.strictEqual(r.data.orderName, "#201265");
  assert.strictEqual(r.data.status, "open");
});

test("team: internal note hidden from the seller; reply moves to work in progress and assigns", async () => {
  const id = String(db[0]._id);
  await call(s2, `/t/${id}/reply`, "POST", { text: "Checked Blue Dart: area mismatch", internal: true });
  const r = await call(s2, `/t/${id}/reply`, "POST", { text: "We've re-registered the pickup for today." });
  assert.strictEqual(r.data.status, "in_progress");
  assert.strictEqual(r.data.assignee.name, "Sana");
  const sv = await call(s1, `/sp/tickets/${id}`);
  assert.ok(!sv.data.messages.some((m) => /area mismatch/.test(m.text)));
  assert.ok(sv.data.messages.some((m) => /re-registered/.test(m.text)));
});

test("resolve, seller reopens with a reply, desk counts", async () => {
  const id = String(db[0]._id);
  const r = await call(s2, `/t/${id}`, "PUT", { status: "resolved", priority: "high" });
  assert.strictEqual(r.data.status, "resolved");
  const back = await call(s1, `/sp/tickets/${id}/reply`, "POST", { text: "Still not picked up" });
  assert.strictEqual(back.data.status, "open");
  const list = await call(s2, "/t?status=active");
  assert.strictEqual(list.data.counts.open, 1);
  assert.strictEqual(list.data.rows[0].ticketNo, "TKT-0001");
  assert.strictEqual(list.data.rows[0].teamUnread > 0, true);
});
