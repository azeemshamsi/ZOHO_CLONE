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
// A fulfilment as Shopify reports it, including the delivery progress the courier feeds back to Shopify.
const FULFILMENT = "status displayStatus deliveredAt inTransitAt trackingInfo(first: 1) { company number url }";
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
      fulfillments(first: 10) { ${FULFILMENT} }
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
  // COD: a COD payment method, a COD tag (checkout apps such as Cashfree tag "CASHFREE - COD" and use the
  // "manual" method), or an order still pending with nothing paid online.
  const pendingUnpaid = o.displayFinancialStatus === "PENDING" && !(o.transactions || []).some((t) => t.status === "SUCCESS" && ["SALE", "CAPTURE"].includes(t.kind) && !/^manual$/i.test(t.gateway || "") && !COD_RX.test(t.gateway || ""));
  const hasCod = gws.some((g) => COD_RX.test(g)) || (o.tags || []).some((t) => COD_RX.test(t)) || pendingUnpaid;
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
    // Cancelled fulfilments don't count.
    shopifyFulfillments: activeFulfilments(o).flatMap((f) => f.trackingInfo || []).map((t) => ({ company: t.company || "", number: t.number || "", url: t.url || "" })),
    shopifyDelivery: deliveryOf(o),
  };
}

const activeFulfilments = (o) => (o.fulfillments || []).filter((f) => !["CANCELLED", "ERROR", "FAILURE"].includes(f.status));

// Delivery progress from Shopify's (non-cancelled) fulfilments: delivered only when every one of them is delivered.
const TRACK_OF = { DELIVERED: "delivered", OUT_FOR_DELIVERY: "out_for_delivery", IN_TRANSIT: "in_transit", ATTEMPTED_DELIVERY: "in_transit", PICKED_UP: "in_transit", CONFIRMED: "pending", FULFILLED: "pending", MARKED_AS_FULFILLED: "pending" };
function deliveryOf(o) {
  const fs = activeFulfilments(o);
  if (!fs.length) return null;
  const tracks = fs.map((f) => TRACK_OF[f.displayStatus] || "");
  if (tracks.every((t) => t === "delivered")) {
    const at = fs.map((f) => f.deliveredAt && new Date(f.deliveredAt)).filter(Boolean).sort((a, b) => b - a)[0];
    return { status: "delivered", at: at || null };
  }
  const order = ["out_for_delivery", "in_transit", "pending"];
  return { status: order.find((t) => tracks.includes(t)) || "", at: null };
}

// Apply Shopify's delivery progress to an order that is out with the courier. Courier tracking in OrdexaGo
// (orders booked here) still runs; Shopify saying "delivered" is also enough, since Shopify gets it from the courier.
function applyDelivery(o, d) {
  if (!d || !d.status || o.status !== "shipped") return false;
  const sh = o.shipment || {};
  if (d.status === "delivered") {
    o.status = "delivered";
    o.deliveredAt = d.at || new Date();
    o.deliveredChecked = !!d.at;
    o.statusChangedAt = new Date();
    if (o.shipment) {
      o.shipment.trackStatus = "delivered";
      o.markModified("shipment");
    }
    return true;
  }
  if (!sh.account && o.shipment && sh.trackStatus !== d.status && d.status !== "pending") {
    o.shipment.trackStatus = d.status;
    o.markModified("shipment");
    return true;
  }
  return false;
}

// Fulfilment statuses that mean nothing has been sent (e.g. the fulfilment was cancelled in Shopify).
const NOT_FULFILLED = ["UNFULFILLED", "OPEN", "PENDING_FULFILLMENT", "ON_HOLD", "SCHEDULED"];

