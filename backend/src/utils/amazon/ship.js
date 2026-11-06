/**
 * Shipping Amazon orders.
 * Self-ship: booked with our own couriers (utils/shopify/ship.js), then the tracking number is confirmed to
 *   Amazon (Orders v0 confirmShipment).
 * Easy Ship: Amazon picks the parcel up. Handover slots → schedule the package → Amazon's label (and invoice)
 *   via the POST_EASYSHIP_DOCUMENTS feed → the label PDF from the Reports API.
 */
const AmazonAccount = require("../../models/AmazonAccount");
const ShopifyOrder = require("../../models/ShopifyOrder");
const { call, download, upload } = require("./client");

const ES = "/easyShip/2022-03-23";

async function accountOf(order) {
  const acc = order.amazon?.account ? await AmazonAccount.findById(order.amazon.account) : null;
  if (!acc) throw new Error("This order's Amazon account isn't connected any more");
  return acc;
}

// Amazon's carrier codes for India; anything else goes as "Other" with the courier's name.
const CARRIER_CODES = [
  [/blue ?dart/i, "Blue Dart"],
  [/delhivery/i, "Delhivery"],
  [/dtdc/i, "DTDC"],
  [/ecom ?express/i, "Ecom Express"],
  [/xpress ?bees/i, "Xpressbees"],
  [/shadowfax/i, "Shadowfax"],
  [/ekart/i, "Ekart"],
  [/india ?post|speed ?post/i, "India Post"],
  [/gati/i, "Gati"],
];
function carrierOf(sh) {
  const text = `${sh.courierName || ""} ${sh.carrier || ""}`;
  const hit = CARRIER_CODES.find(([rx]) => rx.test(text));
  return hit ? { carrierCode: hit[1] } : { carrierCode: "Other", carrierName: sh.courierName || sh.carrier || "Courier" };
}

// Tell Amazon the order has shipped, with the courier and AWB (so the buyer can track it).
async function confirmShipment(order, { acc } = {}) {
  acc = acc || (await accountOf(order));
  const sh = order.shipment || {};
  if (!sh.awb) throw new Error("Book a courier first");
  const items = (order.amazon?.items || []).filter((i) => i.orderItemId && i.quantity > 0);
  if (!items.length) throw new Error("No Amazon order items on this order");
  await call(acc, "POST", `/orders/v0/orders/${encodeURIComponent(order.amazon.orderId)}/shipmentConfirmation`, {
    body: {
      marketplaceId: order.amazon.marketplaceId || acc.marketplaceId,
      packageDetail: {
        packageReferenceId: "1",
        ...carrierOf(sh),
        shippingMethod: sh.courierName || "Standard",
        trackingNumber: sh.awb,
        shipDate: new Date().toISOString(),
        orderItems: items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      },
    },
  });
  order.amazon = { ...order.amazon, confirmedAt: new Date(), confirmError: "", confirmedAwb: sh.awb };
  order.markModified("amazon");
  await order.save();
}

// After a self-ship booking: confirm to Amazon and (if OrdexaGo invoices Amazon orders) invoice it.
async function afterBooked(order) {
  const warnings = [];
  const acc = await accountOf(order);
  try {
    await confirmShipment(order, { acc });
  } catch (e) {
    order.amazon = { ...order.amazon, confirmError: e.message };
    order.markModified("amazon");
    await order.save().catch(() => {});
    warnings.push(`Booked, but Amazon wasn't told the tracking number: ${e.message}. Use "Confirm on Amazon" to try again.`);
  }
  const { shouldInvoice } = require("./orders");
  if (shouldInvoice(acc, order))
    await require("./invoice")
      .invoiceAmazonOrder(order, acc)
      .catch((e) => warnings.push(`Couldn't invoice it: ${e.message}`));
  return warnings.join(" ");
}

/* ---------------- Easy Ship ---------------- */
const dims = (p) => ({ length: Math.max(1, Number(p.length) || 1), width: Math.max(1, Number(p.breadth || p.width) || 1), height: Math.max(1, Number(p.height) || 1), unit: "cm" });
const grams = (p) => ({ value: Math.max(11, Math.round((Number(p.weight) || 0.1) * 1000)), unit: "grams" });

function needEasyShip(order) {
  if (order.channel !== "amazon" || !order.amazon?.easyShip) throw new Error("Not an Amazon Easy Ship order");
  if (order.status === "cancelled") throw new Error("Order is cancelled");
}

async function handoverSlots(order, pkg) {
  needEasyShip(order);
  const acc = await accountOf(order);
  const r = await call(acc, "POST", `${ES}/timeSlot`, { body: { marketplaceId: order.amazon.marketplaceId || acc.marketplaceId, amazonOrderId: order.amazon.orderId, packageDimensions: dims(pkg), packageWeight: grams(pkg) } });
  return (r.timeSlots || []).map((s) => ({ slotId: s.slotId, start: s.startTime, end: s.endTime, method: s.handoverMethod || "PICKUP" }));
}

