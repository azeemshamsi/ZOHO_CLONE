/**
 * Reverse pickup: the courier collects a delivered order back from the customer (damaged, wrong item, a return
 * you approved) and brings it to you — or to the seller, for a seller's product.
 * Booking also marks the return created (and creates it in Shopify, as Mark Return Created does). When the
 * parcel is back, close the return as usual (Scan Returns takes the reverse AWB too): stock and credit note.
 * order.reverse = { account, carrier, courierName, awb, trackingUrl, refs, reason, note, returnTo, returnToName,
 *                   bookedAt, by, trackStatus, trackedAt, events, deliveredAt, cancelled: [] }
 */
const CourierAccount = require("../../models/CourierAccount");
const Organization = require("../../models/Organization");
const { CARRIERS, shipmentFrom, checkShipment } = require("../couriers");
const { resolvePackage } = require("./package");

const REASONS = ["Damaged in transit", "Wrong product sent", "Defective / not working", "Customer return (approved)", "Size / colour exchange", "Other"];
const NO_API = { shadowfax: "Shadowfax", custom: "" };

async function bookReverse(ctx, order, { accountId, reason = "", note = "", pkg = {}, returnTo = "", manual = {}, by = "" }) {
  const org = ctx.storeOrg || ctx.org;
  if (order.reverse?.awb && !order.reverse.deliveredAt) throw new Error(`A reverse pickup is already booked: ${order.reverse.courierName} ${order.reverse.awb}`);
  if (!["shipped", "delivered", "return_created"].includes(order.status)) throw new Error(`${order.name} is ${String(order.status).replace(/_/g, " ")}: a reverse pickup is for orders that reached the customer`);
  if (order.channel && order.channel !== "shopify") throw new Error("Amazon and Flipkart returns are picked up by the marketplace");
  const realAcc = await CourierAccount.findOne({ _id: accountId, organization: org, active: true });
  if (!realAcc) throw new Error("Choose a courier");
  // Back to where it was shipped from: the seller (their products) or you.
  const sellers = require("../sellers");
  const seller = returnTo === "own" ? null : await sellers.pickupFor(org, order, returnTo || "");
  if (seller) {
    const miss = sellers.pickupProblems(seller);
    if (miss.length) throw new Error(`${seller.name}'s address is missing ${miss.join(", ")} (Store → Sellers)`);
    if (["shiprocket", "delhivery"].includes(realAcc.carrier) && !(seller.couriers || {})[String(realAcc._id)]?.pickupLocation) await sellers.registerPickup(seller, realAcc);
  }
  const acc = sellers.withPickup(realAcc, seller);
  const Item = require("../../models/Item");
  const items = new Map((await Item.find({ _id: { $in: order.lines.map((l) => l.item).filter(Boolean) } }).lean()).map((i) => [String(i._id), i]));
  const p = await resolvePackage(order, pkg, org, items);
  if (!p) throw new Error("Its products have no package type — choose a package or enter the weight and size");
  const orgDoc = await Organization.findById(ctx.org);
  const s = shipmentFrom(order, orgDoc, p, items);
  checkShipment(s); // the customer's address: where it's picked up
  const n = (order.reverse?.cancelled || []).length;
  const rs = { ...s, from: s.consignee, reference: `${s.reference.replace(/-\d+$/, "")}-RT${n ? n + 1 : ""}`, cod: false, codAmount: 0, reverse: true };

  let out;
  if (manual.awb) out = { awb: String(manual.awb).trim(), courierName: manual.courierName || acc.name, trackingUrl: acc.trackingUrl ? acc.trackingUrl.replace("{awb}", String(manual.awb).trim()) : "", refs: {} };
  else {
    const c = CARRIERS[acc.carrier];
    if (!c?.reverse) throw new Error(`${acc.name}: reverse pickups can't be booked through ${NO_API[acc.carrier] || "this courier"}'s API. Book it on the courier's portal and enter the AWB here.`);
    out = await c.reverse(acc, rs);
  }
  order.reverse = {
    account: realAcc._id,
    carrier: acc.carrier,
    courierName: out.courierName,
    awb: out.awb,
    trackingUrl: out.trackingUrl || "",
    refs: out.refs || {},
    reason,
    note,
    returnTo: seller ? `seller:${seller._id}` : "own",
    returnToName: seller ? seller.name : "you",
    bookedAt: new Date(),
    by,
    reference: rs.reference,
    weight: rs.weight,
    cancelled: order.reverse?.cancelled || [],
  };
  // The return: created here and in Shopify (like Mark Return Created), unless it already is.
  let warning = out.refs?.pickupError ? `Pickup not registered: ${out.refs.pickupError}` : "";
  if (order.status !== "return_created") {
    const ShopifyStore = require("../../models/ShopifyStore");
    const store = await ShopifyStore.findOne({ organization: org });
    const r = await require("./returns").markReturnCreated(ctx, order, store, [reason, note].filter(Boolean).join(" — "));
    if (r.warning) warning = [warning, r.warning].filter(Boolean).join(" · ");
  }
  order.remarks = `${order.remarks ? `${order.remarks}\n` : ""}Reverse pickup ${out.courierName} ${out.awb} booked ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}${reason ? ` (${reason})` : ""}`;
  order.markModified("reverse");
  await order.save();
  return { reverse: order.reverse, warning };
}

