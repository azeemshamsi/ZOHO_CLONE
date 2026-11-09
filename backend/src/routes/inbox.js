/**
 * Inbox (module "inbox"): conversations from WhatsApp, Messenger, Instagram, Facebook / Instagram comments and
 * Gmail, with replies, notes, templates, assignment and the customer's matched store orders.
 */
const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { ah, validate, HttpError } = require("../utils/http");
const inbox = require("../utils/marketing/inbox");
const { integrationOf, channelsOf } = require("../utils/marketing/integration");
const audit = require("../utils/audit");

const convOf = async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Conversation not found");
  const c = await Conversation.findOne({ _id: req.params.id, organization: req.org });
  if (!c) throw new HttpError(404, "Conversation not found");
  return c;
};

const LIST_FIELDS = { channel: 1, externalId: 1, contact: 1, status: 1, assignedTo: 1, unread: 1, lastMessageAt: 1, lastMessagePreview: 1, windowEndsAt: 1, tags: 1, subject: 1, post: 1, customer: 1 };

router.get(
  "/conversations",
  ah(async (req, res) => {
    const { channel = "", status = "", filter = "", q = "", limit = 60, before = "" } = req.query;
    let all = await Conversation.find({ organization: req.org }, LIST_FIELDS).lean();
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const me = String(req.user._id);
    all = all.filter(
      (c) =>
        (!channel || c.channel === channel || (channel === "comments" && c.channel.endsWith("_comment"))) &&
        (!status || c.status === status) &&
        (filter !== "unread" || c.unread > 0) &&
        (filter !== "mine" || String(c.assignedTo || "") === me) &&
        (filter !== "unassigned" || !c.assignedTo) &&
        (!before || new Date(c.lastMessageAt || 0) < new Date(before)) &&
        (!words.length || words.every((w) => [c.contact?.name, c.contact?.phone, c.contact?.email, c.contact?.handle, c.lastMessagePreview, c.subject, ...(c.tags || [])].filter(Boolean).join(" ").toLowerCase().includes(w)))
    );
    all.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
    res.send({ items: all.slice(0, Math.min(200, Number(limit) || 60)), total: all.length });
  })
);

router.get(
  "/summary",
  ah(async (req, res) => {
    const all = await Conversation.find({ organization: req.org }, { channel: 1, unread: 1, status: 1, assignedTo: 1 }).lean();
    const unread = {};
    for (const c of all) if (c.unread > 0 && c.status !== "closed") unread[c.channel] = (unread[c.channel] || 0) + 1;
    const i = await integrationOf(req.org);
    res.send({ unread, totalUnread: Object.values(unread).reduce((s, n) => s + n, 0), channels: channelsOf(i), mine: all.filter((c) => String(c.assignedTo || "") === String(req.user._id) && c.status !== "closed").length });
  })
);

router.get(
  "/conversations/:id",
  ah(async (req, res) => {
    const c = await convOf(req);
    const msgs = await Message.find({ organization: req.org, conversation: c._id }).sort({ at: -1 }).limit(300).lean();
    msgs.reverse();
    if (c.unread) {
      await Conversation.updateOne({ _id: c._id }, { $set: { unread: 0 } });
      // WhatsApp: blue ticks for the customer's latest message.
      const lastIn = [...msgs].reverse().find((m) => m.direction === "in" && m.externalId);
      if (c.channel === "whatsapp" && lastIn) integrationOf(req.org).then((i) => i && channelsOf(i).whatsapp && require("../utils/marketing/whatsapp").markRead(i, lastIn.externalId)).catch(() => {});
    }
    const out = c.toObject();
    out.unread = 0;
    out.inWindow = inbox.inWindow(c);
    if (c.assignedTo) {
      const User = require("../models/User");
      out.assignedName = (await User.findById(c.assignedTo, { name: 1 }).lean())?.name || "";
    }
    res.send({ conversation: out, messages: msgs });
  })
);

