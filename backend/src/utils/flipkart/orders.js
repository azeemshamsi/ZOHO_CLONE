/**
 * Flipkart orders → Store → Orders (ShopifyOrder with channel "flipkart"; one per Flipkart shipment).
 * Seller API v3 shipments: open ones (preDispatch), shipped / delivered ones and cancellations are read every
 * 15 minutes. Flipkart's state wins, except OrdexaGo's own "AWB scanned" mark.
 * Flipkart logistics (Ekart) orders: Pack → print Flipkart's label + invoice → Ready to Dispatch.
 * Self-ship orders: book with our own couriers; OrdexaGo then tells Flipkart the courier and AWB, and the delivery.
 * Books: Flipkart sales come in through the monthly Flipkart import, so these orders are never invoiced here.
 */
const FlipkartAccount = require("../../models/FlipkartAccount");
const ShopifyOrder = require("../../models/ShopifyOrder");
const { call } = require("./client");
const { stateCode } = require("../import/common");

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (x) => Number(x) || 0;
const PRE = ["APPROVED", "PACKING_IN_PROGRESS", "FORM_FAILED", "PACKED", "READY_TO_DISPATCH"];
const POST = ["SHIPPED", "DELIVERED"];
const STATUS = { APPROVED: "new", PACKING_IN_PROGRESS: "new", FORM_FAILED: "packed", PACKED: "packed", READY_TO_DISPATCH: "ready_to_ship", PICKUP_COMPLETE: "shipped", SHIPPED: "shipped", DELIVERED: "delivered", CANCELLED: "cancelled", RETURN_REQUESTED: "return_created", RETURNED: "returned" };
const RANK = { new: 0, packed: 1, ready_to_ship: 2, shipped: 3, delivered: 4, return_created: 5, returned: 6, rto: 6, cancelled: 7 };
const day = (d) => new Date(d).toISOString();

const storeOrgFor = (org) => require("../amazon/orders").storeOrgFor(org);

function addressOf(a = {}) {
  return {
    name: [a.firstName, a.lastName].filter(Boolean).join(" "),
    company: "",
    address1: a.addressLine1 || "",
    address2: [a.addressLine2, a.landmark].filter(Boolean).join(", "),
    city: a.city || "",
    province: a.stateName || a.state || "",
    state: stateCode(a.stateName || a.state || "") || "",
    zip: String(a.pincode || ""),
    country: "India",
    phone: a.contactNumber || "",
  };
}

// The worst-advanced state of the shipment's items decides (all items of a shipment move together on Flipkart).
const stateOf = (s) => {
  const st = (s.orderItems || []).map((i) => i.status).filter(Boolean);
  if (!st.length) return "";
  if (st.every((x) => x === "CANCELLED")) return "CANCELLED";
  return st.filter((x) => x !== "CANCELLED").sort((a, b) => (RANK[STATUS[a]] ?? 0) - (RANK[STATUS[b]] ?? 0))[0];
};

