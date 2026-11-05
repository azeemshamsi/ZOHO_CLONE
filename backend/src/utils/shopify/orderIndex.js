/**
 * In-memory index of a store's orders for the order list: filters, status counts, sorting and text search
 * happen here (fast, and regex search is unreliable on the Oracle MongoDB API). Only the page of orders shown
 * is read from the database. Rebuilt when any order of the store changes (latest updatedAt).
 */
const ShopifyOrder = require("../../models/ShopifyOrder");

const FIELDS = { name: 1, orderNumber: 1, status: 1, orderDate: 1, paymentMode: 1, financialStatus: 1, fulfillmentStatus: 1, total: 1, invoice: 1, invoiceNumber: 1, tags: 1, remarks: 1, updatedAt: 1, customer: 1, "shippingAddress.name": 1, "shippingAddress.phone": 1, "shippingAddress.zip": 1, "shippingAddress.city": 1, "shippingAddress.state": 1, "shipment.awb": 1, "shipment.courierName": 1, "shipment.account": 1, "shopifyFulfillments.number": 1, "lines.sku": 1, "lines.title": 1, "lines.variantTitle": 1, "lines.vendor": 1, sellers: 1 };
const cache = new Map(); // org → { stamp, entries, building }

function entryOf(o) {
  const phones = [o.customer?.phone, o.shippingAddress?.phone].map((p) => String(p || "").replace(/\D/g, ""));
  const hay = [o.name, o.customer?.name, o.customer?.email, o.customer?.phone, o.shippingAddress?.name, o.shippingAddress?.zip, o.shippingAddress?.city, o.shipment?.awb, o.shipment?.courierName, o.invoiceNumber, o.remarks, ...phones, ...(o.shopifyFulfillments || []).map((x) => x.number), ...(o.lines || []).flatMap((l) => [l.sku, l.title, l.variantTitle, l.vendor]), ...(o.tags || [])]
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  return {
    _id: o._id,
    status: o.status,
    orderDate: o.orderDate ? new Date(o.orderDate).getTime() : 0,
    paymentMode: o.paymentMode,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    state: o.shippingAddress?.state,
    account: o.shipment?.account ? String(o.shipment.account) : "",
    invoiced: !!o.invoice,
    tags: o.tags || [],
    sellers: (o.sellers || []).map(String),
    total: Number(o.total) || 0,
    hay,
  };
}

async function stampOf(org) {
  const [last, n] = await Promise.all([ShopifyOrder.findOne({ organization: org }, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean(), ShopifyOrder.countDocuments({ organization: org })]);
  return `${last?.updatedAt ? new Date(last.updatedAt).getTime() : 0}:${n}`;
}

async function orderIndex(org) {
  const key = String(org);
  const stamp = await stampOf(org);
  const c = cache.get(key);
  if (c && c.stamp === stamp) return c.entries;
  if (c?.building && c.buildingStamp === stamp) return c.building;
  const building = ShopifyOrder.find({ organization: org }, FIELDS)
    .lean()
    .then((docs) => {
      const entries = docs.map(entryOf);
      cache.set(key, { stamp, entries });
      return entries;
    })
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...(c || {}), building, buildingStamp: stamp });
  return building;
}
const forget = (org) => cache.delete(String(org));

// Everything except the status tab and text: the same filters as the list's filter bar.
function filterEntries(entries, q) {
  const from = q.from ? new Date(`${q.from}T00:00:00+05:30`).getTime() : null;
  const to = q.to ? new Date(`${q.to}T23:59:59.999+05:30`).getTime() : null;
  const words = String(q.q || "").trim().toLowerCase().split(/\s+/).map((w) => w.replace(/^#/, "")).filter(Boolean);
  return entries.filter(
    (e) =>
      (from === null || e.orderDate >= from) &&
      (to === null || e.orderDate <= to) &&
      (!q.payment || e.paymentMode === q.payment) &&
      (!q.financial || e.financialStatus === q.financial) &&
      (!q.fulfillment || e.fulfillmentStatus === q.fulfillment) &&
      (!q.state || e.state === q.state) &&
      (!q.courier || e.account === String(q.courier)) &&
      (q.invoiced !== "yes" || e.invoiced) &&
      (q.invoiced !== "no" || !e.invoiced) &&
      (!q.tag || e.tags.includes(q.tag)) &&
      (!q.seller || (q.seller === "own" ? !e.sellers.length : e.sellers.includes(String(q.seller)))) &&
      (!q.min || e.total >= Number(q.min)) &&
      (!q.max || e.total <= Number(q.max)) &&
      words.every((w) => e.hay.includes(w) || (/^\+?\d{10,}$/.test(w) && e.hay.includes(w.replace(/\D/g, "").slice(-10))))
  );
}

module.exports = { orderIndex, filterEntries, forget, entryOf };
