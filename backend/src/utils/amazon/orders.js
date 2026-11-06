/**
 * Amazon self-ship (MFN) and Easy Ship orders → Store → Orders (ShopifyOrder with channel "amazon").
 * Orders API v2026-01-01 searchOrders: first run from the account's "sync from" date, then orders updated
 * since the last sync (a few minutes' overlap). OrdexaGo's own workflow status is kept, except for
 * cancellations and orders Amazon reports shipped / delivered.
 */
const AmazonAccount = require("../../models/AmazonAccount");
const ShopifyOrder = require("../../models/ShopifyOrder");
const ShopifyStore = require("../../models/ShopifyStore");
const { call, rdtFor } = require("./client");
const { stateCode } = require("../import/common");

const SEARCH = "/orders/2026-01-01/orders";
const INCLUDED = ["BUYER", "RECIPIENT", "PROCEEDS", "FULFILLMENT", "PACKAGES", "TAX", "PAYMENT"];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const m = (x) => Number(x?.amount) || 0;
const GSTIN_RX = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Orders of a company live with the company that owns its Shopify store (same Orders list), like Shopify's.
async function storeOrgFor(org) {
  if (await ShopifyStore.exists({ organization: org, shop: { $nin: ["", null] } })) return org;
  const shared = await ShopifyStore.findOne({ sharedWith: org, connected: true }, { organization: 1 }).lean();
  return shared ? shared.organization : org;
}

const sumType = (bds, types) => (bds || []).filter((b) => types.includes(b.type)).reduce((t, b) => t + m(b.subtotal), 0);

/**
 * One order item → an order line. Amazon.in prices include GST; if the item / shipping / discount parts
 * don't add up to what Amazon pays for the item (e.g. tax listed separately), they're scaled to that total.
 */
function lineOf(it) {
  const qty = Number(it.quantityOrdered) || 0;
  const bds = it.proceeds?.breakdowns || [];
  const total = m(it.proceeds?.proceedsTotal);
  let item = sumType(bds, ["ITEM"]);
  let ship = sumType(bds, ["SHIPPING", "GIFT_WRAP", "COD_FEE", "OTHER"]);
  let disc = Math.abs(sumType(bds, ["DISCOUNT"]));
  if (!bds.length) {
    item = m(it.product?.price?.unitPrice) * qty;
    ship = 0;
    disc = 0;
  }
  const incl = item + ship - disc;
  const f = total > 0 && incl > 0 && Math.abs(incl - total) > 0.5 ? total / incl : 1;
  const p = it.product || {};
  return {
    line: {
      lineId: it.orderItemId,
      productId: p.asin || "",
      title: p.title || p.sellerSku || p.asin || "Amazon item",
      variantTitle: "",
      sku: p.sellerSku || "",
      vendor: "",
      tags: [],
      quantity: qty,
      unitPrice: qty ? r2((item * f) / qty) : 0,
      discount: r2(disc * f),
      total: r2((item - disc) * f),
    },
    shipping: r2(ship * f),
    proceeds: total || r2((item + ship - disc) * f),
  };
}

function addressOf(a = {}) {
  return {
    name: a.name || "",
    company: a.companyName || "",
    address1: a.addressLine1 || "",
    address2: [a.addressLine2, a.addressLine3].filter(Boolean).join(", "),
    city: a.city || a.municipality || "",
    province: a.stateOrRegion || "",
    state: stateCode(a.stateOrRegion || "") || "",
    zip: a.postalCode || "",
    country: !a.countryCode || a.countryCode === "IN" ? "India" : a.countryCode,
    phone: a.phone || "",
  };
}

