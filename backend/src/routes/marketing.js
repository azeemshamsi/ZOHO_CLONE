/**
 * Marketing (module "marketing"): WhatsApp order-update automations and templates, broadcast campaigns,
 * audiences, auto-reply rules, quick replies, the opt-out list. The order screen reads an order's WhatsApp log
 * here too (store order roles may read it).
 */
const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const { ah, validate, HttpError } = require("../utils/http");
const { integrationOf, configOf, canWhatsApp } = require("../utils/marketing/integration");
const MarketingConfig = require("../models/MarketingConfig");
const WaTemplate = require("../models/WaTemplate");
const Campaign = require("../models/Campaign");
const CampaignRecipient = require("../models/CampaignRecipient");
const AutoReplyRule = require("../models/AutoReplyRule");
const QuickReply = require("../models/QuickReply");
const OptOut = require("../models/OptOut");
const OrderMessage = require("../models/OrderMessage");
const ShopifyOrder = require("../models/ShopifyOrder");
const audit = require("../utils/audit");
const orderUpdates = require("../utils/marketing/orderUpdates");

// Which permission a request needs.
const moduleOf = (req) => {
  if (req.method === "GET" && /^\/order-log\//.test(req.path)) return ["marketing", "store_orders", "store_shipping", "inbox"];
  if (/^\/order-log\/[^/]+\/resend$/.test(req.path)) return ["marketing", "store_orders"];
  if (req.method === "GET" && /^\/(quick-replies|templates)$/.test(req.path)) return ["marketing", "inbox"];
  return "marketing";
};

const idOk = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "Not found");
  return id;
};

/* ---------- settings ---------- */
router.get(
  "/config",
  ah(async (req, res) => {
    const cfg = await configOf(req.org);
    res.send({ ...cfg.toObject(), events: orderUpdates.EVENTS, vars: orderUpdates.VARS });
  })
);

const evJoi = Joi.object({ enabled: Joi.boolean(), template: Joi.string().allow("").max(512), language: Joi.string().allow("").max(20), params: Joi.array().items(Joi.string().valid(...Object.keys(orderUpdates.VARS))).max(10), headerParam: Joi.string().allow("").valid("", ...Object.keys(orderUpdates.VARS)), urlButtonParam: Joi.string().allow("").valid("", ...Object.keys(orderUpdates.VARS)) });
router.put(
  "/config",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        orderUpdates: Joi.object(Object.fromEntries(Object.keys(orderUpdates.EVENTS).map((e) => [e, evJoi]))),
        shippedOn: Joi.string().valid("booked", "picked"),
        businessHours: Joi.object({ enabled: Joi.boolean(), days: Joi.array().items(Joi.object({ day: Joi.number().integer().min(0).max(6).required(), open: Joi.string().pattern(/^\d{2}:\d{2}$/).required(), close: Joi.string().pattern(/^\d{2}:\d{2}$/).required() })).max(14) }),
        away: Joi.object({ enabled: Joi.boolean(), text: Joi.string().allow("").max(1000), channels: Joi.array().items(Joi.string()) }),
        orderStatusReply: Joi.object({ enabled: Joi.boolean(), channels: Joi.array().items(Joi.string()) }),
        ai: Joi.object({ enabled: Joi.boolean(), autoDraft: Joi.boolean(), autoSend: Joi.array().items(Joi.string().valid("whatsapp", "messenger", "instagram", "fb_comment", "ig_comment", "email")), instructions: Joi.string().allow("").max(2000) }),
        stopKeywords: Joi.array().items(Joi.string().trim().max(30)).max(10),
        retention: Joi.object({ messagesDays: Joi.number().integer().min(30).max(3650), mediaDays: Joi.number().integer().min(7).max(3650) }),
        campaignRatePerMinute: Joi.number().integer().min(1).max(1000),
      }),
      req.body
    );
    const cfg = await configOf(req.org);
    for (const [k, v] of Object.entries(d)) {
      if (k === "orderUpdates") for (const [e, x] of Object.entries(v)) cfg.orderUpdates[e] = { ...(cfg.orderUpdates[e]?.toObject?.() || cfg.orderUpdates[e] || {}), ...x };
      else cfg[k] = typeof v === "object" && !Array.isArray(v) ? { ...(cfg[k]?.toObject?.() || cfg[k] || {}), ...v } : v;
    }
    cfg.markModified("orderUpdates");
    await cfg.save();
    await audit.log(req, "marketing_settings_changed", { target: "marketing/config", meta: { fields: Object.keys(d), orderUpdates: Object.entries(cfg.orderUpdates.toObject?.() || cfg.orderUpdates).filter(([, x]) => x?.enabled).map(([e]) => e) } });
    res.send({ ...cfg.toObject(), events: orderUpdates.EVENTS, vars: orderUpdates.VARS });
  })
);

