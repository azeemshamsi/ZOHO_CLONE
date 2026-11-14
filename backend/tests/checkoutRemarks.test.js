// Abandoned checkout remarks: list merges remarks (own + same customer's other checkouts), filters, add remark.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Types } = require("mongoose");
const client = require("../src/utils/shopify/client");
const ShopifyStore = require("../src/models/ShopifyStore");
const CheckoutFollowUp = require("../src/models/CheckoutFollowUp");

const org = new Types.ObjectId();
const uid = new Types.ObjectId();
ShopifyStore.exists = async () => true;
ShopifyStore.findOne = async () => ({ connected: true, shop: "x.myshopify.com" });
const node = (id, cust, phone) => ({ id: `gid://shopify/AbandonedCheckout/${id}`, createdAt: "2026-11-13T10:00:00Z", abandonedCheckoutUrl: "https://u", totalPriceSet: { shopMoney: { amount: "100" } }, customer: cust ? { id: `gid://shopify/Customer/${cust}`, displayName: "Asha" } : null, shippingAddress: { name: "Asha", phone }, lineItems: { nodes: [] } });
let gqlCalls = [];
client.gql = async (store, q, v) => {
  gqlCalls.push({ q, v });
  if (q.includes("nodes(ids")) return { nodes: v.ids.map((g) => (g.endsWith("/11") ? node(11, 5, "9876543210") : null)) };
  return { abandonedCheckouts: { pageInfo: { hasNextPage: false }, nodes: [node(11, 5, "9876543210"), node(12, null, "+91 99999 00000")] } };
};
let docs = [
  { organization: org, checkoutId: "11", customerKey: "5", status: "Interested", nextOn: new Date(Date.now() - 86400000), notes: [{ _id: new Types.ObjectId(), text: "called", by: "Ravi", at: new Date() }], lastAt: new Date() },
  { organization: org, checkoutId: "9", customerKey: "5", status: "No answer", notes: [{ text: "no pickup", by: "Ravi", at: new Date("2026-11-01") }], lastAt: new Date("2026-11-01") },
];
const match = (d, f) => Object.entries(f).every(([k, v]) => (k === "organization" ? String(d.organization) === String(v) : v && v.$in ? v.$in.includes(d[k]) : d[k] === v));
CheckoutFollowUp.find = (f) => ({ lean: async () => docs.filter((d) => match(d, f)) });
let saved = null;
CheckoutFollowUp.findOne = async () => null;
CheckoutFollowUp.prototype.save = async function () {
  saved = this;
  return this;
};

const app = express();
app.use(express.json());
app.use((req, res, next) => ((req.storeOrg = org), (req.org = org), (req.user = { _id: uid, name: "Ravi" }), (req.perms = { store_orders: "view", "store_orders.abandoned": "full" }), next()));
app.use("/s", require("../src/routes/shopify"));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}/s`;
test.after(() => server.close());

test("list carries own and earlier remarks", async () => {
  const r = await (await fetch(`${base()}/abandoned-checkouts`)).json();
  const a = r.rows.find((x) => x.id === "11");
  assert.strictEqual(a.followUp.status, "Interested");
  assert.strictEqual(a.earlier.length, 1);
  assert.strictEqual(a.earlier[0].text, "no pickup");
  const b = r.rows.find((x) => x.id === "12");
  assert.strictEqual(b.followUp, null);
  assert.strictEqual(b.customerKey, "9999900000");
});

test("due filter looks checkouts up by id; missing ones still show", async () => {
  const r = await (await fetch(`${base()}/abandoned-checkouts?due=1`)).json();
  assert.deepStrictEqual(r.rows.map((x) => x.id), ["11"]);
  const s = await (await fetch(`${base()}/abandoned-checkouts?status=No%20answer`)).json();
  assert.strictEqual(s.rows[0].gone, true);
});

test("add remark with status and next date", async () => {
  const res = await fetch(`${base()}/abandoned-checkouts/12/remarks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "wants COD", status: "Will order later", nextOn: "2026-11-20", customerKey: "9999900000", customer: "Asha" }) });
  const out = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(out));
  assert.strictEqual(out.status, "Will order later");
  assert.strictEqual(out.notes[0].text, "wants COD");
  assert.strictEqual(out.notes[0].status, "Will order later");
  assert.strictEqual(saved.customerKey, "9999900000");
  const bad = await fetch(`${base()}/abandoned-checkouts/12/remarks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "Bogus" }) });
  assert.strictEqual(bad.status, 400);
});
