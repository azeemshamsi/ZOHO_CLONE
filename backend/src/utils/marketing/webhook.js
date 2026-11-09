/**
 * Meta webhooks (WhatsApp Cloud API, Messenger, Instagram messaging + comments, Page feed comments):
 * signature check and normalisation of the payloads into simple events the Inbox understands.
 *
 * Event: { type: message|echo|status|comment|read, channel, phoneNumberId, wabaId, pageId, igId, externalId,
 *          from, contact {name, phone, handle}, kind, text, media [{externalId|url, mime, name}], replyTo,
 *          button {payload, text}, status, recipient, error, comment {id, parentId, postId, permalink, verb}, at }
 */
const crypto = require("crypto");

// X-Hub-Signature-256: "sha256=" + HMAC-SHA256(raw body, App Secret), compared in constant time.
function verifySignature(raw, header, secret) {
  if (!secret || !header || !Buffer.isBuffer(raw)) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const want = crypto.createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const tsDate = (t) => {
  const n = Number(t);
  if (!n) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
};

/* ---------- WhatsApp ---------- */
function waMessage(m, base, contacts) {
  const c = (contacts || []).find((x) => x.wa_id === m.from) || contacts?.[0] || {};
  const ev = { ...base, type: "message", channel: "whatsapp", externalId: m.id, from: m.from, contact: { name: c.profile?.name || "", phone: m.from }, replyTo: m.context?.id || "", at: tsDate(m.timestamp), kind: "text", text: "", media: [] };
  const t = m.type;
  if (t === "text") ev.text = m.text?.body || "";
  else if (["image", "video", "audio", "document", "sticker"].includes(t)) {
    const x = m[t] || {};
    ev.kind = t;
    ev.text = x.caption || "";
    ev.media = [{ externalId: x.id, mime: x.mime_type || "", name: x.filename || "" }];
  } else if (t === "button") {
    ev.kind = "button";
    ev.text = m.button?.text || "";
    ev.button = { payload: m.button?.payload || "", text: m.button?.text || "" };
  } else if (t === "interactive") {
    const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
    ev.kind = "button";
    ev.text = r.title || "";
    ev.button = { payload: r.id || "", text: r.title || "" };
  } else if (t === "location") {
    const l = m.location || {};
    ev.kind = "location";
    ev.text = [l.name, l.address, l.latitude != null ? `https://maps.google.com/?q=${l.latitude},${l.longitude}` : ""].filter(Boolean).join("\n");
  } else if (t === "reaction") {
    ev.kind = "other";
    ev.text = `Reacted ${m.reaction?.emoji || ""}`.trim();
    ev.replyTo = m.reaction?.message_id || ev.replyTo;
  } else if (t === "contacts") {
    ev.kind = "other";
    ev.text = (m.contacts || []).map((x) => [x.name?.formatted_name, ...(x.phones || []).map((p) => p.phone)].filter(Boolean).join(" ")).join("\n");
  } else {
    ev.kind = "other";
    ev.text = m.errors?.[0]?.title ? `(${m.errors[0].title})` : `(${t || "unsupported"} message)`;
  }
  return ev;
}

function waStatus(s, base) {
  const er = (s.errors || [])[0];
  return { ...base, type: "status", channel: "whatsapp", externalId: s.id, status: s.status, recipient: s.recipient_id, at: tsDate(s.timestamp), error: er ? [er.code, er.title, er.error_data?.details || er.message].filter(Boolean).join(" · ") : "" };
}

/* ---------- Messenger / Instagram DMs ---------- */
function dmEvent(x, base, channel, ownId) {
  const at = tsDate(x.timestamp);
  if (x.message) {
    const m = x.message;
    const echo = !!m.is_echo || (ownId && String(x.sender?.id) === String(ownId));
    const att = m.attachments || [];
    const first = att[0] || {};
    const kindOf = (t) => ({ image: "image", video: "video", audio: "audio", file: "document" }[t] || (t ? "other" : "text"));
    return {
      ...base,
      type: echo ? "echo" : "message",
      channel,
      externalId: m.mid,
      from: echo ? String(x.recipient?.id || "") : String(x.sender?.id || ""),
      contact: {},
      kind: att.length ? kindOf(first.type) : "text",
      text: m.text || (att.length && !["image", "video", "audio", "file"].includes(first.type) ? `(${first.type || "attachment"})` : ""),
      media: att.filter((a) => a.payload?.url).map((a) => ({ url: a.payload.url, mime: "", name: a.payload?.title || "" })),
      replyTo: m.reply_to?.mid || "",
      at,
    };
  }
  if (x.postback) return { ...base, type: "message", channel, externalId: x.postback.mid || `pb:${x.sender?.id}:${x.timestamp}`, from: String(x.sender?.id || ""), contact: {}, kind: "button", text: x.postback.title || "", button: { payload: x.postback.payload || "", text: x.postback.title || "" }, media: [], at };
  if (x.delivery) return (x.delivery.mids || []).map((mid) => ({ ...base, type: "status", channel, externalId: mid, status: "delivered", at }));
  if (x.read) return { ...base, type: "read", channel, from: String(x.sender?.id || ""), watermark: x.read.watermark ? tsDate(x.read.watermark) : at, externalId: x.read.mid || "", at };
  return null;
}

/* ---------- comments ---------- */
function fbComment(v, base, pageId) {
  if (v.item !== "comment") return null;
  const own = String(v.from?.id || "") === String(pageId);
  return {
    ...base,
    type: own ? "echo" : "comment",
    channel: "fb_comment",
    externalId: v.comment_id,
    from: String(v.from?.id || ""),
    contact: { name: v.from?.name || "" },
    kind: "comment",
    text: v.message || "",
    media: v.photo ? [{ url: v.photo, mime: "image/jpeg", name: "" }] : [],
    comment: { id: v.comment_id, parentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : "", postId: v.post_id, permalink: v.post?.permalink_url || "", verb: v.verb || "add" },
    at: v.created_time ? tsDate(v.created_time) : new Date(),
  };
}

function igComment(v, base, igId) {
  if (!v?.id) return null;
  const own = String(v.from?.id || "") === String(igId) || (v.from?.self_ig_scoped_id && String(v.from.self_ig_scoped_id) === String(igId));
  return {
    ...base,
    type: own ? "echo" : "comment",
    channel: "ig_comment",
    externalId: v.id,
    from: String(v.from?.id || ""),
    contact: { name: v.from?.username || "", handle: v.from?.username ? `@${v.from.username}` : "" },
    kind: "comment",
    text: v.text || "",
    media: [],
    comment: { id: v.id, parentId: v.parent_id || "", postId: v.media?.id || "", mediaType: v.media?.media_product_type || "", verb: "add" },
    at: new Date(),
  };
}

// Whole webhook body → events.
function parsePayload(body) {
  const out = [];
  const push = (e) => (Array.isArray(e) ? e.forEach(push) : e && out.push(e));
  const obj = body?.object;
  for (const entry of body?.entry || []) {
    if (obj === "whatsapp_business_account") {
      for (const ch of entry.changes || []) {
        if (ch.field !== "messages") continue;
        const v = ch.value || {};
        const base = { wabaId: String(entry.id || ""), phoneNumberId: String(v.metadata?.phone_number_id || "") };
        for (const m of v.messages || []) push(waMessage(m, base, v.contacts));
        for (const s of v.statuses || []) push(waStatus(s, base));
      }
    } else if (obj === "page") {
      const pageId = String(entry.id || "");
      const base = { pageId };
      for (const x of entry.messaging || []) push(dmEvent(x, base, "messenger", pageId));
      for (const ch of entry.changes || []) if (ch.field === "feed") push(fbComment(ch.value || {}, base, pageId));
    } else if (obj === "instagram") {
      const igId = String(entry.id || "");
      const base = { igId };
      for (const x of entry.messaging || []) push(dmEvent(x, base, "instagram", igId));
      for (const ch of entry.changes || []) if (ch.field === "comments" || ch.field === "live_comments") push(igComment(ch.value, base, igId));
      if (entry.field === "comments" && entry.value) push(igComment(entry.value, base, igId));
    }
  }
  return out;
}

module.exports = { verifySignature, parsePayload, waMessage, dmEvent, fbComment, igComment, tsDate };