function normalise(s, details, acc) {
  const items = (s.orderItems || []).filter((i) => i.status !== "CANCELLED" || (s.orderItems || []).every((x) => x.status === "CANCELLED"));
  const lines = items.map((i) => {
    const p = i.priceComponents || {};
    const qty = num(i.quantity) || 1;
    const ship = num(p.shippingCharge);
    const total = num(p.totalPrice) || num(p.sellingPrice) + ship;
    return {
      lineId: i.orderItemId,
      productId: i.fsn || "",
      title: i.title || i.productTitle || i.sku || i.fsn || "Flipkart item",
      variantTitle: "",
      sku: i.sku || "",
      vendor: "",
      tags: [],
      hsn: i.hsn || "",
      quantity: qty,
      unitPrice: r2((total - ship) / qty),
      discount: 0,
      total: r2(total - ship),
      shopifyTaxRate: 0,
    };
  });
  const shippingTotal = r2(items.reduce((t, i) => t + num(i.priceComponents?.shippingCharge), 0));
  const total = r2(items.reduce((t, i) => t + (num(i.priceComponents?.totalPrice) || num(i.priceComponents?.sellingPrice) + num(i.priceComponents?.shippingCharge)), 0));
  const payType = String(items.map((i) => i.paymentType).find(Boolean) || details?.paymentType || "").toUpperCase();
  const cod = payType === "COD";
  const d = details || {};
  const ship = addressOf(d.deliveryAddress);
  const bill = d.billingAddress?.addressLine1 ? addressOf(d.billingAddress) : ship;
  const sub = (s.subShipments || d.subShipments || [])[0] || {};
  const courier = sub.courierDetails || {};
  const typeText = [s.shipmentType, d.shipmentType, s.serviceProfile, d.serviceProfile, ...(s.subShipments || []).map((x) => x.shipmentType)].filter(Boolean).join(" ");
  const selfShip = /self/i.test(typeText) ? true : courier.deliveryDetails?.trackingId || courier.pickupDetails?.trackingId ? false : null;
  const orderId = items[0]?.orderId || (s.orderItems || [])[0]?.orderId || s.shipmentId;
  return {
    channel: "flipkart",
    name: orderId,
    orderDate: new Date(items[0]?.orderDate || (s.orderItems || [])[0]?.orderDate || Date.now()),
    shopifyUpdatedAt: new Date(s.updatedAt || Date.now()),
    customer: { name: [d.buyerDetails?.firstName, d.buyerDetails?.lastName].filter(Boolean).join(" ") || ship.name || "Flipkart customer", email: d.buyerDetails?.email || "", phone: d.buyerDetails?.contactNumber || ship.phone || "" },
    shippingAddress: ship,
    billingAddress: bill,
    financialStatus: cod ? "PENDING" : "PAID",
    paymentMode: cod ? "cod" : "prepaid",
    prepaidAmount: cod ? 0 : total,
    codAmount: cod ? total : 0,
    gateways: payType ? [payType] : [],
    tags: ["Flipkart", selfShip ? "Self-ship" : selfShip === false ? "Flipkart logistics" : ""].filter(Boolean),
    currency: "INR",
    subtotal: r2(lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0)),
    discount: 0,
    shippingTotal,
    total,
    outstanding: cod ? total : 0,
    lines,
    flipkart: {
      account: acc._id,
      shipmentId: s.shipmentId,
      orderId,
      state: stateOf(s),
      hold: !!s.hold,
      dispatchAfter: s.dispatchAfterDate ? new Date(s.dispatchAfterDate) : null,
      dispatchBy: s.dispatchByDate ? new Date(s.dispatchByDate) : null,
      locationId: s.locationId || d.locationId || acc.locationId || "",
      selfShip,
      payment: payType,
      subShipments: (s.subShipments || []).map((x) => ({ id: x.subShipmentId || x.id, packages: x.packages || [] })),
      items: (s.orderItems || []).map((i) => ({ orderItemId: i.orderItemId, orderId: i.orderId, sku: i.sku || "", fsn: i.fsn || "", quantity: num(i.quantity), status: i.status, hsn: i.hsn || "" })),
      courier: { name: courier.deliveryDetails?.vendorName || courier.pickupDetails?.vendorName || "", tracking: courier.deliveryDetails?.trackingId || courier.pickupDetails?.trackingId || "" },
    },
  };
}

async function linkItems(doc, orgId, cache) {
  if (doc.lines.every((l) => l.item || !l.sku)) return;
  if (!cache.match) {
    const Item = require("../../models/Item");
    cache.match = require("../import/amazonImport").skuMatcher(await Item.find({ organization: orgId, active: { $ne: false } }, { sku: 1, name: 1 }).lean());
  }
  for (const l of doc.lines) if (!l.item && l.sku) l.item = cache.match(l.sku)?._id;
  doc.markModified("lines");
}

// Flipkart's own courier (Ekart): its tracking number becomes the order's shipment.
function fromCourier(doc) {
  const c = doc.flipkart?.courier || {};
  if (!c.tracking || doc.shipment?.awb || doc.flipkart.selfShip) return;
  doc.shipment = { carrier: "flipkart", courierName: c.name || "Ekart (Flipkart)", awb: c.tracking, bookedAt: new Date(), events: [] };
}