const ES_STATUS = { ReadyForPickup: "ready_to_ship", PickedUp: "shipped", AtOriginFC: "shipped", AtDestinationFC: "shipped", OutForDelivery: "shipped", Delivered: "delivered", Rejected: "rto", Undeliverable: "rto", ReturnedToSeller: "rto" };
const TRACK_OF = { ReadyForPickup: "pending", PickedUp: "in_transit", AtOriginFC: "in_transit", AtDestinationFC: "in_transit", OutForDelivery: "out_for_delivery", Delivered: "delivered", Rejected: "rto", Undeliverable: "rto", ReturnedToSeller: "rto", LostInTransit: "lost", DamagedInTransit: "damaged" };

function applyPackage(order, p) {
  const sh = order.shipment || {};
  order.shipment = {
    ...(sh.toObject ? sh.toObject() : sh),
    carrier: "amazon_easyship",
    courierName: "Amazon Easy Ship",
    awb: p.trackingDetails?.trackingId || sh.awb || "",
    refs: { ...(sh.refs || {}), scheduledPackageId: p.scheduledPackageId || null },
    weight: p.packageWeight?.value ? p.packageWeight.value / 1000 : sh.weight,
    length: p.packageDimensions?.length ?? sh.length,
    breadth: p.packageDimensions?.width ?? sh.breadth,
    height: p.packageDimensions?.height ?? sh.height,
    trackStatus: TRACK_OF[p.packageStatus] || sh.trackStatus || "pending",
    trackedAt: new Date(),
    bookedAt: sh.bookedAt || new Date(),
    events: sh.events || [],
  };
  order.amazon = { ...order.amazon, packageStatus: p.packageStatus || "", ...(p.packageTimeSlot ? { slot: { slotId: p.packageTimeSlot.slotId, start: p.packageTimeSlot.startTime, end: p.packageTimeSlot.endTime, method: p.packageTimeSlot.handoverMethod || "PICKUP" } } : {}), ...(p.invoice?.invoiceNumber ? { amazonInvoice: p.invoice.invoiceNumber } : {}) };
  order.markModified("amazon");
  order.markModified("shipment");
  const next = ES_STATUS[p.packageStatus];
  if (p.packageStatus === "LabelCanceled") {
    order.shipment = {};
    if (order.status === "ready_to_ship") order.status = "packed";
  } else if (next && next !== order.status && !["delivered", "rto", "cancelled", "returned", "return_created"].includes(order.status) && !(next === "ready_to_ship" && order.status === "shipped")) {
    order.status = next;
    order.statusChangedAt = new Date();
  }
}

// Schedule the pickup in the chosen slot; Amazon makes the label (fetched next) and the order is ready to ship.
async function schedule(order, { slotId, pkg = {} }) {
  needEasyShip(order);
  if (order.amazon.scheduledAt && order.shipment?.carrier === "amazon_easyship") throw new Error("Already scheduled — reschedule it in Seller Central");
  const acc = await accountOf(order);
  const p = await call(acc, "POST", `${ES}/package`, {
    body: { amazonOrderId: order.amazon.orderId, marketplaceId: order.amazon.marketplaceId || acc.marketplaceId, packageDetails: { packageTimeSlot: { slotId }, packageItems: (order.amazon.items || []).map((i) => ({ orderItemId: i.orderItemId })) } },
  });
  applyPackage(order, { packageDimensions: dims(pkg), packageWeight: grams(pkg), ...p });
  order.amazon = { ...order.amazon, scheduledAt: new Date() };
  if (["new", "packed"].includes(order.status)) {
    order.status = "ready_to_ship";
    order.statusChangedAt = new Date();
  }
  await order.save();
  const warnings = [];
  await requestLabel(order, acc).catch((e) => warnings.push(`Scheduled, but the label wasn't requested: ${e.message}`));
  const { shouldInvoice } = require("./orders");
  if (shouldInvoice(acc, order))
    await require("./invoice")
      .invoiceAmazonOrder(order, acc)
      .catch((e) => warnings.push(`Couldn't invoice it: ${e.message}`));
  return { awb: order.shipment.awb, slot: order.amazon.slot, warning: warnings.join(" ") };
}

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const labelXml = (sellerId, orderId) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">\n  <Header>\n    <DocumentVersion>1.01</DocumentVersion>\n    <MerchantIdentifier>${xmlEsc(sellerId)}</MerchantIdentifier>\n  </Header>\n  <MessageType>EasyShipDocument</MessageType>\n  <Message>\n    <MessageID>1</MessageID>\n    <EasyShipDocument>\n      <AmazonOrderID>${xmlEsc(orderId)}</AmazonOrderID>\n      <DocumentType>ShippingLabel</DocumentType>\n    </EasyShipDocument>\n  </Message>\n</AmazonEnvelope>`;