function normalise(o, acc) {
  const items = (o.orderItems || []).map(lineOf);
  const lines = items.map((x) => x.line);
  const shippingTotal = r2(items.reduce((t, x) => t + x.shipping, 0));
  const total = r2(m(o.proceeds?.grandTotal) || items.reduce((t, x) => t + x.proceeds, 0));
  const methods = (o.payment?.paymentExecutions || []).map((p) => p.paymentMethod || "");
  const cod = methods.some((x) => /cash.?on.?delivery|^cod$/i.test(x));
  const reg = (o.tax?.taxRegistrations || []).find((t) => (!t.entityType || t.entityType === "BUYER") && GSTIN_RX.test(String(t.taxRegistrationNumber || "").toUpperCase()));
  const ful = o.fulfillment || {};
  const ship = addressOf(o.recipient?.deliveryAddress);
  const programs = o.programs || [];
  return {
    channel: "amazon",
    name: o.orderId,
    orderDate: new Date(o.createdTime),
    shopifyUpdatedAt: new Date(o.lastUpdatedTime || o.createdTime),
    customer: { name: o.buyer?.buyerName || ship.name || "Amazon customer", email: o.buyer?.buyerEmail || "", phone: ship.phone || "" },
    shippingAddress: ship,
    billingAddress: ship,
    financialStatus: cod ? "PENDING" : "PAID",
    fulfillmentStatus: ful.fulfillmentStatus || "",
    paymentMode: cod ? "cod" : "prepaid",
    prepaidAmount: cod ? 0 : total,
    codAmount: cod ? total : 0,
    gateways: methods.filter(Boolean),
    tags: ["Amazon", ...(programs.includes("AMAZON_EASY_SHIP") ? ["Easy Ship"] : ["Self-ship"]), ...(programs.includes("PRIME") ? ["Prime"] : []), ...(reg ? ["Amazon Business"] : [])],
    currency: o.proceeds?.grandTotal?.currencyCode || "INR",
    subtotal: r2(lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0)),
    discount: r2(lines.reduce((t, l) => t + l.discount, 0)),
    shippingTotal,
    total,
    outstanding: cod ? total : 0,
    lines,
    amazon: {
      account: acc._id,
      orderId: o.orderId,
      marketplaceId: o.salesChannel?.marketplaceId || acc.marketplaceId,
      easyShip: programs.includes("AMAZON_EASY_SHIP"),
      programs,
      fulfillmentStatus: ful.fulfillmentStatus || "",
      serviceLevel: ful.fulfillmentServiceLevel || "",
      shipBy: ful.shipByWindow?.latestDateTime ? new Date(ful.shipByWindow.latestDateTime) : null,
      deliverBy: ful.deliverByWindow?.latestDateTime ? new Date(ful.deliverByWindow.latestDateTime) : null,
      gstin: reg ? String(reg.taxRegistrationNumber).toUpperCase() : "",
      buyerCompany: o.buyer?.buyerCompanyName || reg?.legalName || "",
      items: (o.orderItems || []).map((it) => ({ orderItemId: it.orderItemId, sku: it.product?.sellerSku || "", quantity: Number(it.quantityOrdered) || 0 })),
      packages: (o.packages || []).map((p) => ({ ref: p.packageReferenceId, carrier: p.carrier || "", tracking: p.trackingNumber || "", status: p.packageStatus?.status || "", shipTime: p.shipTime ? new Date(p.shipTime) : null })),
    },
  };
}

// An order shipped or delivered outside OrdexaGo (Seller Central): take Amazon's package as the shipment.
function fromPackages(doc) {
  const p = (doc.amazon?.packages || []).find((x) => x.tracking && x.status !== "CANCELLED");
  if (!p || doc.shipment?.awb) return;
  doc.shipment = { carrier: doc.amazon.easyShip ? "amazon_easyship" : "amazon", courierName: p.carrier || (doc.amazon.easyShip ? "Amazon Easy Ship" : "Courier"), awb: p.tracking, bookedAt: p.shipTime || new Date(), trackStatus: p.status === "DELIVERED" ? "delivered" : "in_transit", events: [] };
}
const delivered = (n) => (n.amazon.packages || []).some((p) => p.status === "DELIVERED");

