/**
 * Inbox core: turn webhook / Gmail events into conversations and messages (idempotent by message id),
 * send replies on every channel, and the 24-hour service window.
 */
const crypto = require("crypto");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const { integrationOf, channelsOf } = require("./integration");
const { last10, cleanEmail } = require("./phone");

const WINDOW_CHANNELS = ["whatsapp", "messenger", "instagram"];
const DAY = 24 * 3600 * 1000;

/* ---------- 24-hour window ---------- */
const windowEnd = (channel, lastInboundAt) => (WINDOW_CHANNELS.includes(channel) && lastInboundAt ? new Date(new Date(lastInboundAt).getTime() + DAY) : null);
// Can a free-form message (not a template) be sent now?
function inWindow(conv, now = new Date()) {
  if (!WINDOW_CHANNELS.includes(conv.channel)) return true;
  return !!conv.windowEndsAt && new Date(conv.windowEndsAt) > now;
}

const preview = (m) => String(m.text || (m.media?.length ? `[${m.kind}]` : m.kind === "template" ? `[template ${m.meta?.template?.name || ""}]` : "")).replace(/\s+/g, " ").slice(0, 140);

// Conversation key for an event.
function keyOf(ev) {
  if (ev.channel === "fb_comment" || ev.channel === "ig_comment") return `${ev.comment?.postId || "post"}:${ev.from}`;
  return String(ev.from || "");
}

/* ---------- signed public links to media (Instagram / Messenger need a URL to send a file) ---------- */
const sigKey = () => crypto.createHash("sha256").update(`inbox-media:${require("../../config/env").JWT_SECRET}`).digest();
function publicMediaUrl(fileId, hours = 24) {
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  const sig = crypto.createHmac("sha256", sigKey()).update(`${fileId}.${exp}`).digest("hex").slice(0, 32);
  return `${require("../../config/env").APP_URL}/api/public-media/${fileId}?exp=${exp}&sig=${sig}`;
}
function checkMediaSig(fileId, exp, sig) {
  if (!exp || Number(exp) < Date.now() / 1000) return false;
  const want = crypto.createHmac("sha256", sigKey()).update(`${fileId}.${exp}`).digest("hex").slice(0, 32);
  return typeof sig === "string" && sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/* ---------- incoming ---------- */
async function findOrCreateConversation(org, ev, i) {
  const externalId = keyOf(ev);
  let conv = await Conversation.findOne({ organization: org, channel: ev.channel, externalId });
  if (conv) return { conv, created: false };
  const contact = { name: ev.contact?.name || "", phone: ev.channel === "whatsapp" ? ev.from : "", email: ev.contact?.email || "", handle: ev.contact?.handle || "", externalId: ev.from };
  const doc = { organization: org, channel: ev.channel, externalId, contact, status: "open", subject: ev.subject || "" };
  if (ev.comment?.postId) doc.post = { id: ev.comment.postId, permalink: ev.comment.permalink || "" };
  try {
    conv = await Conversation.create(doc);
  } catch (e) {
    conv = await Conversation.findOne({ organization: org, channel: ev.channel, externalId }); // created by a parallel event
    if (!conv) throw e;
    return { conv, created: false };
  }
  // Enrich in the background: profile, post, matched customer.
  enrich(org, conv._id, ev, i).catch(() => {});
  return { conv, created: true };
}

async function enrich(org, convId, ev, i) {
  const set = {};
  const meta = require("./meta");
  if (i && ["messenger", "instagram"].includes(ev.channel)) {
    const p = await meta.profileOf(i, ev.channel, ev.from);
    if (p.name) set["contact.name"] = p.name;
    if (p.handle) set["contact.handle"] = p.handle;
    if (p.avatar) set["contact.avatar"] = p.avatar;
  }
  if (i && ev.comment?.postId) {
    const p = await meta.postOf(i, ev.channel, ev.comment.postId);
    set.post = { id: ev.comment.postId, permalink: p.permalink || ev.comment.permalink || "", caption: p.caption || "", thumbnail: p.thumbnail || "" };
  }
  const { customerFor } = require("./match");
  const c = await customerFor(org, { phone: ev.channel === "whatsapp" ? ev.from : "", email: ev.contact?.email || "" }).catch(() => null);
  if (c) set.customer = c._id;
  if (Object.keys(set).length) await Conversation.updateOne({ _id: convId }, { $set: set });
}

async function saveMedia(org, ev, i) {
  const { storeMedia } = require("./media");
  const out = [];
  for (const m of ev.media || []) {
    if (m.fileId) {
      out.push(m); // already stored (Gmail attachments)
      continue;
    }
    try {
      if (m.externalId && ev.channel === "whatsapp") {
        const d = await require("./whatsapp").downloadMedia(i, m.externalId);
        if (d.tooBig) {
          out.push({ externalId: m.externalId, mime: d.mime, name: m.name || "", size: d.size });
          continue;
        }
        out.push({ ...(await storeMedia(org, d.buf, { name: m.name || `${ev.kind}${extOf(d.mime)}`, mime: d.mime })), externalId: m.externalId });
      } else if (m.url) {
        const res = await fetch(m.url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get("content-type") || m.mime || "application/octet-stream";
        out.push(await storeMedia(org, buf, { name: m.name || `${ev.kind}${extOf(mime)}`, mime }));
      }
    } catch (e) {
      out.push({ externalId: m.externalId || "", url: m.url || "", mime: m.mime || "", name: m.name || "", size: 0 });
    }
  }
  return out;
}
const extOf = (mime) => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "application/pdf": ".pdf" }[String(mime).split(";")[0]] || "");

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyStatus(org, ev) {
  if (!ev.externalId) return;
  const st = ev.status === "failed" ? "failed" : ["sent", "delivered", "read"].includes(ev.status) ? ev.status : null;
  if (!st) return;
  const set = { status: st, ...(ev.error ? { error: ev.error } : {}) };
  for (const M of [Message, require("../../models/OrderMessage"), require("../../models/CampaignRecipient")]) {
    const docs = await M.find({ externalId: ev.externalId }, { status: 1, organization: 1, campaign: 1 }).lean();
    for (const d of docs) {
      if (String(d.organization) !== String(org)) continue;
      // Never go backwards (read → delivered) and keep "replied".
      if (d.status === "replied" || (STATUS_RANK[d.status] ?? -1) >= STATUS_RANK[st]) continue;
      await M.updateOne({ _id: d._id }, { $set: set });
      if (d.campaign) require("./campaigns").bumpTotals(d.campaign).catch(() => {});
    }
  }
}