/* ---------- templates ---------- */
router.get("/templates", ah(async (req, res) => res.send((await WaTemplate.find({ organization: req.org }).lean()).sort((a, b) => a.name.localeCompare(b.name)))));
router.post(
  "/templates/sync",
  ah(async (req, res) => {
    const i = await integrationOf(req.org);
    if (!i?.meta?.token || !i.meta.wabaId) throw new HttpError(400, "Add the System User token and WABA ID in Marketing → Integrations first");
    const list = await require("../utils/marketing/whatsapp").listTemplates(i);
    const seen = new Set();
    for (const t of list) {
      seen.add(`${t.name}|${t.language}`);
      await WaTemplate.updateOne({ organization: req.org, name: t.name, language: t.language }, { $set: { ...t, syncedAt: new Date() } }, { upsert: true });
    }
    for (const t of await WaTemplate.find({ organization: req.org }, { name: 1, language: 1 }).lean()) if (!seen.has(`${t.name}|${t.language}`)) await WaTemplate.deleteOne({ _id: t._id });
    res.send((await WaTemplate.find({ organization: req.org }).lean()).sort((a, b) => a.name.localeCompare(b.name)));
  })
);

/* ---------- order updates: test + per-order log ---------- */
router.post(
  "/automations/test",
  ah(async (req, res) => {
    const d = validate(Joi.object({ event: Joi.string().valid(...Object.keys(orderUpdates.EVENTS)).required(), order: Joi.string().required(), to: Joi.string().required() }), req.body);
    const { storeOrgFor } = require("../utils/marketing/match");
    const storeOrg = await storeOrgFor(req.org);
    const n = Number(String(d.order).replace(/\D/g, ""));
    const o = (n && (await ShopifyOrder.findOne({ organization: storeOrg, orderNumber: n }))) || (await ShopifyOrder.findOne({ organization: storeOrg, name: `#${String(d.order).replace(/^#/, "")}` }));
    if (!o) throw new HttpError(404, "Order not found");
    const cfg = await configOf(req.org);
    const ev = cfg.orderUpdates?.[d.event];
    if (!ev?.template) throw new HttpError(400, "Choose a template for this event first");
    const i = await integrationOf(req.org);
    if (!canWhatsApp(i)) throw new HttpError(400, "WhatsApp isn't connected (Marketing → Integrations)");
    const to = require("../utils/marketing/phone").toWa(d.to);
    if (!to) throw new HttpError(400, "Enter a WhatsApp number");
    const v = orderUpdates.varsOf(o, (await require("../models/Organization").findById(req.org, { name: 1 }).lean())?.name || "");
    const tpl = { name: ev.template, language: ev.language || "en", body: (ev.params || []).map((k) => v[k] ?? ""), header: ev.headerParam ? v[ev.headerParam] : undefined };
    if (d.event === "cod_confirmation") tpl.quickReplies = [`COD_CONFIRM:${o._id}`, `COD_CANCEL:${o._id}`];
    if (ev.urlButtonParam && v[ev.urlButtonParam]) tpl.urlButton = v[ev.urlButtonParam];
    try {
      const id = await require("../utils/marketing/whatsapp").sendTemplate(i, to, tpl);
      await audit.log(req, "order_update_test_sent", { target: `order:${o.name}`, meta: { event: d.event, template: ev.template } });
      res.send({ ok: true, id, preview: tpl.body });
    } catch (e) {
      throw new HttpError(502, e.message);
    }
  })
);