async function upsert(acc, storeOrg, s, details, cache = {}) {
  const n = normalise(s, details, acc);
  const st = n.flipkart.state;
  const target = STATUS[st] || "new";
  const id = `flipkart:${s.shipmentId}`;
  const doc = await ShopifyOrder.findOne({ organization: storeOrg, shopifyId: id });
  if (!doc) {
    const d = new ShopifyOrder({ ...n, organization: storeOrg, shopifyId: id, status: target, statusChangedAt: new Date(), ...(target === "cancelled" ? { cancelledAt: new Date() } : {}) });
    fromCourier(d);
    await linkItems(d, storeOrg, cache);
    await d.save();
    if (target !== "cancelled" && (!acc.reduceFrom || d.orderDate >= acc.reduceFrom)) await require("./inventory").takeFromShopify(acc, d).catch((e) => console.error(`[flipkart] Shopify stock for ${d.name}: ${e.message}`));
    return { result: "created", doc: d };
  }
  doc.flipkart = { ...(doc.flipkart || {}), ...n.flipkart, ...(doc.flipkart?.selfShip != null && n.flipkart.selfShip == null ? { selfShip: doc.flipkart.selfShip } : {}) };
  doc.markModified("flipkart");
  for (const k of ["shopifyUpdatedAt", "financialStatus", "tags", "gateways"]) doc[k] = n[k];
  if (n.shippingAddress.address1) {
    doc.shippingAddress = n.shippingAddress;
    doc.billingAddress = n.billingAddress;
  }
  if (n.customer.name !== "Flipkart customer") doc.customer = n.customer;
  const linked = new Map(doc.lines.map((l) => [l.lineId, l.item]));
  for (const k of ["lines", "subtotal", "shippingTotal", "total", "prepaidAmount", "codAmount", "outstanding", "paymentMode"]) doc[k] = n[k];
  for (const l of doc.lines) if (linked.get(l.lineId)) l.item = linked.get(l.lineId);
  await linkItems(doc, storeOrg, cache);
  fromCourier(doc);
  const was = doc.status;
  // Flipkart's state wins, but never moves an order back (e.g. our own Ready to Ship before Flipkart catches up).
  if (target === "cancelled" && !["delivered", "returned", "cancelled"].includes(was)) {
    doc.status = "cancelled";
    doc.cancelledAt = new Date();
  } else if (target !== "cancelled" && (RANK[target] ?? 0) > (RANK[was] ?? 0)) doc.status = target;
  if (doc.status !== was) doc.statusChangedAt = new Date();
  if (doc.status === "delivered" && !doc.deliveredAt) {
    doc.deliveredAt = new Date();
    doc.deliveredChecked = true;
  }
  await doc.save();
  if (doc.status === "cancelled" && was !== "cancelled" && ["new", "packed", "ready_to_ship"].includes(was)) await require("./inventory").giveBackToShopify(acc, doc).catch((e) => console.error(`[flipkart] Shopify stock back for ${doc.name}: ${e.message}`));
  return { result: "updated", doc };
}

const SH = "/sellers/v3/shipments";

// All pages of one shipments search.
async function filterAll(acc, filter) {
  const out = [];
  let r = await call(acc, "POST", `${SH}/filter/`, { body: { filter, pagination: { pageSize: 20 } } });
  for (let page = 0; page < 300; page++) {
    out.push(...(r.shipments || []));
    if (!r.hasMore || !r.nextPageUrl) break;
    const next = r.nextPageUrl.startsWith("/v3") ? `/sellers${r.nextPageUrl}` : r.nextPageUrl;
    r = await call(acc, "GET", next);
  }
  return out;
}

// Addresses and buyer for up to 25 shipments per call.
async function detailsFor(acc, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    try {
      const r = await call(acc, "GET", `${SH}/${chunk.join(",")}`);
      for (const d of r.shipments || (Array.isArray(r) ? r : [])) out.set(d.shipmentId, d);
    } catch (e) {
      console.error(`[flipkart] shipment details: ${e.message}`);
    }
  }
  return out;
}

