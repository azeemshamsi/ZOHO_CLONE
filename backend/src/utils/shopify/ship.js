// Book, track and cancel shipments for Shopify orders; optionally mark them fulfilled in Shopify.
const ShopifyOrder = require("../../models/ShopifyOrder");
const ShopifyStore = require("../../models/ShopifyStore");
const CourierAccount = require("../../models/CourierAccount");
const Organization = require("../../models/Organization");
const { CARRIERS, shipmentFrom, checkShipment } = require("../couriers");
const { gql } = require("./client");
const { resolvePackage } = require("./package");
const { quoteAccount } = require("../couriers/rates");

const STATUS_FROM_TRACK = { delivered: "delivered", rto: "rto", in_transit: "shipped", out_for_delivery: "shipped" };

async function fulfillInShopify(store, order, sh) {
  const data = await gql(store, `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: order.shopifyId });
  const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status));
  if (!open.length) return false;
  const res = await gql(
    store,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
    { f: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: store.notifyCustomer !== false, trackingInfo: { company: sh.courierName, number: sh.awb, ...(sh.trackingUrl ? { url: sh.trackingUrl } : {}) } } }
  );
  const errs = res.fulfillmentCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return true;
}

async function bookOrder(ctx, order, { accountId, pkg = {}, manual = {}, skipCheck = false }) {
  if (order.status === "cancelled") throw new Error("Order is cancelled");
  if (order.shipment?.awb && order.status !== "new" && order.status !== "packed") throw new Error(`Already booked: ${order.shipment.courierName} ${order.shipment.awb}`);
  const acc = await CourierAccount.findOne({ _id: accountId, organization: ctx.storeOrg || ctx.org, active: true });
  if (!acc) throw new Error("Choose a courier");
  const store = await ShopifyStore.findOne({ organization: ctx.storeOrg || ctx.org });
  const org = await Organization.findById(ctx.org);
  // HSN and GST from the (checked) OrdexaGo items, not Shopify's.
  const Item = require("../../models/Item");
  const items = new Map((await Item.find({ _id: { $in: order.lines.map((l) => l.item).filter(Boolean) } }).lean()).map((i) => [String(i._id), i]));
  // Package: chosen / typed in, else from the products' package types.
  const p = await resolvePackage(order, pkg, ctx.storeOrg || ctx.org, items);
  if (!p) throw new Error("Its products have no package type — choose a package or enter the weight and size");
  const s = shipmentFrom(order, org, p, items);
  if (acc.carrier !== "custom") checkShipment(s);
  if (s.cod && acc.options?.codEnabled === false) throw new Error(`${acc.name} isn't set up for COD; choose another courier for this ₹${s.codAmount} COD order`);
  // Live pincode check: book only where the courier delivers.
  const q = await quoteAccount(acc, s);
  let charge = q.charge;
  let chargeSource = q.source;
  if (manual.courierId && q.options) {
    const opt = q.options.find((o) => o.courierId === String(manual.courierId));
    if (!opt && !skipCheck) throw new Error(`${acc.name}: that courier no longer serves ${s.consignee.pincode}; check the rates again`);
    if (opt) [charge, chargeSource] = [opt.charge, "api"];
  } else if (q.serviceable === false && !skipCheck) throw new Error(`Not serviceable: ${q.note || `${acc.name} doesn't deliver to ${s.consignee.pincode}`}. Choose another courier.`);
  const out = await CARRIERS[acc.carrier].book(acc, s, manual);
  order.shipment = {
    account: acc._id,
    carrier: acc.carrier,
    courierName: out.courierName,
    awb: out.awb,
    labelUrl: out.labelUrl || "",
    trackingUrl: out.trackingUrl || (acc.trackingUrl ? acc.trackingUrl.replace("{awb}", out.awb) : ""),
    refs: out.refs || {},
    weight: s.weight,
    length: s.length,
    breadth: s.breadth,
    height: s.height,
    packageName: p.packageName || "",
    charge: charge ?? undefined,
    chargeSource: charge != null ? chargeSource : "",
    bookedAt: new Date(),
    trackStatus: "pending",
    events: [],
  };
  if (out.labelPdf) order.shipment.labelPdf = out.labelPdf;
  order.status = "ready_to_ship";
  order.statusChangedAt = new Date();
  let warning = "";
  if (store?.fulfillInShopify) {
    try {
      order.shipment.shopifyFulfilled = await fulfillInShopify(store, order, order.shipment);
    } catch (e) {
      warning = `Booked, but couldn't mark it fulfilled in Shopify: ${e.message}`;
      order.shipment.error = warning;
    }
  }
  await order.save();
  return { awb: out.awb, courierName: out.courierName, charge: charge ?? null, warning };
}


async function trackOrder(order) {
  const sh = order.shipment;
  if (!sh?.awb || !sh.account) return null;
  const acc = await CourierAccount.findById(sh.account);
  if (!acc) return null;
  const t = await CARRIERS[acc.carrier].track(acc, sh);
  sh.trackStatus = t.status;
  sh.trackedAt = new Date();
  if (t.events?.length) sh.events = t.events.filter((e) => e.at && !isNaN(e.at)).slice(0, 50);
  const next = STATUS_FROM_TRACK[t.status];
  if (t.status === "cancelled" && order.status === "ready_to_ship") {
    // Courier cancelled the AWB: back to packed so it can be re-booked.
    order.status = "packed";
    order.statusChangedAt = new Date();
  } else if (next && next !== order.status && !["delivered", "rto", "cancelled"].includes(order.status)) {
    order.status = next;
    order.statusChangedAt = new Date();
  } else if (next === "rto" && order.status === "delivered") {
    order.status = "rto";
  }
  order.markModified("shipment");
  await order.save();
  return t;
}

async function cancelShipment(order) {
  const sh = order.shipment;
  if (!sh?.awb) throw new Error("No shipment to cancel");
  if (["shipped", "delivered", "rto"].includes(order.status)) throw new Error("The shipment has already left; raise it with the courier");
  const acc = sh.account ? await CourierAccount.findById(sh.account) : null;
  const was = `${sh.courierName || ""} ${sh.awb}`.trim();
  if (acc) await CARRIERS[acc.carrier].cancel(acc, sh);
  order.shipment = {};
  order.remarks = `${order.remarks ? `${order.remarks}\n` : ""}Shipment ${was} cancelled on ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  order.status = "packed";
  order.statusChangedAt = new Date();
  await order.save();
}

// Every couple of hours: shipments that are on the way, booked in the last 45 days.
async function trackAll() {
  const since = new Date(Date.now() - 45 * 86400000);
  const orders = await ShopifyOrder.find({ status: { $in: ["ready_to_ship", "shipped"] }, "shipment.awb": { $ne: "" }, "shipment.account": { $exists: true }, "shipment.bookedAt": { $gte: since } }).limit(2000);
  for (const o of orders) await trackOrder(o).catch(() => {});
}

module.exports = { bookOrder, trackOrder, cancelShipment, trackAll, fulfillInShopify };