async function orderInScope(req, id) {
  idOk(id);
  const { storeOrgFor } = require("../utils/marketing/match");
  const o = await ShopifyOrder.findOne({ _id: id, organization: await storeOrgFor(req.org) });
  if (!o) throw new HttpError(404, "Order not found");
  return o;
}
router.get(
  "/order-log/:orderId",
  ah(async (req, res) => {
    const o = await orderInScope(req, req.params.orderId);
    const rows = (await OrderMessage.find({ order: o._id }).lean()).sort((a, b) => new Date(b.at) - new Date(a.at));
    res.send({ rows, codConfirm: o.codConfirm || null, events: orderUpdates.EVENTS });
  })
);
router.post(
  "/order-log/:orderId/resend",
  ah(async (req, res) => {
    const d = validate(Joi.object({ event: Joi.string().valid(...Object.keys(orderUpdates.EVENTS)).required() }), req.body);
    const o = await orderInScope(req, req.params.orderId);
    const r = await orderUpdates.dispatch(o, d.event, { force: true });
    await audit.log(req, "order_update_resent", { target: `order:${o.name}`, meta: { event: d.event, result: r.sent ? "sent" : r.failed ? "failed" : r.skipped } });
    if (r.failed) throw new HttpError(502, r.failed);
    if (r.skipped) throw new HttpError(400, `Not sent: ${r.skipped}`);
    res.send(r);
  })
);

/* ---------- audiences + campaigns ---------- */
const audienceJoi = Joi.object({
  source: Joi.string().valid("orders", "customers", "both").default("orders"),
  lastDays: Joi.number().integer().min(0).allow(null),
  notSinceDays: Joi.number().integer().min(0).allow(null),
  states: Joi.array().items(Joi.string()).max(40),
  cities: Joi.array().items(Joi.string()).max(100),
  skus: Joi.array().items(Joi.string()).max(200),
  products: Joi.array().items(Joi.string()).max(50),
  payment: Joi.string().valid("", "cod", "prepaid"),
  minOrders: Joi.number().min(0).allow(null),
  maxOrders: Joi.number().min(0).allow(null),
  minSpend: Joi.number().min(0).allow(null),
  maxSpend: Joi.number().min(0).allow(null),
  tags: Joi.array().items(Joi.string()).max(30),
  consent: Joi.string().valid("subscribed", "any").default("subscribed"),
});

const mask = (s) => (/@/.test(s) ? s.replace(/^(.).*?(.)@/, "$1•••$2@") : String(s).replace(/^(\d+)(\d{4})$/, (m, a, b) => `${a.slice(0, 2)}${"•".repeat(Math.max(0, a.length - 2))}${b}`));
router.post(
  "/audience/preview",
  ah(async (req, res) => {
    const d = validate(Joi.object({ channel: Joi.string().valid("whatsapp", "email").required(), audience: audienceJoi.default({}) }), req.body);
    const a = await require("../utils/marketing/audience").build(req.org, d.channel, d.audience);
    res.send({ count: a.count, excluded: a.excluded, consentRecords: a.consentRecords, matchedBeforeConsent: a.matchedBeforeConsent, sample: a.contacts.slice(0, 8).map((c) => ({ name: c.name, to: mask(c.to), orders: c.vars.orders, spend: c.vars.spend })) });
  })
);

