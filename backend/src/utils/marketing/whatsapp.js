/**
 * WhatsApp Cloud API: send text / media / templates / interactive buttons, mark as read, media, templates.
 *   POST /{phone-number-id}/messages, POST /{phone-number-id}/media, GET /{media-id}, GET /{waba-id}/message_templates
 */
const { graph } = require("./graph");

const msgs = (i, body) => graph(i.meta.token, "POST", `${i.meta.phoneNumberId}/messages`, { body: { messaging_product: "whatsapp", recipient_type: "individual", ...body } });
const idOf = (j) => j?.messages?.[0]?.id || "";

async function sendText(i, to, text, { replyTo } = {}) {
  const j = await msgs(i, { to, type: "text", text: { body: String(text).slice(0, 4096), preview_url: /https?:\/\//.test(text) }, ...(replyTo ? { context: { message_id: replyTo } } : {}) });
  return idOf(j);
}

// kind: image | video | audio | document; media: { id } (uploaded) or { link }
async function sendMedia(i, to, kind, media, { caption, filename } = {}) {
  const obj = { ...media };
  if (caption && kind !== "audio") obj.caption = caption.slice(0, 1024);
  if (filename && kind === "document") obj.filename = filename;
  return idOf(await msgs(i, { to, type: kind, [kind]: obj }));
}

async function sendButtons(i, to, text, buttons) {
  return idOf(await msgs(i, { to, type: "interactive", interactive: { type: "button", body: { text: text.slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } } }));
}

/**
 * tpl: { name, language, body: [text…], header: text | { image|video|document: { link } }, urlButton: suffix,
 *        quickReplies: [payload…] (one per QUICK_REPLY button, in order) }
 */
function templateBody(tpl) {
  const components = [];
  if (tpl.header != null && tpl.header !== "") {
    if (typeof tpl.header === "string") components.push({ type: "header", parameters: [{ type: "text", text: String(tpl.header) }] });
    else {
      const [k] = Object.keys(tpl.header);
      components.push({ type: "header", parameters: [{ type: k, [k]: tpl.header[k] }] });
    }
  }
  if (tpl.body?.length) components.push({ type: "body", parameters: tpl.body.map((t) => ({ type: "text", text: String(t ?? "").slice(0, 1024) || "-" })) });
  (tpl.quickReplies || []).forEach((payload, index) => components.push({ type: "button", sub_type: "quick_reply", index: String(tpl.quickReplyIndex?.[index] ?? index), parameters: [{ type: "payload", payload: String(payload) }] }));
  if (tpl.urlButton) components.push({ type: "button", sub_type: "url", index: String(tpl.urlButtonIndex ?? 0), parameters: [{ type: "text", text: String(tpl.urlButton) }] });
  return { name: tpl.name, language: { code: tpl.language || "en" }, ...(components.length ? { components } : {}) };
}

async function sendTemplate(i, to, tpl) {
  return idOf(await msgs(i, { to, type: "template", template: templateBody(tpl) }));
}

const markRead = (i, messageId) => graph(i.meta.token, "POST", `${i.meta.phoneNumberId}/messages`, { body: { messaging_product: "whatsapp", status: "read", message_id: messageId } });

async function uploadMedia(i, buf, mime, name) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buf], { type: mime }), name || "file");
  const j = await graph(i.meta.token, "POST", `${i.meta.phoneNumberId}/media`, { form, timeout: 60000 });
  return j.id;
}

// Download a received media file: GET /{media-id} → { url, mime_type }, then GET url with the token.
async function downloadMedia(i, mediaId, maxBytes = 16 * 1024 * 1024) {
  const meta = await graph(i.meta.token, "GET", mediaId);
  if (!meta.url) throw new Error("No media URL");
  if (meta.file_size && meta.file_size > maxBytes) return { tooBig: true, mime: meta.mime_type, size: meta.file_size };
  const res = await graph(i.meta.token, "GET", meta.url, { raw: true, timeout: 60000 });
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mime: meta.mime_type || res.headers.get("content-type") || "application/octet-stream", size: buf.length };
}

// Count {{n}} placeholders in a template component's text.
const countVars = (t) => new Set((String(t || "").match(/\{\{\s*\d+\s*\}\}/g) || []).map((x) => x.replace(/\D/g, ""))).size;

async function listTemplates(i) {
  const out = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const j = await graph(i.meta.token, "GET", `${i.meta.wabaId}/message_templates`, { query: { fields: "id,name,language,status,category,components", limit: 100, after } });
    for (const t of j.data || []) {
      const comps = t.components || [];
      const body = comps.find((c) => c.type === "BODY");
      const header = comps.find((c) => c.type === "HEADER");
      const btns = comps.find((c) => c.type === "BUTTONS");
      out.push({ externalId: t.id, name: t.name, language: t.language, status: t.status, category: t.category, components: comps, bodyParams: countVars(body?.text), headerParams: header?.format === "TEXT" ? countVars(header.text) : 0, headerFormat: header?.format || "", buttons: (btns?.buttons || []).map((b) => ({ type: b.type, text: b.text, url: b.url || "" })) });
    }
    after = j.paging?.cursors?.after;
    if (!j.paging?.next || !after) break;
  }
  return out;
}

module.exports = { sendText, sendMedia, sendButtons, sendTemplate, templateBody, markRead, uploadMedia, downloadMedia, listTemplates, countVars };