// Messenger "read" with a watermark: our messages up to then are read.
async function applyRead(org, ev) {
  const conv = await Conversation.findOne({ organization: org, channel: ev.channel, externalId: String(ev.from) });
  if (!conv) return;
  const outs = await Message.find({ conversation: conv._id, direction: "out" }, { status: 1, at: 1 }).lean();
  for (const m of outs) if (["sent", "delivered"].includes(m.status) && new Date(m.at) <= ev.watermark) await Message.updateOne({ _id: m._id }, { $set: { status: "read" } });
}

/**
 * One normalised event for a company. Returns the saved message (new ones only).
 */
async function ingest(org, ev, { integration } = {}) {
  if (ev.type === "status") return applyStatus(org, ev);
  if (ev.type === "read") return applyRead(org, ev);
  if (!ev.externalId) return null;
  const dup = await Message.findOne({ organization: org, externalId: ev.externalId }, { _id: 1 }).lean();
  if (dup) {
    if (ev.comment?.verb === "edited" || ev.comment?.verb === "remove" || ev.comment?.verb === "hide") await Message.updateOne({ _id: dup._id }, { $set: ev.comment.verb === "edited" ? { text: ev.text } : { [`meta.${ev.comment.verb === "hide" ? "hidden" : "deleted"}`]: true } });
    return null;
  }
  if (ev.comment && ev.comment.verb !== "add") return null;
  const i = integration || (await integrationOf(org));
  const inbound = ev.type === "message" || ev.type === "comment";
  if (!inbound) {
    // Echo: a message sent from the Page / IG app directly (or one OrdexaGo already recorded).
    let conv;
    if (ev.channel === "fb_comment" || ev.channel === "ig_comment") {
      const parent = ev.comment?.parentId ? await Message.findOne({ organization: org, externalId: ev.comment.parentId }).lean() : null;
      if (!parent) return null;
      conv = await Conversation.findById(parent.conversation);
    } else conv = await Conversation.findOne({ organization: org, channel: ev.channel, externalId: keyOf(ev) });
    if (!conv) return null;
    const msg = await Message.create({ organization: org, conversation: conv._id, direction: "out", kind: ev.kind, text: ev.text, externalId: ev.externalId, status: "sent", byName: "Sent outside OrdexaGo", at: ev.at });
    await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: ev.at, lastMessagePreview: preview(msg), humanRepliedAt: ev.at } });
    return msg;
  }
  const { conv } = await findOrCreateConversation(org, ev, i);
  const media = ev.media?.length ? await saveMedia(org, ev, i) : [];
  const msg = await Message.create({
    organization: org,
    conversation: conv._id,
    direction: "in",
    kind: ev.kind || "text",
    text: ev.text || "",
    html: ev.html || "",
    media,
    externalId: ev.externalId,
    replyTo: ev.replyTo || ev.comment?.parentId || "",
    status: "received",
    meta: { ...(ev.button ? { button: ev.button } : {}), ...(ev.comment ? { comment: ev.comment } : {}), ...(ev.email ? { email: ev.email } : {}) },
    at: ev.at || new Date(),
  });
  const set = { lastMessageAt: msg.at, lastMessagePreview: preview(msg), lastInboundAt: msg.at };
  const we = windowEnd(ev.channel, msg.at);
  if (we) set.windowEndsAt = we;
  if (conv.status === "closed") set.status = "open";
  if (ev.contact?.name && !conv.contact?.name) set["contact.name"] = ev.contact.name;
  if (ev.subject && !conv.subject) set.subject = ev.subject;
  await Conversation.updateOne({ _id: conv._id }, { $set: set, $inc: { unread: 1 } });
  // After saving: opt-outs, COD buttons, campaign replies, auto-replies. Never throws.
  setImmediate(() => afterInbound(org, conv._id, msg, ev, i).catch((e) => console.error(`[inbox] after message: ${e.message}`)));
  return msg;
}