const campaignJoi = Joi.object({
  name: Joi.string().trim().max(120).required(),
  channel: Joi.string().valid("whatsapp", "email").required(),
  audience: audienceJoi.default({}),
  whatsapp: Joi.object({ template: Joi.string().allow(""), language: Joi.string().allow(""), params: Joi.array().items(Joi.string().allow("")).max(10), headerParam: Joi.string().allow(""), headerMediaUrl: Joi.string().allow("").uri({ scheme: ["https"] }) }),
  email: Joi.object({ subject: Joi.string().allow("").max(200), body: Joi.string().allow("").max(20000) }),
  ratePerMinute: Joi.number().integer().min(1).max(1000),
});

router.get(
  "/campaigns",
  ah(async (req, res) => res.send((await Campaign.find({ organization: req.org }).lean()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))))
);
router.post(
  "/campaigns",
  ah(async (req, res) => {
    const d = validate(campaignJoi, req.body);
    const cfg = await configOf(req.org);
    const c = await Campaign.create({ ...d, organization: req.org, ratePerMinute: d.ratePerMinute || cfg.campaignRatePerMinute || 60, createdBy: req.user._id, createdByName: req.user.name });
    res.status(201).send(c);
  })
);
const campaignOf = async (req) => {
  const c = await Campaign.findOne({ _id: idOk(req.params.id), organization: req.org });
  if (!c) throw new HttpError(404, "Campaign not found");
  return c;
};
router.get(
  "/campaigns/:id",
  ah(async (req, res) => {
    const c = await campaignOf(req);
    const rs = await CampaignRecipient.find({ campaign: c._id }).lean();
    const status = String(req.query.status || "");
    const rows = rs.filter((r) => !status || r.status === status).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 500).map((r) => ({ _id: r._id, to: mask(r.to), name: r.name, status: r.status, error: r.error, sentAt: r.sentAt, attempts: r.attempts }));
    res.send({ campaign: c, recipients: rows });
  })
);
router.put(
  "/campaigns/:id",
  ah(async (req, res) => {
    const c = await campaignOf(req);
    if (!["draft", "scheduled"].includes(c.status)) throw new HttpError(400, "Only drafts and scheduled campaigns can be changed");
    const d = validate(campaignJoi, req.body);
    Object.assign(c, d);
    await c.save();
    res.send(c);
  })
);
router.delete(
  "/campaigns/:id",
  ah(async (req, res) => {
    const c = await campaignOf(req);
    if (["running"].includes(c.status)) throw new HttpError(400, "Pause or cancel the campaign first");
    await CampaignRecipient.deleteMany({ campaign: c._id });
    await Campaign.deleteOne({ _id: c._id });
    res.send({ ok: true });
  })
);

function checkReady(c) {
  if (c.channel === "whatsapp" && !c.whatsapp?.template) throw new HttpError(400, "Choose a WhatsApp template");
  if (c.channel === "email" && (!c.email?.subject || !c.email?.body)) throw new HttpError(400, "Write the subject and the message");
}
async function checkTemplate(c) {
  if (c.channel !== "whatsapp") return;
  const t = await WaTemplate.findOne({ organization: c.organization, name: c.whatsapp.template, language: c.whatsapp.language || "en" }).lean();
  if (!t) throw new HttpError(400, "That template isn't synced — press “Sync templates” on Marketing → Automations");
  if (t.status !== "APPROVED") throw new HttpError(400, `The template is ${t.status}, not approved`);
  if (t.category !== "MARKETING") throw new HttpError(400, "Broadcasts need a template of the MARKETING category (WhatsApp's rules)");
}

router.post(
  "/campaigns/:id/test",
  ah(async (req, res) => {
    const d = validate(Joi.object({ to: Joi.string().required() }), req.body);
    const c = await campaignOf(req);
    checkReady(c);
    await checkTemplate(c);
    try {
      await require("../utils/marketing/campaigns").testSend(c, d.to, req.user);
    } catch (e) {
      throw new HttpError(e.status && e.status < 500 ? e.status : 502, e.message);
    }
    await audit.log(req, "campaign_test_sent", { target: `campaign:${c._id}`, meta: { channel: c.channel, name: c.name } });
    res.send({ ok: true });
  })
);