router.get(
  "/conversations/:id/orders",
  ah(async (req, res) => {
    const c = await convOf(req);
    const { ordersFor } = require("../utils/marketing/match");
    const orders = await ordersFor(req.org, c.contact || {}, { limit: 20 });
    let customer = null;
    if (c.customer) customer = await require("../models/Customer").findOne({ _id: c.customer, organization: req.org }, { displayName: 1, email: 1, phone: 1 }).lean();
    const OrderMessage = require("../models/OrderMessage");
    const logs = orders.length ? await OrderMessage.find({ order: { $in: orders.map((o) => o._id) } }, { order: 1, event: 1, status: 1, at: 1, reply: 1 }).lean() : [];
    for (const o of orders) o.updates = logs.filter((l) => String(l.order) === String(o._id));
    const totals = { orders: orders.length, spend: Math.round(orders.filter((o) => o.status !== "cancelled").reduce((s, o) => s + (o.total || 0), 0)), rto: orders.filter((o) => o.status === "rto").length };
    res.send({ orders, customer, totals, canSeeOrders: (req.perms.store_orders || "none") !== "none" || (req.perms.store_shipping || "none") !== "none" });
  })
);

const fileJoi = Joi.object({ name: Joi.string().max(200).required(), type: Joi.string().allow("").max(120), data: Joi.string().required() });
router.post(
  "/conversations/:id/messages",
  ah(async (req, res) => {
    const d = validate(
      Joi.object({
        text: Joi.string().allow("").max(20000),
        note: Joi.boolean(),
        template: Joi.object({ name: Joi.string().required(), language: Joi.string().default("en"), body: Joi.array().items(Joi.string().allow("")).default([]), header: Joi.string().allow("") }),
        file: fileJoi,
        privateReply: Joi.boolean(),
        commentId: Joi.string().allow(""),
        humanAgent: Joi.boolean(),
        quote: Joi.boolean(),
        replyTo: Joi.string().allow(""),
        fromDraft: Joi.boolean(),
      }),
      req.body
    );
    const c = await convOf(req);
    if (!d.text && !d.template && !d.file) throw new HttpError(400, "Type a message");
    let file;
    if (d.file) {
      const buf = Buffer.from(d.file.data.replace(/^data:.*?;base64,/, ""), "base64");
      if (!buf.length) throw new HttpError(400, "The file is empty");
      if (buf.length > 16 * 1024 * 1024) throw new HttpError(400, "Files can be up to 16 MB");
      file = { buf, mime: d.file.type || "application/octet-stream", name: d.file.name };
    }
    const tpl = d.template ? { ...d.template, header: d.template.header || undefined } : undefined;
    const msg = await inbox.sendReply(req.org, c, { text: d.text || (tpl ? `[template ${tpl.name}] ${(tpl.body || []).join(" · ")}` : ""), note: d.note, template: tpl, file, privateReply: d.privateReply, commentId: d.commentId, humanAgent: d.humanAgent, quote: d.quote, replyTo: d.replyTo, user: req.user, byName: d.fromDraft ? `AI draft, approved by ${req.user.name}` : undefined });
    if (d.fromDraft) await Conversation.updateOne({ _id: c._id }, { $unset: { aiDraft: 1 } });
    if (!d.note) await audit.log(req, "inbox_message_sent", { target: `conversation:${c._id}`, meta: { channel: c.channel, kind: msg.kind, status: msg.status, template: tpl?.name || "", privateReply: !!d.privateReply } });
    res.status(msg.status === "failed" ? 502 : 201).send(msg.status === "failed" ? { message: msg.error, msg } : msg);
  })
);

router.post(
  "/conversations/:id/hide",
  ah(async (req, res) => {
    const d = validate(Joi.object({ messageId: Joi.string().required(), hide: Joi.boolean().default(true) }), req.body);
    const c = await convOf(req);
    if (!c.channel.endsWith("_comment")) throw new HttpError(400, "Only comments can be hidden");
    const m = await Message.findOne({ _id: d.messageId, conversation: c._id });
    if (!m?.externalId) throw new HttpError(404, "Comment not found");
    const i = await integrationOf(req.org);
    await require("../utils/marketing/meta").hideComment(i, c.channel, m.externalId, d.hide);
    m.meta = { ...(m.meta || {}), hidden: d.hide };
    m.markModified("meta");
    await m.save();
    await audit.log(req, d.hide ? "comment_hidden" : "comment_unhidden", { target: `conversation:${c._id}`, meta: { channel: c.channel } });
    res.send(m);
  })
);

