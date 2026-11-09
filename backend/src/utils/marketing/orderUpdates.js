/**
 * WhatsApp order updates (Marketing → Automations): on a store order's status change, send the company's
 * approved template for that event. Skipped when there's no phone, the number opted out, or the event was
 * already sent for the order. COD confirmation templates carry Confirm / Cancel quick-reply buttons; the
 * buyer's answer is noted on the order (a cancel request only flags it for staff — never auto-cancelled).
 */
const ShopifyOrder = require("../../models/ShopifyOrder");
const OrderMessage = require("../../models/OrderMessage");
const WaTemplate = require("../../models/WaTemplate");
const MarketingConfig = require("../../models/MarketingConfig");
const { integrationOf, canWhatsApp } = require("./integration");

// Settings without creating them (most companies never set up order updates).
const peekConfig = (org) => MarketingConfig.findOne({ organization: org });
const { toWa } = require("./phone");

const EVENTS = { order_placed: "Order placed / confirmed", cod_confirmation: "COD confirmation request", shipped: "Shipped", out_for_delivery: "Out for delivery", delivered: "Delivered", rto: "RTO initiated" };
const VARS = { customer_name: "Customer name", order_no: "Order number", amount: "Order amount", courier: "Courier", awb: "AWB number", tracking_url: "Tracking link", payment_mode: "Payment mode", cod_amount: "COD amount to pay", store_name: "Company name" };
const RECENT_DAYS = 30;

const inr = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
function varsOf(o, orgName = "") {
  const sh = o.shipment || {};
  return {
    customer_name: (o.customer?.name || o.shippingAddress?.name || "Customer").split(/\s+/)[0] || "Customer",
    order_no: o.name || String(o.orderNumber || ""),
    amount: inr(o.total),
    courier: sh.courierName || "our courier",
    awb: sh.awb || "-",
    tracking_url: sh.trackingUrl || "",
    payment_mode: o.paymentMode === "cod" ? "Cash on Delivery" : o.paymentMode === "partial" ? "Part paid, rest on delivery" : "Prepaid",
    cod_amount: inr(o.codAmount),
    store_name: orgName,
  };
}

// Which events a change triggers (before checking settings).
function eventsFor(change, o, { shippedOn = "picked", now = Date.now() } = {}) {
  if (!o || o.channel === "amazon") return [];
  const age = now - new Date(o.orderDate || o.createdAt || now).getTime();
  if (age > RECENT_DAYS * 86400000) return [];
  const out = [];
  if (change.isNew) {
    // Only orders placed in the last 2 days (the first sync of a store brings in weeks of old orders).
    if (o.status === "new" && age <= 2 * 86400000) {
      out.push("order_placed");
      if (o.paymentMode === "cod") out.push("cod_confirmation");
    }
    return out;
  }
  const { prevStatus, status, prevTrack, track } = change;
  if (prevStatus !== status) {
    if (status === "ready_to_ship" && o.shipment?.awb && shippedOn === "booked") out.push("shipped");
    if (status === "shipped" && (shippedOn === "picked" || !["ready_to_ship"].includes(prevStatus))) out.push("shipped");
    if (status === "delivered") out.push("delivered");
    if (status === "rto") out.push("rto");
  }
  if (prevTrack !== track && track === "out_for_delivery" && !["delivered", "rto", "cancelled"].includes(status)) out.push("out_for_delivery");
  return out;
}

// The company that sends for this order: the store's company, else a company it's shared with, that has
// WhatsApp connected and this event switched on.
async function senderFor(o, event) {
  const ShopifyStore = require("../../models/ShopifyStore");
  const store = await ShopifyStore.findOne({ organization: o.organization }, { sharedWith: 1 }).lean();
  for (const org of [o.organization, ...(store?.sharedWith || [])]) {
    const cfg = await peekConfig(org);
    const ev = cfg?.orderUpdates?.[event];
    if (!ev?.enabled || !ev.template) continue;
    const i = await integrationOf(org);
    if (!canWhatsApp(i)) continue;
    return { org, cfg, ev, i };
  }
  return null;
}

async function quickReplyIndexes(org, name, language) {
  const t = await WaTemplate.findOne({ organization: org, name, language }).lean();
  const idx = [];
  (t?.buttons || []).forEach((b, n) => b.type === "QUICK_REPLY" && idx.push(n));
  const urlIdx = (t?.buttons || []).findIndex((b) => b.type === "URL");
  return { idx: idx.length ? idx : [0, 1], urlIdx: urlIdx >= 0 ? urlIdx : 0 };
}