router.post(
  "/campaigns/:id/launch",
  ah(async (req, res) => {
    const d = validate(Joi.object({ at: Joi.date().allow(null, "") }), req.body);
    const c = await campaignOf(req);
    if (!["draft", "scheduled"].includes(c.status)) throw new HttpError(400, "This campaign was already sent");
    checkReady(c);
    await checkTemplate(c);
    if (c.channel === "email" && !require("../utils/mailer").canEmail(await require("../models/Organization").findById(req.org))) throw new HttpError(400, "Email isn't set up (Settings → Email)");
    if (c.channel === "whatsapp" && !canWhatsApp(await integrationOf(req.org))) throw new HttpError(400, "WhatsApp isn't connected (Marketing → Integrations)");
    const { build } = require("../utils/marketing/audience");
    const a = await build(req.org, c.channel, c.audience || {});
    if (!a.count) throw new HttpError(400, "Nobody matches this audience (after consent and opt-outs)");
    c.status = "scheduled";
    c.scheduledAt = d.at ? new Date(d.at) : new Date();
    c.error = "";
    await c.save();
    await audit.log(req, "campaign_launched", { target: `campaign:${c._id}`, meta: { name: c.name, channel: c.channel, recipients: a.count, scheduledAt: c.scheduledAt, template: c.whatsapp?.template || "" } });
    res.send(c);
  })
);
for (const [action, from, to] of [["pause", ["running", "scheduled"], "paused"], ["resume", ["paused"], "running"], ["cancel", ["running", "scheduled", "paused"], "cancelled"]]) {
  router.post(
    `/campaigns/:id/${action}`,
    ah(async (req, res) => {
      const c = await campaignOf(req);
      if (!from.includes(c.status)) throw new HttpError(400, `Can't ${action} a ${c.status} campaign`);
      c.status = action === "resume" && !(await CampaignRecipient.exists({ campaign: c._id })) ? "scheduled" : to;
      if (action === "cancel") {
        c.finishedAt = new Date();
        const q = await CampaignRecipient.find({ campaign: c._id, status: "queued" }, { _id: 1 }).lean();
        for (const r of q) await CampaignRecipient.updateOne({ _id: r._id }, { $set: { status: "skipped", error: "Campaign cancelled" } });
        await require("../utils/marketing/campaigns").bumpTotals(c._id);
      }
      await c.save();
      await audit.log(req, `campaign_${action}`, { target: `campaign:${c._id}`, meta: { name: c.name } });
      res.send(c);
    })
  );
}
router.post(
  "/campaigns/:id/duplicate",
  ah(async (req, res) => {
    const c = await campaignOf(req);
    const x = await Campaign.create({ organization: req.org, name: `${c.name} (copy)`, channel: c.channel, audience: c.audience, whatsapp: c.whatsapp, email: c.email, ratePerMinute: c.ratePerMinute, createdBy: req.user._id, createdByName: req.user.name });
    res.status(201).send(x);
  })
);

/* ---------- auto-reply rules ---------- */
const ruleJoi = Joi.object({ name: Joi.string().trim().max(120).required(), active: Joi.boolean().default(true), channels: Joi.array().items(Joi.string().valid("whatsapp", "messenger", "instagram", "fb_comment", "ig_comment")).default([]), match: Joi.string().valid("contains", "exact").default("contains"), keywords: Joi.array().items(Joi.string().trim().max(80)).min(1).max(50).required(), hours: Joi.string().valid("any", "open", "closed").default("any"), reply: Joi.object({ kind: Joi.string().valid("text", "template").default("text"), text: Joi.string().allow("").max(2000), template: Joi.string().allow(""), language: Joi.string().allow("") }).required(), position: Joi.number().integer().default(0) });
router.get("/rules", ah(async (req, res) => res.send((await AutoReplyRule.find({ organization: req.org }).lean()).sort((a, b) => (a.position || 0) - (b.position || 0)))));
router.post("/rules", ah(async (req, res) => res.status(201).send(await AutoReplyRule.create({ ...validate(ruleJoi, req.body), organization: req.org }))));
router.put(
  "/rules/:id",
  ah(async (req, res) => {
    const r = await AutoReplyRule.findOne({ _id: idOk(req.params.id), organization: req.org });
    if (!r) throw new HttpError(404, "Rule not found");
    Object.assign(r, validate(ruleJoi, req.body));
    await r.save();
    res.send(r);
  })
);
router.delete(
  "/rules/:id",
  ah(async (req, res) => {
    await AutoReplyRule.deleteOne({ _id: idOk(req.params.id), organization: req.org });
    res.send({ ok: true });
  })
);