async function syncAccount(acc, { full = false } = {}) {
  acc.sync = { running: true, startedAt: new Date(), fetched: 0, created: 0, updated: 0, error: "" };
  await acc.save();
  const started = new Date();
  try {
    const storeOrg = await storeOrgFor(acc.organization);
    const from = full || !acc.lastSyncAt ? acc.syncFrom || new Date(Date.now() - 7 * 86400000) : new Date(Math.min(acc.lastSyncAt.getTime() - 86400000, Date.now() - 3 * 86400000));
    const now = new Date();
    const shipments = [
      ...(await filterAll(acc, { type: "preDispatch", states: PRE })),
      ...(await filterAll(acc, { type: "postDispatch", states: POST, orderDate: { from: day(from), to: day(now) } }).catch((e) => (console.error(`[flipkart] postDispatch: ${e.message}`), []))),
      ...(await filterAll(acc, { type: "cancelled", states: ["CANCELLED"], cancellationDate: { from: day(from), to: day(now) } }).catch((e) => (console.error(`[flipkart] cancelled: ${e.message}`), []))),
    ];
    const seen = new Set();
    const list = shipments.filter((s) => s.shipmentId && !seen.has(s.shipmentId) && seen.add(s.shipmentId));
    if (!acc.locationId) acc.locationId = list.find((s) => s.locationId)?.locationId || "";
    // Addresses only for orders we still have to ship (and new ones).
    const known = new Set((await ShopifyOrder.find({ organization: storeOrg, shopifyId: { $in: list.map((s) => `flipkart:${s.shipmentId}`) } }, { shopifyId: 1, "shippingAddress.address1": 1 }).lean()).filter((o) => o.shippingAddress?.address1).map((o) => o.shopifyId.slice(9)));
    const details = await detailsFor(acc, list.filter((s) => !known.has(s.shipmentId) && stateOf(s) !== "CANCELLED").map((s) => s.shipmentId));
    const cache = {};
    for (const s of list) {
      acc.sync.fetched++;
      const u = await upsert(acc, storeOrg, s, details.get(s.shipmentId), cache);
      if (u.result === "created") acc.sync.created++;
      else acc.sync.updated++;
    }
    if (list.length) require("../shopify/orderIndex").forget(String(storeOrg));
    acc.lastSyncAt = started;
    acc.connected = true;
  } catch (e) {
    acc.sync.error = e.message;
    if (/didn't issue a token/i.test(e.message)) acc.connected = false;
  }
  acc.sync.running = false;
  acc.sync.finishedAt = new Date();
  await acc.save();
  return acc.sync;
}

async function autoSyncAll() {
  for (const acc of await FlipkartAccount.find({ connected: true, autoSync: { $ne: false } })) {
    if (acc.sync?.running && acc.sync.startedAt > new Date(Date.now() - 30 * 60000)) continue;
    await syncAccount(acc).catch((e) => console.error("Flipkart sync failed:", e.message));
  }
}

/* ---------------- actions ---------------- */
const accountOf = async (order) => {
  const acc = await FlipkartAccount.findById(order.flipkart?.account);
  if (!acc) throw new Error("Its Flipkart account isn't connected any more");
  return acc;
};
const locOf = (acc, order) => {
  const l = order.flipkart?.locationId || acc.locationId;
  if (!l) throw new Error("Flipkart location not known yet — sync orders first, or enter the location ID in Store → Flipkart");
  return l;
};
const result = (r, what) => {
  const x = (r.shipments || [])[0] || {};
  if (x.processingStatus && x.processingStatus !== "SUCCESS") throw new Error(`Flipkart didn't ${what}: ${x.errorMessage || x.errorCode || x.processingStatus}`);
  return x;
};

// Pack: GST rate per item and the box size → Flipkart makes the label and its invoice (a few seconds).
async function pack(order, pkg) {
  const acc = await accountOf(order);
  const Item = require("../../models/Item");
  const items = new Map((await Item.find({ _id: { $in: order.lines.map((l) => l.item).filter(Boolean) } }, { taxRate: 1 }).lean()).map((i) => [String(i._id), i]));
  const rateOf = new Map(order.lines.map((l) => [l.lineId, Number(items.get(String(l.item))?.taxRate ?? 0)]));
  const live = (order.flipkart.items || []).filter((i) => i.status !== "CANCELLED");
  const subs = order.flipkart.subShipments?.length ? order.flipkart.subShipments : [{ id: "" }];
  const r = await call(acc, "POST", `${SH}/labels`, {
    body: {
      shipments: [
        {
          shipmentId: order.flipkart.shipmentId,
          locationId: locOf(acc, order),
          taxItems: live.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity, taxRate: rateOf.get(i.orderItemId) || 0 })),
          subShipments: subs.map((x) => ({ subShipmentId: x.id, dimensions: { length: Number(pkg.length), breadth: Number(pkg.breadth), height: Number(pkg.height), weight: Number(pkg.weight) } })),
          invoices: [...new Set(live.map((i) => i.orderId))].map((orderId) => ({ orderId, invoiceDate: new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10) })),
        },
      ],
    },
  });
  result(r, "pack the shipment");
  order.status = RANK[order.status] < RANK.packed ? "packed" : order.status;
  order.flipkart = { ...order.flipkart, packedAt: new Date(), pkg };
  order.markModified("flipkart");
  order.statusChangedAt = new Date();
  await order.save();
  return { ok: true };
}