// Ask Amazon for the shipping label (a feed); Amazon prepares it in the background.
async function requestLabel(order, acc) {
  acc = acc || (await accountOf(order));
  if (!acc.sellerId) throw new Error("Add your Amazon Seller ID (Merchant Token) in Amazon settings to get Easy Ship labels");
  const ct = "text/xml; charset=UTF-8";
  const doc = await call(acc, "POST", "/feeds/2021-06-30/documents", { body: { contentType: ct } });
  await upload(doc.url, labelXml(acc.sellerId, order.amazon.orderId), ct);
  const f = await call(acc, "POST", "/feeds/2021-06-30/feeds", { body: { feedType: "POST_EASYSHIP_DOCUMENTS", marketplaceIds: [order.amazon.marketplaceId || acc.marketplaceId], inputFeedDocumentId: doc.feedDocumentId, feedOptions: { AmazonOrderId: order.amazon.orderId, DocumentType: "ShippingLabel" } } });
  order.amazon = { ...order.amazon, label: { feedId: f.feedId, state: "requested", error: "", at: new Date() } };
  order.markModified("amazon");
  await order.save();
  return f.feedId;
}

/**
 * Fetch the label once Amazon has made it: feed result → DocumentReportReferenceID → report document (PDF).
 * Returns { state: "ready" | "pending" | "error", message }.
 */
async function fetchLabel(order) {
  const acc = await accountOf(order);
  let feedId = order.amazon?.label?.feedId;
  if (!feedId) feedId = await requestLabel(order, acc);
  const feed = await call(acc, "GET", `/feeds/2021-06-30/feeds/${encodeURIComponent(feedId)}`);
  if (["IN_QUEUE", "IN_PROGRESS"].includes(feed.processingStatus)) return { state: "pending", message: "Amazon is still preparing the label — try again in a minute" };
  if (!feed.resultFeedDocumentId) {
    const msg = `Amazon couldn't make the label (${feed.processingStatus || "no result"})`;
    order.amazon = { ...order.amazon, label: { ...order.amazon.label, state: "error", error: msg } };
    order.markModified("amazon");
    await order.save();
    return { state: "error", message: msg };
  }
  const rd = await call(acc, "GET", `/feeds/2021-06-30/documents/${encodeURIComponent(feed.resultFeedDocumentId)}`);
  const xml = (await download(rd.url, rd.compressionAlgorithm)).toString("utf8");
  const ref = (xml.match(/<DocumentReportReferenceID>\s*([^<\s]+)\s*<\/DocumentReportReferenceID>/) || [])[1];
  if (!ref) {
    const err = (xml.match(/<ResultDescription>([\s\S]*?)<\/ResultDescription>/) || [])[1] || "no document reference in Amazon's reply";
    const msg = `Amazon couldn't make the label: ${err.trim().slice(0, 300)}`;
    order.amazon = { ...order.amazon, label: { ...order.amazon.label, state: "error", error: msg } };
    order.markModified("amazon");
    await order.save();
    return { state: "error", message: msg };
  }
  const doc = await call(acc, "GET", `/reports/2021-06-30/documents/${encodeURIComponent(ref)}`);
  const pdf = await download(doc.url, doc.compressionAlgorithm);
  // Tracking number and status as Amazon has them now.
  await refreshPackage(order, acc).catch(() => {});
  order.shipment.labelPdf = pdf;
  order.amazon = { ...order.amazon, label: { ...order.amazon.label, state: "ready", error: "", ref, at: new Date() } };
  order.markModified("amazon");
  order.markModified("shipment");
  await order.save();
  return { state: "ready" };
}

async function refreshPackage(order, acc) {
  acc = acc || (await accountOf(order));
  const p = await call(acc, "GET", `${ES}/package`, { query: { amazonOrderId: order.amazon.orderId, marketplaceId: order.amazon.marketplaceId || acc.marketplaceId } });
  applyPackage(order, p);
  return p;
}

// Easy Ship tracking (every couple of hours, with the courier tracking).
async function trackEasyShip(order) {
  await refreshPackage(order);
  await order.save();
  return { status: order.shipment?.trackStatus || "", text: order.amazon?.packageStatus || "" };
}

async function trackAllEasyShip() {
  const since = new Date(Date.now() - 45 * 86400000);
  const orders = await ShopifyOrder.find({ channel: "amazon", status: { $in: ["ready_to_ship", "shipped"] }, "shipment.carrier": "amazon_easyship", "shipment.bookedAt": { $gte: since } }).limit(2000);
  for (const o of orders) await trackEasyShip(o).catch(() => {});
}

module.exports = { confirmShipment, afterBooked, handoverSlots, schedule, requestLabel, fetchLabel, trackEasyShip, trackAllEasyShip, carrierOf, labelXml };
