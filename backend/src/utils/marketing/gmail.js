/**
 * Gmail (Google Workspace) for the Inbox: OAuth web flow (gmail.modify + gmail.send, offline refresh token),
 * polling every 2 minutes with users.history (messages added to INBOX since the last historyId), threads, and
 * replies with In-Reply-To / References so they stay in the customer's thread.
 *   Client ID / secret: Marketing → Integrations, or env GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 *   Redirect URI: <APP_URL>/api/integrations/google/callback
 */
const Integration = require("../../models/Integration");
const { cleanEmail } = require("./phone");

const AUTH = () => process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = () => (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/+$/, "");
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "openid", "email"];
const redirectUri = () => `${require("../../config/env").APP_URL}/api/integrations/google/callback`;

const clientOf = (i) => ({ id: i?.google?.clientId || process.env.GOOGLE_CLIENT_ID || "", secret: i?.google?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "" });

function authUrl(i, state) {
  const c = clientOf(i);
  if (!c.id || !c.secret) throw new Error("Add the Google OAuth client ID and secret first");
  const u = new URL(AUTH());
  u.search = new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  return u.toString();
}

async function tokenCall(params) {
  const res = await fetch(TOKEN(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google: ${j.error_description || j.error || `HTTP ${res.status}`}`);
  return j;
}

async function exchangeCode(i, code) {
  const c = clientOf(i);
  return tokenCall({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri(), grant_type: "authorization_code" });
}

async function accessToken(i) {
  const g = i.google;
  if (g.accessToken && g.accessExpires && new Date(g.accessExpires) > new Date(Date.now() + 60000)) return g.accessToken;
  if (!g.refreshToken) throw new Error("Gmail isn't connected");
  const c = clientOf(i);
  let j;
  try {
    j = await tokenCall({ client_id: c.id, client_secret: c.secret, refresh_token: g.refreshToken, grant_type: "refresh_token" });
  } catch (e) {
    if (/invalid_grant/i.test(e.message)) await Integration.updateOne({ _id: i._id }, { $set: { "google.error": "Google access was revoked or expired — connect Gmail again" } });
    throw e;
  }
  g.accessToken = j.access_token;
  g.accessExpires = new Date(Date.now() + (j.expires_in || 3600) * 1000);
  await Integration.updateOne({ _id: i._id }, { $set: { "google.accessToken": require("../secrets").encrypt(j.access_token), "google.accessExpires": g.accessExpires } });
  return j.access_token;
}

async function api(i, method, path, { query = {}, body } = {}) {
  const tok = await accessToken(i);
  const u = new URL(`${API()}/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") (Array.isArray(v) ? v : [v]).forEach((x) => u.searchParams.append(k, String(x)));
  const res = await fetch(u, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Gmail: ${j.error?.message || `HTTP ${res.status}`}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

/* ---------- parsing ---------- */
const b64 = (s) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
function parseAddress(v) {
  const s = String(v || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: cleanEmail(m[2]) };
  return { name: "", email: cleanEmail(s) };
}
const stripHtml = (h) =>
  String(h || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function walk(part, out) {
  if (!part) return out;
  const mime = (part.mimeType || "").toLowerCase();
  if (part.filename && (part.body?.attachmentId || part.body?.data)) out.attachments.push({ name: part.filename, mime: part.mimeType, attachmentId: part.body.attachmentId, data: part.body.data, size: part.body.size || 0 });
  else if (mime === "text/plain" && part.body?.data && !out.text) out.text = b64(part.body.data).toString("utf8");
  else if (mime === "text/html" && part.body?.data && !out.html) out.html = b64(part.body.data).toString("utf8");
  for (const p of part.parts || []) walk(p, out);
  return out;
}

// Remove the quoted earlier messages from a reply ("On … wrote:" and "> " lines).
function stripQuoted(t) {
  const lines = String(t || "").split(/\r?\n/);
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^From: .+/.test(l.trim()) && lines.some((x) => /^Sent: /.test(x)));
  return (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^>/.test(l)).join("\n").trim();
}

// A Gmail message (format=full) → Inbox event. ownEmail: the connected mailbox (its own messages are echoes).
function parseMessage(msg, ownEmail = "") {
  const labels = msg.labelIds || [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("TRASH")) return null;
  const from = parseAddress(header(msg, "From"));
  const replyTo = parseAddress(header(msg, "Reply-To"));
  const body = walk(msg.payload, { text: "", html: "", attachments: [] });
  if (!body.text && !body.html && msg.payload?.body?.data) {
    const d = b64(msg.payload.body.data).toString("utf8");
    if (/html/i.test(msg.payload.mimeType || "")) body.html = d;
    else body.text = d;
  }
  const full = body.text || stripHtml(body.html);
  const own = ownEmail && from.email === cleanEmail(ownEmail);
  const subject = header(msg, "Subject");
  return {
    type: own ? "echo" : "message",
    channel: "email",
    externalId: msg.id,
    from: msg.threadId,
    contact: own ? {} : { name: from.name || from.email, email: replyTo.email || from.email },
    subject,
    kind: "email",
    text: stripQuoted(full).slice(0, 20000) || full.slice(0, 20000),
    html: body.html ? body.html.slice(0, 200000) : "",
    media: [],
    attachments: body.attachments,
    email: { messageId: header(msg, "Message-ID") || header(msg, "Message-Id"), references: header(msg, "References"), inReplyTo: header(msg, "In-Reply-To"), from: header(msg, "From"), to: header(msg, "To"), cc: header(msg, "Cc"), subject, date: header(msg, "Date") },
    at: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
  };
}

/* ---------- polling ---------- */
async function fetchAndIngest(i, id) {
  const msg = await api(i, "GET", `messages/${id}`, { query: { format: "full" } });
  const ev = parseMessage(msg, i.google.email);
  if (!ev || ev.type !== "message") return null;
  if (!(msg.labelIds || []).includes("INBOX")) return null;
  // Attachments up to 5 MB go with the message.
  const { storeMedia } = require("./media");
  for (const a of (ev.attachments || []).slice(0, 5)) {
    try {
      if (a.size > 5 * 1024 * 1024) continue;
      const data = a.data || (await api(i, "GET", `messages/${id}/attachments/${a.attachmentId}`)).data;
      ev.media.push(await storeMedia(i.organization, b64(data), { name: a.name, mime: a.mime }));
    } catch {}
  }
  delete ev.attachments;
  return require("./inbox").ingest(i.organization, ev, { integration: i });
}

async function poll(i) {
  if (!i?.google?.refreshToken || i.google.enabled === false) return { skipped: true };
  const g = i.google;
  const ids = [];
  let historyId = g.historyId;
  try {
    if (!historyId) {
      const prof = await api(i, "GET", "profile");
      historyId = prof.historyId;
      const list = await api(i, "GET", "messages", { query: { q: "in:inbox newer_than:2d -category:promotions -category:social", maxResults: 25 } });
      ids.push(...(list.messages || []).map((m) => m.id));
    } else {
      let pageToken;
      for (let p = 0; p < 10; p++) {
        const h = await api(i, "GET", "history", { query: { startHistoryId: historyId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: 100, pageToken } });
        for (const rec of h.history || []) for (const a of rec.messagesAdded || []) ids.push(a.message.id);
        if (h.historyId) historyId = h.historyId;
        pageToken = h.nextPageToken;
        if (!pageToken) break;
      }
    }
  } catch (e) {
    if (e.status === 404) {
      // historyId too old: start again from now.
      await Integration.updateOne({ _id: i._id }, { $set: { "google.historyId": "" } });
      return { reset: true };
    }
    await Integration.updateOne({ _id: i._id }, { $set: { "google.error": e.message, "google.lastPollAt": new Date() } });
    throw e;
  }
  let n = 0;
  for (const id of [...new Set(ids)]) if (await fetchAndIngest(i, id).catch((e) => console.error(`[gmail] ${e.message}`))) n++;
  await Integration.updateOne({ _id: i._id }, { $set: { "google.historyId": String(historyId || ""), "google.lastPollAt": new Date(), "google.error": "" } });
  return { added: n };
}

async function pollAll() {
  for (const i of await Integration.find({})) if (i.google?.refreshToken && i.google.enabled !== false) await poll(i).catch((e) => console.error(`[gmail] poll failed: ${e.message}`));
}

/* ---------- sending ---------- */
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
const quoteText = (t) => String(t || "").split(/\r?\n/).map((l) => `> ${l}`).join("\r\n");

function buildMime({ from, to, cc, subject, inReplyTo, references, text, html, file }) {
  const bound = `b_${Math.random().toString(36).slice(2)}`;
  const alt = `a_${Math.random().toString(36).slice(2)}`;
  const head = [`From: ${from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${encHeader(subject)}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(" ").trim()}`] : []), "MIME-Version: 1.0"];
  const textPart = `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text || "").toString("base64")}`;
  const htmlPart = html ? `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString("base64")}` : "";
  const bodyPart = htmlPart ? `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart}\r\n--${alt}\r\n${htmlPart}\r\n--${alt}--` : textPart;
  if (!file) return `${head.join("\r\n")}\r\n${bodyPart}`;
  return `${head.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${bound}"\r\n\r\n--${bound}\r\n${bodyPart}\r\n--${bound}\r\nContent-Type: ${file.mime}; name="${encHeader(file.name)}"\r\nContent-Disposition: attachment; filename="${encHeader(file.name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${file.buf.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n--${bound}--`;
}

async function sendReply(i, conv, { text, html, quote = true, file }) {
  const Message = require("../../models/Message");
  const last = (await Message.find({ conversation: conv._id, direction: "in", kind: "email" }).sort({ at: -1 }).limit(1).lean())[0];
  const em = last?.meta?.email || {};
  const to = conv.contact?.email || parseAddress(em.from).email;
  if (!to) throw new Error("No email address to reply to");
  const subj = em.subject || conv.subject || "";
  const subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
  const when = em.date || (last?.at ? new Date(last.at).toUTCString() : "");
  const full = quote && last ? `${text}\r\n\r\nOn ${when}, ${em.from || to} wrote:\r\n${quoteText(last.text)}` : text;
  const raw = buildMime({ from: i.google.email, to, subject, inReplyTo: em.messageId, references: em.references, text: full, html, file });
  const j = await api(i, "POST", "messages/send", { body: { raw: Buffer.from(raw).toString("base64url"), threadId: conv.externalId } });
  return { id: j.id || "", email: { to, subject, inReplyTo: em.messageId || "" } };
}

module.exports = { SCOPES, authUrl, exchangeCode, accessToken, api, parseMessage, parseAddress, stripQuoted, stripHtml, poll, pollAll, buildMime, sendReply, redirectUri, clientOf };