// The Shopify fulfilment was cancelled after the order was marked shipped (wasFulfilled: Shopify had a fulfilment).
// From Shopify only → back to New. Booked in OrdexaGo → back to Ready to Ship while the courier hasn't picked it
// up (so the shipment can be cancelled or kept), with a note either way.
function undoCancelledFulfilment(o, wasFulfilled) {
  if (!wasFulfilled || !NOT_FULFILLED.includes(o.fulfillmentStatus) || !["shipped", "ready_to_ship"].includes(o.status)) return false;
  const sh = o.shipment || {};
  const when = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  if (!sh.account) {
    if (sh.carrier !== "shopify") return false; // marked shipped by hand
    const was = [sh.courierName, sh.awb].filter(Boolean).join(" ");
    o.shipment = {};
    o.status = "new";
    o.remarks = `${o.remarks ? `${o.remarks}\n` : ""}Shopify fulfilment${was ? ` ${was}` : ""} was cancelled in Shopify (${when})`;
  } else {
    const moving = ["in_transit", "out_for_delivery", "delivered"].includes(sh.trackStatus);
    if (o.status === "ready_to_ship" && !sh.shopifyFulfilled) return false;
    o.shipment.shopifyFulfilled = false;
    o.shipment.error = moving ? "The fulfilment was cancelled in Shopify, but the courier shows it moving" : `The fulfilment was cancelled in Shopify (${when}) — cancel this ${sh.courierName || ""} shipment too if it isn't going`;
    if (!moving) o.status = "ready_to_ship";
    o.markModified("shipment");
  }
  o.statusChangedAt = new Date();
  return true;
}

// Save one order; OrdexaGo's own workflow status is kept, except for cancellations and fulfilments done in Shopify.
const OPEN_RETURN = ["RETURN_REQUESTED", "IN_PROGRESS", "INSPECTION_COMPLETE"];

/**
 * Orders in Returns, against their returns in Shopify: all declined / cancelled → back to Delivered (or Shipped);
 * closed with none open → closed here too (toClose). No return in Shopify at all (made only in OrdexaGo) → left.
 */