/* ---------- quick replies ---------- */
const qrJoi = Joi.object({ title: Joi.string().trim().max(80).required(), shortcut: Joi.string().allow("").trim().max(30), text: Joi.string().max(4000).required() });
router.get("/quick-replies", ah(async (req, res) => res.send((await QuickReply.find({ organization: req.org }).lean()).sort((a, b) => a.title.localeCompare(b.title)))));
router.post("/quick-replies", ah(async (req, res) => res.status(201).send(await QuickReply.create({ ...validate(qrJoi, req.body), organization: req.org }))));
router.put(
  "/quick-replies/:id",
  ah(async (req, res) => {
    const q = await QuickReply.findOne({ _id: idOk(req.params.id), organization: req.org });
    if (!q) throw new HttpError(404, "Not found");
    Object.assign(q, validate(qrJoi, req.body));
    await q.save();
    res.send(q);
  })
);
router.delete(
  "/quick-replies/:id",
  ah(async (req, res) => {
    await QuickReply.deleteOne({ _id: idOk(req.params.id), organization: req.org });
    res.send({ ok: true });
  })
);

/* ---------- opt-outs ---------- */
router.get(
  "/optouts",
  ah(async (req, res) => {
    const q = String(req.query.q || "").toLowerCase().replace(/\s/g, "");
    const all = (await OptOut.find({ organization: req.org }).lean()).filter((x) => !q || x.value.includes(q.replace(/^\+/, "").slice(-10))).sort((a, b) => new Date(b.at) - new Date(a.at));
    res.send({ items: all.slice(0, 500), total: all.length });
  })
);
router.post(
  "/optouts",
  ah(async (req, res) => {
    const d = validate(Joi.object({ channel: Joi.string().valid("whatsapp", "email").required(), value: Joi.string().required(), note: Joi.string().allow("").max(200) }), req.body);
    const r = await require("../utils/marketing/optout").optOut(req.org, d.channel, d.value, "staff", d.note || "");
    if (!r) throw new HttpError(400, d.channel === "whatsapp" ? "Enter a valid phone number" : "Enter a valid email address");
    await audit.log(req, "optout_added", { target: "marketing/optouts", meta: { channel: d.channel } });
    res.status(201).send(r);
  })
);
router.delete(
  "/optouts/:id",
  ah(async (req, res) => {
    await OptOut.deleteOne({ _id: idOk(req.params.id), organization: req.org });
    await audit.log(req, "optout_removed", { target: "marketing/optouts" });
    res.send({ ok: true });
  })
);

router.post(
  "/consent/sync",
  ah(async (req, res) => {
    const ShopifyStore = require("../models/ShopifyStore");
    const { storeOrgFor } = require("../utils/marketing/match");
    const s = await ShopifyStore.findOne({ organization: await storeOrgFor(req.org), connected: true });
    if (!s) throw new HttpError(400, "Connect the Shopify store first");
    try {
      res.send({ synced: await require("../utils/marketing/audience").syncConsent(s) });
    } catch (e) {
      throw new HttpError(502, `Shopify: ${e.message}. The app needs the read_customers scope.`);
    }
  })
);

module.exports = router;
module.exports.moduleOf = moduleOf;