// Link lines to OrdexaGo items by SKU (FBA prefixes / suffixes allowed) so package types, racks and stock work.
async function linkItems(doc, orgId, cache) {
  if (String(doc.organization) !== String(orgId) || doc.lines.every((l) => l.item || !l.sku)) return;
  if (!cache.match) {
    const Item = require("../../models/Item");
    cache.match = require("../import/amazonImport").skuMatcher(await Item.find({ organization: orgId, active: { $ne: false } }, { sku: 1, name: 1 }).lean());
  }
  for (const l of doc.lines) if (!l.item && l.sku) l.item = cache.match(l.sku)?._id;
  doc.markModified("lines");
}

async function upsert(acc, storeOrg, o, cache = {}) {
  const n = normalise(o, acc);
  const fs = n.amazon.fulfillmentStatus;
  const id = `amazon:${o.orderId}`;
  const doc = await ShopifyOrder.findOne({ organization: storeOrg, shopifyId: id });
  if (!doc) {
    // Pending orders (payment not confirmed) aren't ready to ship; they come in once Amazon moves them on.
    if (["PENDING", "PENDING_AVAILABILITY", "UNFULFILLABLE", ""].includes(fs)) return { result: "skipped" };
    const status = fs === "CANCELLED" ? "cancelled" : fs === "SHIPPED" ? (delivered(n) ? "delivered" : "shipped") : "new";
    const d = new ShopifyOrder({ ...n, organization: storeOrg, shopifyId: id, status, statusChangedAt: new Date(), ...(fs === "CANCELLED" ? { cancelledAt: new Date(o.lastUpdatedTime || Date.now()) } : {}) });
    if (["shipped", "delivered"].includes(status)) fromPackages(d);
    await linkItems(d, acc.organization, cache);
    await d.save();
    return { result: "created", doc: d };
  }
  // Amazon's details refresh; OrdexaGo's workflow (packed, booked…) stays.
  doc.amazon = { ...(doc.amazon || {}), ...n.amazon };
  doc.markModified("amazon");
  for (const k of ["shopifyUpdatedAt", "fulfillmentStatus", "financialStatus", "tags", "gateways"]) doc[k] = n[k];
  // The address can arrive later (e.g. once the restricted role is granted); never blank out what's there.
  if (n.shippingAddress.address1 || !doc.shippingAddress?.address1) {
    doc.shippingAddress = n.shippingAddress;
    doc.billingAddress = n.billingAddress;
  }
  if (n.customer.name !== "Amazon customer" || !doc.customer?.name) doc.customer = n.customer;
  if (!doc.invoice) {
    const linked = new Map(doc.lines.map((l) => [l.lineId, l.item]));
    for (const k of ["lines", "subtotal", "discount", "shippingTotal", "total", "prepaidAmount", "codAmount", "outstanding", "paymentMode"]) doc[k] = n[k];
    for (const l of doc.lines) if (linked.get(l.lineId)) l.item = linked.get(l.lineId);
    await linkItems(doc, acc.organization, cache);
  }
  const was = doc.status;
  if (fs === "CANCELLED" && !["shipped", "delivered", "rto", "return_created", "returned", "cancelled"].includes(was)) {
    doc.status = "cancelled";
    doc.cancelledAt = new Date(o.lastUpdatedTime || Date.now());
  } else if (fs === "SHIPPED" && ["new", "packed", "ready_to_ship"].includes(was)) {
    if (was !== "ready_to_ship") fromPackages(doc);
    doc.status = delivered(n) ? "delivered" : "shipped";
  } else if (delivered(n) && ["shipped", "ready_to_ship"].includes(was)) {
    doc.status = "delivered";
  }
  if (doc.status !== was) doc.statusChangedAt = new Date();
  if (doc.status === "delivered" && !doc.deliveredAt) {
    doc.deliveredAt = new Date();
    doc.deliveredChecked = true;
  }
  await doc.save();
  return { result: "updated", doc };
}