async function cancelReverse(order, { force = false } = {}) {
  const rv = order.reverse;
  if (!rv?.awb) throw new Error("No reverse pickup to cancel");
  if (rv.deliveredAt || ["in_transit", "out_for_delivery", "delivered"].includes(rv.trackStatus)) throw new Error("The courier has already picked it up");
  const acc = rv.account ? await CourierAccount.findById(rv.account) : null;
  let note = "";
  if (acc && rv.trackStatus !== "cancelled") {
    try {
      await CARRIERS[acc.carrier].cancel(acc, rv);
    } catch (e) {
      if (!force) {
        const err = new Error(`${acc.name} didn't cancel ${rv.awb}: ${e.message}`);
        err.courierRefused = true;
        throw err;
      }
      note = ` — not cancelled with ${rv.courierName} (${e.message.slice(0, 100)}), cancel it there`;
    }
  }
  order.reverse = { cancelled: [...(rv.cancelled || []), { awb: rv.awb, courier: rv.courierName, at: new Date() }] };
  order.remarks = `${order.remarks ? `${order.remarks}\n` : ""}Reverse pickup ${rv.courierName} ${rv.awb} cancelled ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}${note}`;
  order.markModified("reverse");
  await order.save();
  return { note };
}

async function trackReverse(order) {
  const rv = order.reverse;
  if (!rv?.awb || !rv.account || rv.deliveredAt) return null;
  const acc = await CourierAccount.findById(rv.account);
  if (!acc || acc.carrier === "custom") return null;
  const t = await CARRIERS[acc.carrier].track(acc, rv);
  rv.trackStatus = t.status;
  rv.trackText = t.text || "";
  rv.trackedAt = new Date();
  if (t.events?.length) rv.events = t.events.filter((e) => e.at && !isNaN(e.at)).slice(0, 50);
  if (t.status === "delivered") rv.deliveredAt = new Date(); // back with you / the seller: close the return
  order.markModified("reverse");
  await order.save();
  return t;
}

// Every couple of hours with the other tracking: reverse pickups on the way.
async function trackAllReverse() {
  const ShopifyOrder = require("../../models/ShopifyOrder");
  const since = new Date(Date.now() - 45 * 86400000);
  const list = await ShopifyOrder.find({ status: "return_created", "reverse.awb": { $exists: true }, "reverse.bookedAt": { $gte: since } }).limit(1000);
  for (const o of list) if (o.reverse?.awb && !o.reverse.deliveredAt) await trackReverse(o).catch(() => {});
}

module.exports = { REASONS, bookReverse, cancelReverse, trackReverse, trackAllReverse };
