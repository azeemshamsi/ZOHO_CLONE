/**
 * Link an Inbox contact to the company's customers and store orders.
 * WhatsApp / phone: last 10 digits against the order's customer and shipping phones (and Customers);
 * email: the address. Searching is done in memory (the store's order index) — no $regex on Oracle's MongoDB API.
 */
const ShopifyOrder = require("../../models/ShopifyOrder");
const Customer = require("../../models/Customer");
const { last10, cleanEmail } = require("./phone");

async function storeOrgFor(org) {
  const ShopifyStore = require("../../models/ShopifyStore");
  if (await ShopifyStore.exists({ organization: org, shop: { $nin: ["", null] } })) return org;
  const shared = await ShopifyStore.findOne({ sharedWith: org, connected: true }, { organization: 1 }).lean();
  return shared ? shared.organization : org;
}

// Does this order belong to the phone / email?
function orderMatches(o, { phone, email }) {
  const p = last10(phone);
  const e = cleanEmail(email);
  if (p && [o.customer?.phone, o.shippingAddress?.phone, o.billingAddress?.phone].some((x) => last10(x) === p)) return true;
  if (e && cleanEmail(o.customer?.email) === e) return true;
  return false;
}

const ORDER_FIELDS = { name: 1, orderNumber: 1, status: 1, orderDate: 1, total: 1, paymentMode: 1, codAmount: 1, customer: 1, "shippingAddress.phone": 1, "shippingAddress.name": 1, "shippingAddress.city": 1, "billingAddress.phone": 1, "shipment.courierName": 1, "shipment.awb": 1, "shipment.trackingUrl": 1, "shipment.trackStatus": 1, invoiceNumber: 1, channel: 1, codConfirm: 1, "lines.title": 1, "lines.quantity": 1, "lines.sku": 1 };

// Store orders of a contact, newest first.
async function ordersFor(org, contact, { limit = 20 } = {}) {
  const p = last10(contact.phone);
  const e = cleanEmail(contact.email);
  if (!p && !e) return [];
  const storeOrg = await storeOrgFor(org);
  const { orderIndex } = require("../shopify/orderIndex");
  const entries = await orderIndex(storeOrg).catch(() => []);
  const ids = entries.filter((x) => (p && x.hay.includes(p)) || (e && x.hay.includes(e))).map((x) => x._id);
  if (!ids.length) return [];
  const docs = [];
  for (let i = 0; i < ids.length && i < 2000; i += 200) docs.push(...(await ShopifyOrder.find({ _id: { $in: ids.slice(i, i + 200) } }, ORDER_FIELDS).lean()));
  return docs
    .filter((o) => o.channel !== "amazon" && orderMatches(o, { phone: p, email: e }))
    .sort((a, b) => new Date(b.orderDate || 0) - new Date(a.orderDate || 0))
    .slice(0, limit);
}

// An order by number ("#201114", "201114") in the store.
async function orderByNumber(org, text) {
  const m = String(text || "").match(/#?\b(\d{4,8})\b/);
  if (!m) return null;
  const storeOrg = await storeOrgFor(org);
  const n = Number(m[1]);
  return (await ShopifyOrder.findOne({ organization: storeOrg, orderNumber: n }, ORDER_FIELDS).lean()) || (await ShopifyOrder.findOne({ organization: storeOrg, name: `#${m[1]}` }, ORDER_FIELDS).lean());
}

async function customerFor(org, contact) {
  const p = last10(contact.phone);
  const e = cleanEmail(contact.email);
  if (!p && !e) return null;
  const all = await Customer.find({ organization: org }, { displayName: 1, email: 1, phone: 1 }).lean();
  return all.find((c) => (p && last10(c.phone) === p) || (e && cleanEmail(c.email) === e)) || null;
}

module.exports = { ordersFor, orderByNumber, customerFor, orderMatches, storeOrgFor, ORDER_FIELDS };