async function afterInbound(org, convId, msg, ev, i) {
  const conv = await Conversation.findById(convId);
  if (!conv) return;
  const cfg = await require("./integration").configOf(org);
  const text = String(msg.text || "").trim();
  // STOP / START
  if (ev.channel === "whatsapp") {
    const { optOut, optIn } = require("./optout");
    const word = text.toUpperCase().replace(/[^A-Z]/g, "");
    if ((cfg.stopKeywords || ["STOP"]).map((k) => k.toUpperCase()).includes(word) || /^STOP|UNSUBSCRIBE$/i.test(ev.button?.payload || "")) {
      await optOut(org, "whatsapp", ev.from, "stop_keyword");
      await sendReply(org, conv, { text: "You won't get promotional messages from us on WhatsApp any more. Reply START to subscribe again.", auto: "optout", byName: "Auto-reply" }).catch(() => {});
      return;
    }
    if (word === "START") {
      await optIn(org, "whatsapp", ev.from);
      return;
    }
    // Replies to campaign messages count as "replied".
    await require("./campaigns").markReplied(org, ev.from).catch(() => {});
  }
  if (ev.button?.payload) {
    const handled = await require("./orderUpdates").handleButton(org, conv, msg, ev).catch((e) => (console.error(`[inbox] button: ${e.message}`), false));
    if (handled) return;
  }
  await require("./autoReply").handle(org, conv, msg, { cfg, integration: i });
}

/* ---------- outgoing ---------- */
/**
 * Send on a conversation's channel.
 *   o: { text, template {name, language, body[], header}, file {buf, mime, name}, note, publicReply, privateReply,
 *        commentId, hide, humanAgent, user, byName, auto, html, quote }
 */