router.put(
  "/conversations/:id",
  ah(async (req, res) => {
    const d = validate(Joi.object({ status: Joi.string().valid("open", "pending", "closed"), assignedTo: Joi.string().allow("", null), tags: Joi.array().items(Joi.string().trim().max(40)).max(20), contactName: Joi.string().allow("").max(120) }), req.body);
    const c = await convOf(req);
    if (d.status) c.status = d.status;
    if (d.assignedTo !== undefined) {
      if (d.assignedTo) {
        const Membership = require("../models/Membership");
        if (!(await Membership.exists({ organization: req.org, user: d.assignedTo, status: "active" }))) throw new HttpError(400, "That user isn't in this company");
        c.assignedTo = d.assignedTo;
      } else c.assignedTo = undefined;
    }
    if (d.tags) c.tags = d.tags;
    if (d.contactName !== undefined) c.contact = { ...(c.contact?.toObject?.() || c.contact || {}), name: d.contactName };
    await c.save();
    res.send(c);
  })
);

router.post(
  "/conversations/:id/ai-draft",
  ah(async (req, res) => {
    const c = await convOf(req);
    let text;
    try {
      text = await require("../utils/marketing/autoReply").aiDraft(req.org, c);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (!text) throw new HttpError(400, "Add a Google Gemini API key in Settings → Integrations to get AI drafts");
    res.send({ text });
  })
);

router.delete(
  "/conversations/:id/ai-draft",
  ah(async (req, res) => {
    const c = await convOf(req);
    await Conversation.updateOne({ _id: c._id }, { $unset: { aiDraft: 1 } });
    res.send({ ok: true });
  })
);

// Start a WhatsApp chat with a number (e.g. from an order): opens with a template.
router.post(
  "/start",
  ah(async (req, res) => {
    const d = validate(Joi.object({ phone: Joi.string().required(), name: Joi.string().allow("").max(120) }), req.body);
    const wa = require("../utils/marketing/phone").toWa(d.phone);
    if (!wa) throw new HttpError(400, "Enter a valid phone number");
    const c = await inbox.conversationForPhone(req.org, wa, d.name || "");
    res.send(c);
  })
);

router.get(
  "/media/:id",
  ah(async (req, res) => {
    const { fileOf, streamOf } = require("../utils/marketing/media");
    const f = await fileOf(req.org, req.params.id);
    if (!f) throw new HttpError(404, "File not found (media is kept for 180 days)");
    res.set("Content-Type", f.metadata?.type || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${String(f.filename || "file").replace(/[^\w.\- ]/g, "_")}"`);
    res.set("Cache-Control", "private, max-age=3600");
    streamOf(f._id).on("error", () => res.end()).pipe(res);
  })
);

router.get(
  "/users",
  ah(async (req, res) => {
    const Membership = require("../models/Membership");
    const User = require("../models/User");
    const ms = await Membership.find({ organization: req.org, status: "active" }, { user: 1 }).lean();
    const users = await User.find({ _id: { $in: ms.map((m) => m.user).filter(Boolean) } }, { name: 1, email: 1 }).lean();
    res.send(users.map((u) => ({ _id: u._id, name: u.name || u.email })));
  })
);

router.get(
  "/templates",
  ah(async (req, res) => {
    const WaTemplate = require("../models/WaTemplate");
    res.send((await WaTemplate.find({ organization: req.org }).lean()).filter((t) => t.status === "APPROVED").sort((a, b) => a.name.localeCompare(b.name)));
  })
);

router.get(
  "/quick-replies",
  ah(async (req, res) => {
    const QuickReply = require("../models/QuickReply");
    res.send((await QuickReply.find({ organization: req.org }).lean()).sort((a, b) => a.title.localeCompare(b.title)));
  })
);

module.exports = router;
