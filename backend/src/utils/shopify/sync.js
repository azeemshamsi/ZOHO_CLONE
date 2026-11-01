/**
 * Pull orders from Shopify into ShopifyOrder. First run: from the store's "sync from" date.
 * After that: orders updated since the last sync (a few minutes' overlap).
 */
const ShopifyStore = require("../../models/ShopifyStore");
const ShopifyOrder = require("../../models/ShopifyOrder");
const { gql } = require("./client");
const { stateCode } = require("../import/common");

const MONEY = "shopMoney { amount }";
const ADDR = "name company address1 address2 city province provinceCode zip country countryCodeV2 phone";
const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name number createdAt updatedAt processedAt cancelledAt cancelReason
      displayFinancialStatus displayFulfillmentStatus returnStatus
      email phone note tags paymentGatewayNames currencyCode
      customer { displayName email phone }
      shippingAddress { ${ADDR} }
      billingAddress { ${ADDR} }
      subtotalPriceSet { ${MONEY} }
      totalDiscountsSet { ${MONEY} }
      totalShippingPriceSet { ${MONEY} }
      totalTaxSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalOutstandingSet { ${MONEY} }
      fulfillments(first: 5) { trackingInfo(first: 1) { company number url } }
      transactions(first: 30) { kind status gateway amountSet { ${MONEY} } }
      lineItems(first: 50) {
        nodes {
          id title variantTitle sku quantity currentQuantity vendor
          image { url(transform: { maxWidth: 160 }) }
          originalUnitPriceSet { ${MONEY} }
          discountAllocations { allocatedAmountSet { ${MONEY} } }
          taxLines { ratePercentage }
          product { id productType tags category { fullName } }
          variant { id sku inventoryItem { harmonizedSystemCode } }
        }
      }
    }
  }
}`;

const amt = (s) => Number(s?.shopMoney?.amount) || 0;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function address(a) {
  if (!a) return {};
  const india = !a.countryCodeV2 || a.countryCodeV2 === "IN";
  return {
    name: a.name || "",
    company: a.company || "",
    address1: a.address1 || "",
    address2: a.address2 || "",
    city: a.city || "",
    province: a.province || "",
    state: india ? stateCode(a.provinceCode || a.province) || stateCode(a.province) || "" : "",
    zip: (a.zip || "").replace(/\s/g, ""),
    country: a.country || "",
    phone: a.phone || "",
  };
}

const COD_RX = /\bcod\b|cash on delivery|cash_on_delivery|cash-on-delivery/i;

// Prepaid, COD, or partly paid (part prepaid online, the rest collected on delivery).
function payment(o, total) {
  const gws = o.paymentGatewayNames || [];
  const hasCod = gws.some((g) => COD_RX.test(g));
  const ok = (o.transactions || []).filter((t) => t.status === "SUCCESS");
  const online = (t) => !COD_RX.test(t.gateway || "") && !(hasCod && /^manual$/i.test(t.gateway || ""));
  const paid = ok.filter((t) => ["SALE", "CAPTURE"].includes(t.kind) && online(t)).reduce((s, t) => s + amt(t.amountSet), 0);
  const refunded = ok.filter((t) => t.kind === "REFUND" && online(t)).reduce((s, t) => s + amt(t.amountSet), 0);
  let prepaid = r2(Math.max(0, paid - refunded));
  if (!hasCod) {
    // No COD gateway: prepaid. (Shopify's own "partially paid" without COD stays prepaid; the rest is outstanding.)
    return { paymentMode: o.displayFinancialStatus === "PARTIALLY_PAID" && prepaid < total ? "partial" : "prepaid", prepaidAmount: prepaid || (o.displayFinancialStatus === "PAID" ? total : 0), codAmount: o.displayFinancialStatus === "PARTIALLY_PAID" ? r2(Math.max(0, total - prepaid)) : 0 };
  }
  if (prepaid >= total - 0.5) return { paymentMode: "prepaid", prepaidAmount: total, codAmount: 0 };
  if (prepaid > 0) return { paymentMode: "partial", prepaidAmount: prepaid, codAmount: r2(total - prepaid) };
  return { paymentMode: "cod", prepaidAmount: 0, codAmount: total };
}

function normalise(o) {
  const lines = (o.lineItems?.nodes || []).map((l) => {
    const qty = l.currentQuantity ?? l.quantity;
    const unit = amt(l.originalUnitPriceSet);
    const disc = (l.discountAllocations || []).reduce((s, d) => s + amt(d.allocatedAmountSet), 0);
    // Discounts on removed units: scale to the remaining quantity.
    const discount = l.quantity ? r2((disc * qty) / l.quantity) : 0;
    return {
      lineId: l.id,
      productId: l.product?.id || "",
      variantId: l.variant?.id || "",
      title: l.title,
      variantTitle: l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : "",
      sku: (l.sku || l.variant?.sku || "").trim(),
      vendor: l.vendor || "",
      productType: l.product?.productType || "",
      category: l.product?.category?.fullName || "",
      tags: l.product?.tags || [],
      image: l.image?.url || "",
      hsn: (l.variant?.inventoryItem?.harmonizedSystemCode || "").replace(/\D/g, ""),
      shopifyTaxRate: r2((l.taxLines || []).reduce((s, t) => s + (Number(t.ratePercentage) || 0), 0)),
      quantity: qty,
      unitPrice: unit,
      discount,
      total: r2(unit * qty - discount),
    };
  });
  const ship = address(o.shippingAddress);
  const total = amt(o.currentTotalPriceSet);
  return {
    ...payment(o, total),
    shopifyId: o.id,
    name: o.name,
    orderNumber: o.number,
    orderDate: new Date(o.processedAt || o.createdAt),
    shopifyUpdatedAt: new Date(o.updatedAt),
    customer: {
      name: o.customer?.displayName || ship.name || o.billingAddress?.name || "",
      email: o.email || o.customer?.email || "",
      phone: o.phone || o.customer?.phone || ship.phone || o.billingAddress?.phone || "",
    },
    shippingAddress: ship,
    billingAddress: address(o.billingAddress),
    financialStatus: o.displayFinancialStatus || "",
    fulfillmentStatus: o.displayFulfillmentStatus || "",
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    cancelReason: o.cancelReason || "",
    returnStatus: o.returnStatus || "",
    gateways: o.paymentGatewayNames || [],
    tags: o.tags || [],
    note: o.note || "",
    currency: o.currencyCode || "INR",
    subtotal: amt(o.subtotalPriceSet),
    discount: amt(o.totalDiscountsSet),
    shippingTotal: amt(o.totalShippingPriceSet),
    tax: amt(o.totalTaxSet),
    total: amt(o.currentTotalPriceSet),
    outstanding: amt(o.totalOutstandingSet),
    lines,
    shopifyFulfillments: (o.fulfillments || []).flatMap((f) => f.trackingInfo || []).map((t) => ({ company: t.company || "", number: t.number || "", url: t.url || "" })),
  };
}

// Save one order; OrdexaGo's own workflow status is kept, except for cancellations and fulfilments done in Shopify.
async function upsert(orgId, n) {
  const existing = await ShopifyOrder.findOne({ organization: orgId, shopifyId: n.shopifyId });
  if (!existing) {
    let status = "new";
    if (n.cancelledAt) status = "cancelled";
    else if (n.fulfillmentStatus === "FULFILLED") status = "shipped";
    const doc = { ...n, organization: orgId, status, statusChangedAt: new Date() };
    if (status === "shipped" && n.shopifyFulfillments[0]) {
      const f = n.shopifyFulfillments[0];
      doc.shipment = { carrier: "shopify", courierName: f.company, awb: f.number, trackingUrl: f.url };
    }
    await ShopifyOrder.create(doc);
    return "created";
  }
  if (existing.shopifyUpdatedAt && n.shopifyUpdatedAt <= existing.shopifyUpdatedAt) return "same";
  Object.assign(existing, n);
  if (n.cancelledAt && existing.status !== "cancelled" && !["shipped", "delivered", "rto"].includes(existing.status)) {
    existing.status = "cancelled";
    existing.statusChangedAt = new Date();
  } else if (!n.cancelledAt && existing.status === "cancelled") {
    existing.status = "new"; // un-cancelled (rare)
  } else if (["RETURN_REQUESTED", "IN_PROGRESS", "INSPECTION_COMPLETE"].includes(n.returnStatus) && ["shipped", "delivered"].includes(existing.status)) {
    existing.status = "return_created"; // return opened in Shopify
    existing.statusChangedAt = new Date();
  } else if (n.fulfillmentStatus === "FULFILLED" && ["new", "packed"].includes(existing.status)) {
    existing.status = "shipped";
    existing.statusChangedAt = new Date();
    const f = n.shopifyFulfillments[0];
    if (f && !existing.shipment?.awb) existing.shipment = { ...(existing.shipment || {}), carrier: "shopify", courierName: f.company, awb: f.number, trackingUrl: f.url };
  }
  await existing.save();
  return "updated";
}

async function syncStore(store, { full = false } = {}) {
  if (store.sync?.running && store.sync.startedAt > new Date(Date.now() - 30 * 60000)) return store.sync;
  const startedAt = new Date();
  await ShopifyStore.updateOne({ _id: store._id }, { sync: { running: true, startedAt, fetched: 0, created: 0, updated: 0, error: "" } });
  const counts = { fetched: 0, created: 0, updated: 0 };
  let since = !full && store.lastSyncAt ? new Date(store.lastSyncAt.getTime() - 10 * 60000) : store.syncFrom || new Date(Date.now() - 60 * 86400000);
  const query = `updated_at:>='${since.toISOString()}'`;
  try {
    let after = null;
    for (let page = 0; page < 1000; page++) {
      const data = await gql(store, ORDERS_QUERY, { first: 25, after, query });
      for (const o of data.orders.nodes) {
        const n = normalise(o);
        if (store.syncFrom && n.orderDate < store.syncFrom) continue;
        const r = await upsert(store.organization, n);
        counts.fetched++;
        if (r === "created") counts.created++;
        if (r === "updated") counts.updated++;
      }
      await ShopifyStore.updateOne({ _id: store._id }, { "sync.fetched": counts.fetched, "sync.created": counts.created, "sync.updated": counts.updated });
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    // New orders' products become OrdexaGo items straight away (HSN and GST checked).
    const { ensureItems } = require("./invoice");
    const cache = new Map();
    for (const o of await ShopifyOrder.find({ organization: store.organization, "lines.item": { $exists: false } }).limit(5000)) {
      await ensureItems(store.organization, o, store, cache);
      await o.save();
    }
    await ShopifyStore.updateOne({ _id: store._id }, { lastSyncAt: startedAt, connected: true, sync: { running: false, startedAt, finishedAt: new Date(), ...counts, error: "" } });
  } catch (e) {
    await ShopifyStore.updateOne({ _id: store._id }, { sync: { running: false, startedAt, finishedAt: new Date(), ...counts, error: e.message } });
    throw e;
  }
  return counts;
}

// Every 15 minutes: stores with auto-sync on.
async function autoSyncAll() {
  for (const s of await ShopifyStore.find({ connected: true, autoSync: true })) {
    await syncStore(s).catch((e) => console.error(`Shopify sync (${s.shop}) failed: ${e.message}`));
  }
}

module.exports = { syncStore, autoSyncAll, normalise, upsert, ORDERS_QUERY };

// Real-time: Shopify calls OrdexaGo when orders are created or updated (Dev Dashboard apps; signed with the client secret).
async function registerWebhooks(store, baseUrl) {
  if (store.authType !== "client" || !store.clientSecret || !/^https:\/\//.test(baseUrl || "") || /localhost|127\.0\.0\.1/.test(baseUrl)) return [];
  const uri = `${baseUrl.replace(/\/+$/, "")}/api/shopify-webhook/${store._id}`;
  const done = [];
  for (const topic of ["ORDERS_CREATE", "ORDERS_UPDATED"]) {
    const r = await gql(store, `mutation($t: WebhookSubscriptionTopic!, $s: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $t, webhookSubscription: $s) { webhookSubscription { id } userErrors { message } } }`, { t: topic, s: { uri, format: "JSON" } }).catch((e) => ({ err: e.message }));
    const errs = r.webhookSubscriptionCreate?.userErrors || [];
    if (r.webhookSubscriptionCreate?.webhookSubscription || errs.some((e) => /already|taken/i.test(e.message))) done.push(topic);
  }
  await ShopifyStore.updateOne({ _id: store._id }, { webhooks: done });
  return done;
}

const pending = new Map();
// A webhook arrived: sync that store's recent changes shortly (several webhooks in a burst = one sync).
function syncSoon(store) {
  const k = String(store._id);
  clearTimeout(pending.get(k));
  pending.set(
    k,
    setTimeout(async () => {
      pending.delete(k);
      const s = await ShopifyStore.findById(k);
      if (s?.connected) await syncStore(s).catch((e) => console.error(`Shopify sync failed: ${e.message}`));
    }, 3000).unref()
  );
}

module.exports.registerWebhooks = registerWebhooks;
module.exports.syncSoon = syncSoon;