async function reconcileReturns(store, toClose = []) {
  const open = (await ShopifyOrder.find({ organization: store.organization, status: "return_created", channel: { $ne: "amazon" } }, { shopifyId: 1, deliveredAt: 1, returnFrom: 1, returnNote: 1 })).filter((o) => String(o.shopifyId || "").startsWith("gid://"));
  let reverted = 0;
  for (let i = 0; i < open.length; i += 50) {
    const batch = open.slice(i, i + 50);
    const data = await gql(store, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id returnStatus returns(first: 10) { nodes { status } } } } }`, { ids: batch.map((o) => o.shopifyId) });
    const byId = new Map((data.nodes || []).filter(Boolean).map((n) => [n.id, n]));
    for (const o of batch) {
      const n = byId.get(o.shopifyId);
      const st = (n?.returns?.nodes || []).map((r) => r.status);
      if (!n || !st.length) continue;
      const anyOpen = st.some((x) => ["OPEN", "REQUESTED"].includes(x));
      if (anyOpen) continue;
      if (st.includes("CLOSED")) {
        if (!toClose.some((x) => String(x) === String(o._id))) toClose.push(o._id);
      } else if (st.every((x) => ["DECLINED", "CANCELED"].includes(x))) {
        o.status = o.returnFrom || (o.deliveredAt ? "delivered" : "shipped");
        o.statusChangedAt = new Date();
        o.returnNote = [o.returnNote, "Return declined / cancelled in Shopify"].filter(Boolean).join(" · ");
        await o.save();
        reverted++;
      }
    }
  }
  return reverted;
}

async function upsert(orgId, n, toClose = []) {
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
    if (status === "shipped" && n.shopifyDelivery?.status === "delivered") {
      doc.status = "delivered";
      doc.deliveredAt = n.shopifyDelivery.at || new Date();
      doc.deliveredChecked = !!n.shopifyDelivery.at;
      if (doc.shipment) doc.shipment.trackStatus = "delivered";
    }
    await ShopifyOrder.create(doc);
    return "created";
  }
  if (existing.shopifyUpdatedAt && n.shopifyUpdatedAt <= existing.shopifyUpdatedAt) return "same";
  const wasFulfilled = existing.fulfillmentStatus === "FULFILLED" || existing.fulfillmentStatus === "PARTIALLY_FULFILLED";
  const prevReturn = existing.returnStatus || "";
  Object.assign(existing, n);
  if (n.cancelledAt && existing.status !== "cancelled" && !["shipped", "delivered", "rto"].includes(existing.status)) {
    existing.status = "cancelled";
    existing.statusChangedAt = new Date();
  } else if (!n.cancelledAt && existing.status === "cancelled") {
    existing.status = "new"; // un-cancelled (rare)
  } else if (OPEN_RETURN.includes(n.returnStatus) && ["shipped", "delivered"].includes(existing.status)) {
    // Return opened in Shopify (requested by the customer or created by the store): Returns tab.
    existing.returnFrom = existing.status;
    existing.status = "return_created";
    existing.statusChangedAt = new Date();
  } else if (existing.status === "return_created" && n.returnStatus === "NO_RETURN" && (OPEN_RETURN.includes(prevReturn) || existing.shopifyReturnId)) {
    // Return request declined (or the return cancelled) in Shopify: back to Delivered (or Shipped).
    existing.status = existing.returnFrom || (existing.deliveredAt ? "delivered" : "shipped");
    existing.statusChangedAt = new Date();
    existing.returnNote = [existing.returnNote, "Return declined / cancelled in Shopify"].filter(Boolean).join(" · ");
  } else if (n.returnStatus === "RETURNED" && prevReturn !== "RETURNED" && ["return_created", "shipped", "delivered", "rto"].includes(existing.status)) {
    // Return closed in Shopify: Returned, with the credit note and stock back (after saving).
    toClose.push(existing._id);
  } else if (n.fulfillmentStatus === "FULFILLED" && ["new", "packed"].includes(existing.status)) {
    existing.status = "shipped";
    existing.statusChangedAt = new Date();
    const f = n.shopifyFulfillments[0];
    if (f && !existing.shipment?.awb) existing.shipment = { ...(existing.shipment || {}), carrier: "shopify", courierName: f.company, awb: f.number, trackingUrl: f.url };
  } else if (!undoCancelledFulfilment(existing, wasFulfilled) && existing.shipment?.carrier === "shopify" && !existing.shipment.account && n.shopifyFulfillments[0] && n.shopifyFulfillments[0].number !== existing.shipment.awb) {
    // Fulfilled again in Shopify with a new tracking number.
    const f = n.shopifyFulfillments[0];
    existing.shipment = { ...existing.shipment.toObject?.() || existing.shipment, courierName: f.company, awb: f.number, trackingUrl: f.url };
  }
  applyDelivery(existing, n.shopifyDelivery);
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
  const toClose = [];
  try {
    let after = null;
    for (let page = 0; page < 1000; page++) {
      const data = await gql(store, ORDERS_QUERY, { first: 25, after, query });
      for (const o of data.orders.nodes) {
        const n = normalise(o);
        if (store.syncFrom && n.orderDate < store.syncFrom) continue;
        const r = await upsert(store.organization, n, toClose);
        counts.fetched++;
        if (r === "created") counts.created++;
        if (r === "updated") counts.updated++;
      }
      await ShopifyStore.updateOne({ _id: store._id }, { "sync.fetched": counts.fetched, "sync.created": counts.created, "sync.updated": counts.updated });
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    // Returns closed in Shopify: Returned in OrdexaGo, credit note + stock back (Shopify is already done).
    // …and every order still in Returns, checked against its returns in Shopify (declined / closed earlier).
    const reverted = await reconcileReturns(store, toClose).catch((e) => (console.error(`Shopify returns check failed: ${e.message}`), 0));
    if (reverted || toClose.length) require("./orderIndex").forget(store.organization);
    if (toClose.length) {
      const { markReturnClosed } = require("./returns");
      for (const id of toClose) {
        const o = await ShopifyOrder.findById(id);
        if (o && o.status !== "returned") await markReturnClosed({ org: store.organization, user: null }, o, store, { shopifyDone: true }).catch((e) => console.error(`Closing return ${o.name} failed: ${e.message}`));
      }
    }
    // New orders' products become OrdexaGo items straight away (HSN and GST checked).
    const { ensureItems } = require("./invoice");
    const cache = new Map();
    for (const o of await ShopifyOrder.find({ organization: store.organization, "lines.item": { $exists: false } }).limit(5000)) {
      await ensureItems(store.organization, o, store, cache);
      await o.save();
    }
    counts.delivered = await refreshDeliveries(store).catch((e) => (console.error(`Shopify delivery check failed: ${e.message}`), 0));
    await ShopifyStore.updateOne({ _id: store._id }, { lastSyncAt: startedAt, connected: true, sync: { running: false, startedAt, finishedAt: new Date(), ...counts, error: "" } });
  } catch (e) {
    await ShopifyStore.updateOne({ _id: store._id }, { sync: { running: false, startedAt, finishedAt: new Date(), ...counts, error: e.message } });
    throw e;
  }
  return counts;
}

// Shopify doesn't always mark an order as updated when its fulfilment gets delivered, so orders out with the
// courier are checked directly (in batches) after every sync and every couple of hours.
// withDelivered: also confirm the delivery time of delivered orders not yet checked against Shopify.
async function refreshDeliveries(store, { withDelivered = false } = {}) {
  const since = new Date(Date.now() - 120 * 86400000);
  const statuses = withDelivered ? ["shipped", "delivered"] : ["shipped"];
  // Shipped orders of any age (an old order can still be out, or was delivered / returned / cancelled in Shopify
  // without the order being touched since); delivered ones only to confirm the delivery time of recent orders.
  const open = (await ShopifyOrder.find({ organization: store.organization, status: { $in: statuses } })).filter((o) => String(o.shopifyId || "").startsWith("gid://") && (o.status === "shipped" || (!o.deliveredChecked && (!o.orderDate || o.orderDate >= since))));
  let changed = 0;
  const toClose = [];
  for (let i = 0; i < open.length; i += 50) {
    const batch = open.slice(i, i + 50);
    const data = await gql(store, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id cancelledAt returnStatus fulfillments(first: 10) { ${FULFILMENT} } } } }`, { ids: batch.map((o) => o.shopifyId) });
    const byId = new Map((data.nodes || []).filter(Boolean).map((n) => [n.id, n]));
    for (const o of batch) {
      const n = byId.get(o.shopifyId);
      if (!n) continue;
      const d = deliveryOf(n);
      if (o.status === "delivered") {
        // Already delivered here: take Shopify's delivery time when it has one.
        if (d?.status === "delivered" && d.at && String(d.at) !== String(o.deliveredAt)) o.deliveredAt = d.at;
        o.deliveredChecked = true;
        await o.save();
        changed++;
        continue;
      }
      // Shipped here, but Shopify has moved on.
      if (n.returnStatus === "RETURNED") {
        // Returned in Shopify long ago: closing it here posts a credit note against OrdexaGo's invoice, so it waits
        // for the user (Store → Orders shows these with a "Close returns" button). Without an invoice it just closes.
        if (o.returnStatus !== "RETURNED") {
          o.returnStatus = "RETURNED";
          await o.save();
          changed++;
        }
        if (!o.invoice) toClose.push(o._id);
      } else if (OPEN_RETURN.includes(n.returnStatus)) {
        o.returnStatus = n.returnStatus;
        o.returnFrom = d?.status === "delivered" ? "delivered" : "shipped";
        if (d?.status === "delivered") o.deliveredAt = o.deliveredAt || d.at || new Date();
        o.status = "return_created";
        o.statusChangedAt = new Date();
        await o.save();
        changed++;
      } else if (n.cancelledAt) {
        o.status = "cancelled";
        o.cancelledAt = new Date(n.cancelledAt);
        o.statusChangedAt = new Date();
        o.remarks = [o.remarks, `Cancelled in Shopify after it was shipped${o.invoiceNumber ? ` — invoice ${o.invoiceNumber} is still in the books` : ""}`].filter(Boolean).join("\n");
        await o.save();
        changed++;
      } else if (applyDelivery(o, d)) {
        await o.save();
        changed++;
      }
    }
  }
  if (toClose.length) {
    const { markReturnClosed } = require("./returns");
    for (const id of toClose) {
      const o = await ShopifyOrder.findById(id);
      if (o && o.status !== "returned") await markReturnClosed({ org: store.organization, user: null }, o, store, { shopifyDone: true }).catch((e) => console.error(`Closing return ${o.name} failed: ${e.message}`));
    }
  }
  if (changed) require("./orderIndex").forget(store.organization);
  return changed;
}

async function refreshAllDeliveries() {
  for (const s of await ShopifyStore.find({ connected: true })) await refreshDeliveries(s, { withDelivered: true }).catch((e) => console.error(`Shopify delivery check (${s.shop}) failed: ${e.message}`));
}

// Every 15 minutes: stores with auto-sync on.
async function autoSyncAll() {
  for (const s of await ShopifyStore.find({ connected: true, autoSync: true })) {
    await syncStore(s).catch((e) => console.error(`Shopify sync (${s.shop}) failed: ${e.message}`));
  }
}

module.exports = { reconcileReturns, syncStore, autoSyncAll, normalise, upsert, ORDERS_QUERY, undoCancelledFulfilment, refreshDeliveries, refreshAllDeliveries, deliveryOf, applyDelivery };

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