// Flipkart's label + invoice PDF (ready a few seconds after Pack).
async function label(order) {
  const acc = await accountOf(order);
  const buf = await call(acc, "GET", `${SH}/${order.flipkart.shipmentId}/labels`, { binary: true });
  if (!buf.length || buf.slice(0, 4).toString() !== "%PDF") throw new Error("Flipkart's label isn't ready yet — try again in a minute");
  return buf;
}

async function readyToDispatch(order) {
  const acc = await accountOf(order);
  const r = await call(acc, "POST", `${SH}/dispatch`, { body: { shipmentIds: [order.flipkart.shipmentId], locationId: locOf(acc, order) } });
  result(r, "mark it Ready to Dispatch");
  if (RANK[order.status] < RANK.ready_to_ship) {
    order.status = "ready_to_ship";
    order.statusChangedAt = new Date();
  }
  order.flipkart = { ...order.flipkart, rtdAt: new Date() };
  order.markModified("flipkart");
  await order.save();
  return { ok: true };
}

// Flipkart's list of courier partners for self-ship ({name, code}).
async function selfShipVendors(acc) {
  let r;
  for (const p of ["/sellers/v3/shipments/selfShip/vendors", "/sellers/selfship/vendors", "/sellers/v3/selfship/vendors"]) {
    try {
      r = await call(acc, "GET", p);
      break;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const list = Array.isArray(r) ? r : r?.vendors || r?.selfShipVendors || [];
  return list.map((v) => ({ name: v.name || v.vendorName || "", code: v.vendorcode || v.vendorCode || v.code || "" })).filter((v) => v.code);
}

// Self-ship booked with our courier → tell Flipkart it's dispatched (courier, AWB, invoice date). Returns a warning or "".
async function afterSelfShipBooked(order) {
  try {
    const acc = await accountOf(order);
    const sh = order.shipment || {};
    const partner = (acc.selfShipPartners || {})[sh.carrier] || {};
    if (!partner.code) return `Booked. Tell Flipkart it's dispatched: set the Flipkart courier code for ${sh.courierName || sh.carrier} in Store → Flipkart, then use "Report dispatch to Flipkart" on the order`;
    const org = await require("../../models/Organization").findById(acc.organization).lean();
    const a = org?.address || {};
    const now = new Date();
    const r = await call(acc, "POST", `${SH}/selfShip/dispatch`, {
      body: {
        shipments: [
          {
            shipmentId: order.flipkart.shipmentId,
            dispatchDate: now.toISOString(),
            tentativeDeliveryDate: new Date(now.getTime() + 5 * 86400000).toISOString(),
            deliveryPartner: partner.name || sh.courierName || "",
            deliveryPartnerCode: partner.code,
            trackingId: sh.awb,
            invoice: { invoiceDate: now.toISOString(), items: (order.flipkart.items || []).filter((i) => i.status !== "CANCELLED").map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
            dispatchLocation: { locationId: locOf(acc, order), address: { address1: a.street || org?.name || "", city: a.city || "", state: a.state || "", pincode: a.pincode || "" } },
          },
        ],
      },
    });
    result(r, "accept the dispatch");
    order.flipkart = { ...order.flipkart, dispatchReportedAt: new Date(), dispatchError: "" };
    order.markModified("flipkart");
    await order.save();
    return "";
  } catch (e) {
    order.flipkart = { ...order.flipkart, dispatchError: e.message };
    order.markModified("flipkart");
    await order.save().catch(() => {});
    return `Booked, but Flipkart wasn't told: ${e.message}`;
  }
}

// Self-ship delivered (from our courier's tracking) → tell Flipkart.
async function reportDelivered(order) {
  if (order.channel !== "flipkart" || !order.flipkart?.selfShip || order.flipkart.deliveryReportedAt) return;
  const acc = await accountOf(order);
  const r = await call(acc, "POST", `${SH}/selfShip/delivery`, { body: { shipments: [{ shipmentId: order.flipkart.shipmentId, locationId: locOf(acc, order), deliveryDate: new Date((order.deliveredAt || new Date()).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) }] } });
  result(r, "accept the delivery");
  order.flipkart = { ...order.flipkart, deliveryReportedAt: new Date() };
  order.markModified("flipkart");
  await order.save();
}

module.exports = { normalise, upsert, syncAccount, autoSyncAll, storeOrgFor, pack, label, readyToDispatch, selfShipVendors, afterSelfShipBooked, reportDelivered, STATUS };