async function dispatch(o, event, { force = false } = {}) {
  const s = await senderFor(o, event);
  if (!s) return { skipped: "not set up" };
  const { org, ev, i } = s;
  const log = (fields) => OrderMessage.create({ organization: org, order: o._id, orderName: o.name, event, template: ev.template, ...fields });
  const prior = (await OrderMessage.find({ order: o._id, event }, { status: 1 }).lean()).filter((x) => x.status !== "failed" && x.status !== "skipped");
  if (prior.length && !force) return { skipped: "already sent" };
  const to = toWa(o.customer?.phone) || toWa(o.shippingAddress?.phone);
  if (!to) return (await log({ status: "skipped", error: "No phone number on the order" }), { skipped: "no phone" });
  const { isOptedOut } = require("./optout");
  if (await isOptedOut(org, "whatsapp", to)) return (await log({ to, status: "skipped", error: "Opted out (STOP)" }), { skipped: "opted out" });
  const Organization = require("../../models/Organization");
  const orgName = (await Organization.findById(org, { name: 1 }).lean())?.name || "";
  const v = varsOf(o, orgName);
  const tpl = { name: ev.template, language: ev.language || "en", body: (ev.params || []).map((k) => v[k] ?? ""), header: ev.headerParam ? v[ev.headerParam] || "" : undefined };
  const { idx, urlIdx } = await quickReplyIndexes(org, ev.template, ev.language || "en");
  if (event === "cod_confirmation") {
    tpl.quickReplies = [`COD_CONFIRM:${o._id}`, `COD_CANCEL:${o._id}`];
    tpl.quickReplyIndex = idx;
  }
  if (ev.urlButtonParam && v[ev.urlButtonParam]) {
    tpl.urlButton = v[ev.urlButtonParam];
    tpl.urlButtonIndex = urlIdx;
  }
  const wa = require("./whatsapp");
  const text = `${EVENTS[event]} — ${tpl.name} (${tpl.body.join(" · ")})`;
  try {
    const id = await wa.sendTemplate(i, to, tpl);
    await log({ to, status: "sent", externalId: id });
    await require("./inbox").recordOutgoing(org, to, { name: o.customer?.name || "", text, template: { name: tpl.name, language: tpl.language }, externalId: id, auto: "order_update" }).catch(() => {});
    return { sent: id };
  } catch (e) {
    await log({ to, status: "failed", error: e.message });
    return { failed: e.message };
  }
}

async function onChange(doc, change) {
  // Cheap check first: most saves trigger nothing.
  if (!eventsFor(change, doc, { shippedOn: "booked" }).length && !eventsFor(change, doc, { shippedOn: "picked" }).length) return;
  // "Shipped" timing: the store company's setting.
  const cfg = await peekConfig(doc.organization);
  for (const event of eventsFor(change, doc, { shippedOn: cfg?.shippedOn || "picked" })) await dispatch(doc, event).catch((e) => console.error(`[order updates] ${doc.name} ${event}: ${e.message}`));
}

let started = false;
function start() {
  if (started) return;
  started = true;
  require("./orderEvents").bus.on("change", onChange);
}

/* ---------- COD Confirm / Cancel buttons ---------- */
function parseCodPayload(p) {
  const m = /^COD_(CONFIRM|CANCEL):([a-f0-9]{24})$/i.exec(String(p || ""));
  return m ? { action: m[1].toUpperCase() === "CONFIRM" ? "confirmed" : "cancel_requested", orderId: m[2] } : null;
}

async function handleButton(org, conv, msg, ev) {
  let p = parseCodPayload(ev.button?.payload);
  if (!p && ev.replyTo) {
    // Template sent without payloads: the buyer tapped "Confirm" / "Cancel" on our COD message.
    const om = await OrderMessage.findOne({ externalId: ev.replyTo, event: "cod_confirmation" }).lean();
    if (om && String(om.organization) === String(org)) {
      const t = String(ev.button?.text || ev.button?.payload || "").toLowerCase();
      if (/confirm|yes|ok/.test(t)) p = { action: "confirmed", orderId: String(om.order) };
      else if (/cancel|no/.test(t)) p = { action: "cancel_requested", orderId: String(om.order) };
    }
  }
  if (!p) return false;
  const o = await ShopifyOrder.findById(p.orderId);
  if (!o) return false;
  const { storeOrgFor } = require("./match");
  if (String(o.organization) !== String(await storeOrgFor(org)) && String(o.organization) !== String(org)) return false;
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const note = p.action === "confirmed" ? `COD confirmed by the buyer on WhatsApp (${when})` : `Buyer asked to CANCEL this COD order on WhatsApp (${when}) — check and cancel in Shopify if right`;
  o.codConfirm = { state: p.action, at: new Date(), via: "whatsapp" };
  if (!String(o.remarks || "").includes(note)) o.remarks = `${o.remarks ? `${o.remarks}\n` : ""}${note}`;
  await o.save();
  require("../shopify/orderIndex").forget(o.organization);
  await OrderMessage.updateMany({ order: o._id, event: "cod_confirmation" }, { $set: { status: "replied", reply: p.action } });
  const Conversation = require("../../models/Conversation");
  const tag = p.action === "confirmed" ? "COD confirmed" : "COD cancel request";
  await Conversation.updateOne({ _id: conv._id }, { $addToSet: { tags: tag }, ...(p.action === "cancel_requested" ? { $set: { status: "open" } } : {}) });
  const reply = p.action === "confirmed" ? `Thank you! Your order ${o.name} is confirmed and will be shipped soon.` : `Got it — we've noted your request to cancel order ${o.name}. Our team will confirm shortly.`;
  await require("./inbox").sendReply(org, conv, { text: reply, auto: "order_update", byName: "Auto-reply" }).catch(() => {});
  return true;
}

module.exports = { EVENTS, VARS, varsOf, eventsFor, dispatch, onChange, start, handleButton, parseCodPayload, senderFor };