async function sendReply(org, conv, o) {
  const i = await integrationOf(org);
  const user = o.user;
  const by = user?._id;
  const byName = o.byName || user?.name || "";
  const base = { organization: org, conversation: conv._id, direction: "out", by, byName, auto: o.auto || "", at: new Date() };
  if (o.note) {
    const m = await Message.create({ ...base, kind: "note", text: o.text, status: "sent" });
    return m;
  }
  if (!i || !channelsOf(i)[conv.channel]) throw new Error(`${conv.channel.replace("_", " ")} isn't connected (Marketing → Integrations)`);
  const to = conv.externalId;
  let kind = o.template ? "template" : o.file ? kindOfMime(o.file.mime) : conv.channel.endsWith("_comment") ? "comment" : conv.channel === "email" ? "email" : "text";
  let media = [];
  if (o.file) media = [await require("./media").storeMedia(org, o.file.buf, { name: o.file.name, mime: o.file.mime })];
  const msg = new Message({ ...base, kind, text: o.text || "", media, status: "queued", meta: o.template ? { template: { name: o.template.name, language: o.template.language } } : {} });
  try {
    if (!o.template && !inWindow(conv) && !(o.humanAgent && ["messenger", "instagram"].includes(conv.channel))) throw new Error(conv.channel === "whatsapp" ? "More than 24 hours since the customer's last message — choose an approved WhatsApp template." : "More than 24 hours since their last message — Meta allows a reply only within 24 hours (or 7 days with the Human Agent tag, if approved for your app).");
    let id = "";
    if (conv.channel === "whatsapp") {
      const wa = require("./whatsapp");
      if (o.template) id = await wa.sendTemplate(i, to, o.template);
      else if (o.file) {
        const mid = await wa.uploadMedia(i, o.file.buf, o.file.mime, o.file.name);
        id = await wa.sendMedia(i, to, kind === "sticker" ? "image" : kind, { id: mid }, { caption: o.text, filename: o.file.name });
      } else id = await wa.sendText(i, to, o.text, { replyTo: o.replyTo });
    } else if (conv.channel === "messenger" || conv.channel === "instagram") {
      const meta = require("./meta");
      if (o.file) {
        id = await meta.sendDmMedia(i, conv.contact?.externalId || to, kind === "document" ? "file" : kind, publicMediaUrl(media[0].fileId), { humanAgent: !inWindow(conv) && o.humanAgent });
        if (o.text) await meta.sendDmText(i, conv.contact?.externalId || to, o.text, { humanAgent: !inWindow(conv) && o.humanAgent });
      } else id = await meta.sendDmText(i, conv.contact?.externalId || to, o.text, { humanAgent: !inWindow(conv) && o.humanAgent });
    } else if (conv.channel === "fb_comment" || conv.channel === "ig_comment") {
      const meta = require("./meta");
      const commentId = o.commentId || (await latestInboundComment(conv));
      if (!commentId) throw new Error("No comment to reply to");
      if (o.privateReply) {
        const prior = await Message.findOne({ conversation: conv._id, "meta.privateReplyTo": commentId }).lean();
        if (prior) throw new Error("A private reply was already sent for this comment (Meta allows one).");
        id = await meta.privateReply(i, commentId, o.text);
        msg.kind = "text";
        msg.meta = { ...msg.meta, privateReplyTo: commentId, private: true };
      } else {
        id = await meta.replyComment(i, conv.channel, commentId, o.text);
        msg.replyTo = commentId;
      }
    } else if (conv.channel === "email") {
      const r = await require("./gmail").sendReply(i, conv, { text: o.text, html: o.html, quote: o.quote !== false, file: o.file });
      id = r.id;
      msg.meta = { ...msg.meta, email: r.email };
    }
    msg.externalId = id;
    msg.status = "sent";
  } catch (e) {
    msg.status = "failed";
    msg.error = e.message;
  }
  await msg.save();
  const set = { lastMessageAt: msg.at, lastMessagePreview: preview(msg) };
  if (user && !o.auto) {
    set.humanRepliedAt = msg.at;
    set.unread = 0;
  }
  if (o.auto) set.lastAutoReplyAt = msg.at;
  await Conversation.updateOne({ _id: conv._id }, { $set: set });
  if (msg.status === "failed" && o.throwOnFail) throw new Error(msg.error);
  return msg;
}

async function latestInboundComment(conv) {
  const m = await Message.find({ conversation: conv._id, direction: "in", kind: "comment" }, { externalId: 1, at: 1 }).sort({ at: -1 }).limit(1).lean();
  return m[0]?.externalId || "";
}

const kindOfMime = (mime) => {
  const m = String(mime || "");
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
};

// Start (or find) a WhatsApp conversation with a number, e.g. from an order.
async function conversationForPhone(org, waNumber, name = "") {
  const conv = await Conversation.findOne({ organization: org, channel: "whatsapp", externalId: waNumber });
  if (conv) return conv;
  return Conversation.create({ organization: org, channel: "whatsapp", externalId: waNumber, contact: { name, phone: waNumber, externalId: waNumber }, status: "open" }).catch(() => Conversation.findOne({ organization: org, channel: "whatsapp", externalId: waNumber }));
}

// Record an automated outgoing WhatsApp message (order update, campaign) in its conversation.
async function recordOutgoing(org, waNumber, { name, text, template, externalId, status = "sent", error = "", auto }) {
  const conv = await conversationForPhone(org, waNumber, name);
  const msg = await Message.create({ organization: org, conversation: conv._id, direction: "out", kind: template ? "template" : "text", text, externalId, status, error, byName: auto === "campaign" ? "Campaign" : "Order update", auto, meta: template ? { template } : {}, at: new Date() });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: msg.at, lastMessagePreview: preview(msg) } });
  return msg;
}

module.exports = { ingest, sendReply, inWindow, windowEnd, keyOf, preview, applyStatus, publicMediaUrl, checkMediaSig, conversationForPhone, recordOutgoing, kindOfMime, WINDOW_CHANNELS, last10, cleanEmail };