// Invoice by OrdexaGo: orders from the day Amazon was connected (older ones come in through the MTR import).
const shouldInvoice = (acc, doc) => acc.invoiceBy === "ordexago" && !doc.invoice && ["ready_to_ship", "shipped", "delivered"].includes(doc.status) && (!acc.invoiceFrom || doc.orderDate >= acc.invoiceFrom);

async function autoInvoice(acc, doc) {
  if (!shouldInvoice(acc, doc)) return false;
  try {
    await require("./invoice").invoiceAmazonOrder(doc, acc);
    return true;
  } catch (e) {
    await ShopifyOrder.updateOne({ _id: doc._id }, { invoiceError: e.message }).catch(() => {});
    return false;
  }
}

// Search with buyer details when the app has the restricted role, otherwise without (no names / addresses).
async function search(acc, query) {
  let token;
  if (acc.pii?.ok !== false || !acc.pii?.checkedAt || Date.now() - new Date(acc.pii.checkedAt) > 6 * 3600000) {
    try {
      token = await rdtFor(acc, "GET", SEARCH);
      acc.pii = { ok: true, note: "", checkedAt: new Date() };
    } catch (e) {
      acc.pii = { ok: false, note: `Buyer names and addresses aren't available: ${e.message}`, checkedAt: new Date() };
    }
  }
  try {
    return await call(acc, "GET", SEARCH, { query, token });
  } catch (e) {
    if (!token || ![400, 403].includes(e.status)) throw e;
    acc.pii = { ok: false, note: `Buyer names and addresses aren't available: ${e.message}`, checkedAt: new Date() };
    return call(acc, "GET", SEARCH, { query });
  }
}

async function syncAccount(acc, { full = false } = {}) {
  acc.sync = { running: true, startedAt: new Date(), fetched: 0, created: 0, updated: 0, invoiced: 0, error: "" };
  await acc.save();
  const started = new Date();
  try {
    const storeOrg = await storeOrgFor(acc.organization);
    const base = { marketplaceIds: [acc.marketplaceId || "A21TJRUUN4KGTV"], fulfilledBy: ["MERCHANT"], includedData: INCLUDED, maxResultsPerPage: 100 };
    const since = !full && acc.lastSyncAt ? { lastUpdatedAfter: new Date(acc.lastSyncAt.getTime() - 10 * 60000).toISOString() } : { createdAfter: (acc.syncFrom || new Date(Date.now() - 7 * 86400000)).toISOString() };
    let token = "";
    let pages = 0;
    const cache = {};
    do {
      const r = await search(acc, token ? { ...base, paginationToken: token } : { ...base, ...since });
      for (const o of r.orders || []) {
        acc.sync.fetched++;
        const u = await upsert(acc, storeOrg, o, cache);
        if (u.result === "created") acc.sync.created++;
        if (u.result === "updated") acc.sync.updated++;
        if (u.doc && (await autoInvoice(acc, u.doc))) acc.sync.invoiced++;
      }
      token = r.pagination?.nextToken || "";
      pages++;
      if (pages % 5 === 0) await acc.save().catch(() => {});
    } while (token && pages < 200);
    acc.lastSyncAt = started;
    acc.connected = true;
  } catch (e) {
    acc.sync.error = e.message;
    if (/token|LWA|client/i.test(e.message) && /didn't issue/i.test(e.message)) acc.connected = false;
  }
  acc.sync.running = false;
  acc.sync.finishedAt = new Date();
  acc.markModified("pii");
  await acc.save();
  return acc.sync;
}

async function autoSyncAll() {
  for (const acc of await AmazonAccount.find({ connected: true, autoSync: { $ne: false } })) {
    if (acc.sync?.running && acc.sync.startedAt > new Date(Date.now() - 30 * 60000)) continue;
    await syncAccount(acc).catch((e) => console.error("Amazon sync failed:", e.message));
  }
}

module.exports = { normalise, upsert, syncAccount, autoSyncAll, storeOrgFor, autoInvoice, shouldInvoice, lineOf, SEARCH };
