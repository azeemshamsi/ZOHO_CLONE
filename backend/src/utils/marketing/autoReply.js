/**
 * Auto-replies for inbound messages, in this order (at most one reply per message):
 *   1. keyword rules (AutoReplyRule)        3. away message outside business hours
 *   2. built-in order-status answer         4. AI draft (Gemini) — saved for approval, auto-sent only if enabled
 * Never auto-replies to the same conversation more than once in 10 minutes, and stops once a person from the
 * team has replied in the conversation (in the last 12 hours).
 */
const AutoReplyRule = require("../../models/AutoReplyRule");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");

const THROTTLE_MS = 10 * 60 * 1000;
const HUMAN_MS = 12 * 3600 * 1000;
const DM = ["whatsapp", "messenger", "instagram"];

// India time "HH:MM" and weekday.
function istParts(d = new Date()) {
  const t = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return { day: t.getUTCDay(), hm: `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}` };
}
// Open now? Business hours off → always open.
function isOpen(hours, d = new Date()) {
  if (!hours?.enabled) return true;
  const { day, hm } = istParts(d);
  return (hours.days || []).some((x) => Number(x.day) === day && x.open && x.close && hm >= x.open && hm < x.close);
}

const normText = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function ruleMatches(rule, text, channel, open) {
  if (!rule.active) return false;
  if (rule.channels?.length && !rule.channels.includes(channel)) return false;
  if (rule.hours === "open" && !open) return false;
  if (rule.hours === "closed" && open) return false;
  const t = normText(text);
  if (!t) return false;
  const kws = (rule.keywords || []).map(normText).filter(Boolean);
  if (!kws.length) return false;
  if (rule.match === "exact") return kws.includes(t.replace(/[.!?]+$/, ""));
  return kws.some((k) => (/^[a-z0-9 ]+$/.test(k) ? new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, "\\s+")}($|[^a-z0-9])`).test(t) : t.includes(k)));
}

// May we auto-reply now? → "" or the reason not to.
function blockedReason(conv, now = Date.now()) {
  if (conv.lastAutoReplyAt && now - new Date(conv.lastAutoReplyAt).getTime() < THROTTLE_MS) return "throttled";
  if (conv.humanRepliedAt && now - new Date(conv.humanRepliedAt).getTime() < HUMAN_MS) return "human";
  return "";
}

const ORDER_WORDS = /\b(order|status|track|tracking|where|deliver|delivery|dispatch|shipped|parcel|awb|kab|kahan|kaha|kidhar|pahunch)\w*/i;
function looksLikeOrderQuery(text) {
  return ORDER_WORDS.test(text || "") || /#\d{4,8}\b/.test(text || "");
}

async function orderStatusText(org, conv, text) {
  const { ordersFor, orderByNumber, orderMatches } = require("./match");
  const { STATUS } = require("./ai");
  let o = null;
  const byNo = await orderByNumber(org, text);
  // An order number in the message: only answer with details if it's the sender's own order.
  if (byNo && orderMatches(byNo, { phone: conv.contact?.phone, email: conv.contact?.email })) o = byNo;
  if (!o) o = (await ordersFor(org, conv.contact || {}, { limit: 1 }))[0];
  if (!o) return byNo ? `For order details please message us from the phone number used on the order, or our team will help you shortly.` : "";
  const sh = o.shipment || {};
  const lines = [`Your order ${o.name} is ${STATUS[o.status] || o.status}.`];
  if (sh.awb && ["ready_to_ship", "shipped", "delivered", "rto"].includes(o.status)) lines.push(`Courier: ${sh.courierName || "-"}, AWB ${sh.awb}.`);
  if (sh.trackingUrl && ["ready_to_ship", "shipped"].includes(o.status)) lines.push(`Track it here: ${sh.trackingUrl}`);
  return lines.join("\n");
}

async function aiDraft(org, conv) {
  const Organization = require("../../models/Organization");
  const orgDoc = await Organization.findById(org);
  const ai = require("./ai");
  if (!ai.keyOf(orgDoc)) return "";
  const cfg = await require("./integration").configOf(org);
  const messages = await Message.find({ conversation: conv._id, kind: { $ne: "note" } }).sort({ at: -1 }).limit(15).lean();
  const orders = await require("./match").ordersFor(org, conv.contact || {}, { limit: 5 }).catch(() => []);
  const text = await ai.generate(orgDoc, ai.buildPrompt({ orgName: orgDoc.name, channel: conv.channel, contactName: conv.contact?.name, messages: messages.reverse(), orders, instructions: cfg?.ai?.instructions }));
  if (text) await Conversation.updateOne({ _id: conv._id }, { $set: { aiDraft: { text, at: new Date(), by: "Gemini" } } });
  return text;
}

async function handle(org, conv, msg, { cfg } = {}) {
  cfg = cfg || (await require("./integration").configOf(org));
  if (msg.direction !== "in") return null;
  const text = msg.text || "";
  const open = isOpen(cfg.businessHours);
  const blocked = blockedReason(conv);
  const { sendReply } = require("./inbox");
  const send = async (o) => sendReply(org, conv, { byName: "Auto-reply", ...o });
  if (!blocked) {
    // 1. keyword rules
    const rules = (await AutoReplyRule.find({ organization: org }).lean()).sort((a, b) => (a.position || 0) - (b.position || 0));
    const rule = rules.find((r) => ruleMatches(r, text, conv.channel, open));
    if (rule) {
      if (rule.reply?.kind === "template" && conv.channel === "whatsapp" && rule.reply.template) return send({ template: { name: rule.reply.template, language: rule.reply.language || "en", body: [] }, text: `[template ${rule.reply.template}]`, auto: "rule" });
      if (rule.reply?.text) return send({ text: rule.reply.text, auto: "rule" });
    }
    // 2. order status
    if (cfg.orderStatusReply?.enabled && (cfg.orderStatusReply.channels || DM).includes(conv.channel) && looksLikeOrderQuery(text)) {
      const t = await orderStatusText(org, conv, text);
      if (t) return send({ text: t, auto: "order_status" });
    }
    // 3. away
    if (!open && cfg.away?.enabled && (cfg.away.channels || DM).includes(conv.channel) && cfg.away.text) return send({ text: cfg.away.text, auto: "away" });
  }
  // 4. AI draft (for approval; auto-sent only where switched on, and never more than the throttle allows)
  const autoSend = (cfg.ai?.autoSend || []).includes(conv.channel);
  if (cfg.ai?.enabled !== false && (cfg.ai?.autoDraft || autoSend)) {
    const draft = await aiDraft(org, conv).catch(() => "");
    if (draft && !blocked && autoSend) {
      await Conversation.updateOne({ _id: conv._id }, { $unset: { aiDraft: 1 } });
      return send({ text: draft, auto: "ai", byName: "AI (auto)" });
    }
  }
  return null;
}

module.exports = { handle, isOpen, istParts, ruleMatches, blockedReason, looksLikeOrderQuery, orderStatusText, aiDraft, THROTTLE_MS };
