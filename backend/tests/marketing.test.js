// Inbox & marketing: webhooks, channel payloads, 24-hour window, phone matching, order updates, audiences,
// auto-replies and Gmail. No database: models are stubbed; Graph / Gmail are a local mock HTTP server.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const http = require("http");
const { Types } = require("mongoose");

const W = require("../src/utils/marketing/webhook");
const I = require("../src/utils/marketing/integration");
const phone = require("../src/utils/marketing/phone");
const inbox = require("../src/utils/marketing/inbox");
const OU = require("../src/utils/marketing/orderUpdates");
const AU = require("../src/utils/marketing/audience");
const AR = require("../src/utils/marketing/autoReply");
const G = require("../src/utils/marketing/gmail");
const wa = require("../src/utils/marketing/whatsapp");

const ORG = new Types.ObjectId("64b0000000000000000000a1");
const ORG2 = new Types.ObjectId("64b0000000000000000000a2");

// Swap static methods for a test, restoring afterwards.
function stub(obj, fns) {
  const old = {};
  for (const [k, v] of Object.entries(fns)) {
    old[k] = obj[k];
    obj[k] = v;
  }
  return () => Object.assign(obj, old);
}

// Mock HTTP server: handler(req, body) → { status, json }
async function mockServer(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", async () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null };
      calls.push(call);
      const r = (await handler(call)) || { status: 404, json: { error: { message: "not mocked" } } };
      res.writeHead(r.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}

/* ---------------- samples (from Meta's / Google's docs) ---------------- */
const WA_TEXT = { object: "whatsapp_business_account", entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" }, contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "919876543210" }], messages: [{ from: "919876543210", id: "wamid.TEXT1", timestamp: "1750091045", type: "text", text: { body: "Where is my order #201114?" } }] } }] }] };
const WA_BUTTON = { object: "whatsapp_business_account", entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" }, contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }], messages: [{ context: { from: "15550783881", id: "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=" }, from: "16505551234", id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=", timestamp: "1750091045", type: "button", button: { payload: "Unsubscribe", text: "Unsubscribe" } }] } }] }] };
const WA_IMAGE_INTERACTIVE_STATUS = { object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "106540352242922" }, contacts: [{ profile: { name: "A" }, wa_id: "919800000001" }], messages: [{ from: "919800000001", id: "wamid.IMG", timestamp: "1750091000", type: "image", image: { caption: "Damaged", mime_type: "image/jpeg", sha256: "x", id: "MEDIA123" } }, { from: "919800000001", id: "wamid.INT", timestamp: "1750091001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "COD_CONFIRM:64b0000000000000000000f1", title: "Confirm" } } }], statuses: [{ id: "wamid.OUT1", status: "read", timestamp: "1750091002", recipient_id: "919800000001" }, { id: "wamid.OUT2", status: "failed", timestamp: "1750091003", recipient_id: "919800000001", errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "Message failed to send because more than 24 hours have passed" } }] }] } }] }] };
const MESSENGER = { object: "page", entry: [{ id: "PAGE1", time: 1458692752478, messaging: [{ sender: { id: "PSID1" }, recipient: { id: "PAGE1" }, timestamp: 1458692752478, message: { mid: "m_1", text: "hello" } }, { sender: { id: "PAGE1" }, recipient: { id: "PSID1" }, timestamp: 1458692752479, message: { mid: "m_2", is_echo: true, text: "hi back" } }, { sender: { id: "PSID1" }, recipient: { id: "PAGE1" }, timestamp: 1458692752480, delivery: { mids: ["m_2"], watermark: 1458668856253 } }] }] };
const IG_DM = { object: "instagram", entry: [{ id: "IG1", time: 1569262486134, messaging: [{ sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: 1569262485349, message: { mid: "ig_m1", attachments: [{ type: "image", payload: { url: "https://cdn.example/x.jpg" } }] } }] }] };
const IG_COMMENT_CHANGES = { object: "instagram", entry: [{ id: "IG1", time: 1569262486134, changes: [{ field: "comments", value: { from: { id: "IGU1", username: "ravi" }, media: { id: "MEDIA9", media_product_type: "FEED" }, id: "C1", text: "Price?" } }] }] };
const IG_COMMENT_FLAT = { object: "instagram", entry: [{ id: "IG1", time: 1569262486134, field: "comments", value: { id: "C2", from: { id: "IGU2", username: "asha" }, text: "Nice", media: { id: "MEDIA9", media_product_type: "REELS" } } }] };
const FB_FEED = { object: "page", entry: [{ id: "PAGE1", time: 1520383571, changes: [{ field: "feed", value: { from: { id: "U1", name: "Test User" }, post: { status_type: "added_photos", is_published: true, updated_time: "2022-11-17T20:56:46+0000", permalink_url: "https://www.facebook.com/x/posts/1", promotion_status: "inactive", id: "PAGE1_POST1" }, message: "Is this available in blue?", post_id: "PAGE1_POST1", comment_id: "PAGE1_POST1_C1", created_time: 1668718604, item: "comment", parent_id: "PAGE1_POST1", verb: "add" } }] }] };

/* ---------------- signature ---------------- */
test("X-Hub-Signature-256: valid, tampered, missing and wrong secret", () => {
  const raw = Buffer.from(JSON.stringify(WA_TEXT));
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(raw).digest("hex");
  assert.equal(W.verifySignature(raw, sig, "s3cret"), true);
  assert.equal(W.verifySignature(Buffer.from(raw.toString() + " "), sig, "s3cret"), false);
  assert.equal(W.verifySignature(raw, sig, "other"), false);
  assert.equal(W.verifySignature(raw, "", "s3cret"), false);
  assert.equal(W.verifySignature(raw, "sha1=abc", "s3cret"), false);
  assert.equal(W.verifySignature(raw, sig, ""), false);
});

/* ---------------- payloads → events ---------------- */
test("WhatsApp text and quick-reply button webhooks", () => {
  const [t] = W.parsePayload(WA_TEXT);
  assert.equal(t.type, "message");
  assert.equal(t.channel, "whatsapp");
  assert.equal(t.phoneNumberId, "106540352242922");
  assert.equal(t.from, "919876543210");
  assert.equal(t.contact.name, "Sheena Nelson");
  assert.equal(t.text, "Where is my order #201114?");
  assert.equal(t.at.toISOString(), new Date(1750091045 * 1000).toISOString());
  const [b] = W.parsePayload(WA_BUTTON);
  assert.equal(b.kind, "button");
  assert.deepEqual(b.button, { payload: "Unsubscribe", text: "Unsubscribe" });
  assert.equal(b.replyTo, "wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=");
});

test("WhatsApp image, interactive button reply and statuses (read / failed with error)", () => {
  const evs = W.parsePayload(WA_IMAGE_INTERACTIVE_STATUS);
  const img = evs.find((e) => e.externalId === "wamid.IMG");
  assert.equal(img.kind, "image");
  assert.equal(img.text, "Damaged");
  assert.deepEqual(img.media, [{ externalId: "MEDIA123", mime: "image/jpeg", name: "" }]);
  const btn = evs.find((e) => e.externalId === "wamid.INT");
  assert.equal(btn.button.payload, "COD_CONFIRM:64b0000000000000000000f1");
  const read = evs.find((e) => e.externalId === "wamid.OUT1");
  assert.equal(read.type, "status");
  assert.equal(read.status, "read");
  const failed = evs.find((e) => e.externalId === "wamid.OUT2");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /131047/);
  assert.equal(failed.wabaId, "WABA1");
});

test("Messenger message, echo and delivery", () => {
  const evs = W.parsePayload(MESSENGER);
  assert.equal(evs.length, 3);
  assert.deepEqual([evs[0].type, evs[0].channel, evs[0].from, evs[0].text, evs[0].pageId], ["message", "messenger", "PSID1", "hello", "PAGE1"]);
  assert.deepEqual([evs[1].type, evs[1].from], ["echo", "PSID1"], "echo belongs to the customer's thread");
  assert.deepEqual([evs[2].type, evs[2].externalId, evs[2].status], ["status", "m_2", "delivered"]);
});

test("Instagram DM attachment and comments (both payload shapes); Facebook feed comment", () => {
  const [dm] = W.parsePayload(IG_DM);
  assert.equal(dm.channel, "instagram");
  assert.equal(dm.igId, "IG1");
  assert.equal(dm.kind, "image");
  assert.equal(dm.media[0].url, "https://cdn.example/x.jpg");
  const [c1] = W.parsePayload(IG_COMMENT_CHANGES);
  assert.deepEqual([c1.type, c1.channel, c1.externalId, c1.comment.postId, c1.contact.handle], ["comment", "ig_comment", "C1", "MEDIA9", "@ravi"]);
  const [c2] = W.parsePayload(IG_COMMENT_FLAT);
  assert.equal(c2.externalId, "C2");
  const [f] = W.parsePayload(FB_FEED);
  assert.deepEqual([f.type, f.channel, f.externalId, f.comment.postId, f.comment.parentId, f.comment.permalink, f.text], ["comment", "fb_comment", "PAGE1_POST1_C1", "PAGE1_POST1", "", "https://www.facebook.com/x/posts/1", "Is this available in blue?"]);
  // The Page's own comment is an echo.
  const own = W.parsePayload({ object: "page", entry: [{ id: "PAGE1", changes: [{ field: "feed", value: { ...FB_FEED.entry[0].changes[0].value, from: { id: "PAGE1", name: "Shop" }, comment_id: "PAGE1_POST1_C2", parent_id: "PAGE1_POST1_C1" } }] }] })[0];
  assert.equal(own.type, "echo");
  assert.equal(own.comment.parentId, "PAGE1_POST1_C1");
});

test("conversation keys: DM by sender, comments by post + commenter", () => {
  assert.equal(inbox.keyOf(W.parsePayload(WA_TEXT)[0]), "919876543210");
  assert.equal(inbox.keyOf(W.parsePayload(IG_COMMENT_CHANGES)[0]), "MEDIA9:IGU1");
  assert.equal(inbox.keyOf(W.parsePayload(FB_FEED)[0]), "PAGE1_POST1:U1");
});

/* ---------------- routing ---------------- */
test("events are routed to the company by phone number ID, WABA, Page or IG account", () => {
  const r = { byPhone: new Map([["106540352242922", "A"]]), byWaba: new Map([["WABA9", "B"]]), byPage: new Map([["PAGE1", "C"]]), byIg: new Map([["IG1", "D"]]) };
  assert.equal(I.orgForEvent(r, { phoneNumberId: "106540352242922" }), "A");
  assert.equal(I.orgForEvent(r, { phoneNumberId: "999", wabaId: "WABA9" }), "B");
  assert.equal(I.orgForEvent(r, { pageId: "PAGE1" }), "C");
  assert.equal(I.orgForEvent(r, { igId: "IG1" }), "D");
  assert.equal(I.orgForEvent(r, { pageId: "IG1" }), "D", "IG messaging over the Page");
  assert.equal(I.orgForEvent(r, { pageId: "nope" }), null);
});

test("webhook POST: accepted only with the owning company's App Secret; other companies' events are dropped", async () => {
  const Integration = require("../src/models/Integration");
  const docs = [Integration.hydrate({ _id: new Types.ObjectId(), organization: ORG, meta: { appSecret: "secretA", phoneNumberId: "106540352242922", verifyToken: "vt" } }), Integration.hydrate({ _id: new Types.ObjectId(), organization: ORG2, meta: { appSecret: "secretB", pageId: "PAGE1" } })];
  const restore = stub(Integration, { find: async () => docs, findOne: async (q) => docs.find((d) => String(d.organization) === String(q.organization)) });
  I.forgetRoutes();
  const { accept } = require("../src/routes/metaWebhook");
  try {
    const raw = Buffer.from(JSON.stringify(WA_TEXT));
    const good = "sha256=" + crypto.createHmac("sha256", "secretA").update(raw).digest("hex");
    const r1 = await accept(raw, good);
    assert.equal(r1.status, 200);
    assert.equal(r1.groups.length, 1);
    assert.equal(String(r1.groups[0].org), String(ORG));
    const bad = "sha256=" + crypto.createHmac("sha256", "secretB").update(raw).digest("hex");
    const r2 = await accept(raw, bad);
    assert.equal(r2.status, 401);
    assert.equal(r2.groups.length, 0);
    const raw2 = Buffer.from(JSON.stringify(MESSENGER));
    const r3 = await accept(raw2, "sha256=" + crypto.createHmac("sha256", "secretB").update(raw2).digest("hex"));
    assert.equal(String(r3.groups[0].org), String(ORG2));
    assert.equal((await accept(Buffer.from("not json"), good)).status, 400);
  } finally {
    restore();
    I.forgetRoutes();
  }
});

/* ---------------- 24-hour window ---------------- */
test("24-hour service window", () => {
  const t = new Date("2026-11-09T10:00:00Z");
  assert.equal(inbox.windowEnd("whatsapp", t).toISOString(), "2026-11-10T10:00:00.000Z");
  assert.equal(inbox.windowEnd("email", t), null);
  assert.equal(inbox.windowEnd("fb_comment", t), null);
  const conv = { channel: "whatsapp", windowEndsAt: inbox.windowEnd("whatsapp", t) };
  assert.equal(inbox.inWindow(conv, new Date("2026-11-10T09:59:00Z")), true);
  assert.equal(inbox.inWindow(conv, new Date("2026-11-10T10:00:01Z")), false);
  assert.equal(inbox.inWindow({ channel: "whatsapp" }), false, "never messaged us: template only");
  assert.equal(inbox.inWindow({ channel: "email" }), true);
  assert.equal(inbox.inWindow({ channel: "ig_comment" }), true);
});

test("outside the window a WhatsApp free-form reply is refused (template needed); nothing is sent", async () => {
  const Integration = require("../src/models/Integration");
  const Message = require("../src/models/Message");
  const Conversation = require("../src/models/Conversation");
  const integ = Integration.hydrate({ _id: new Types.ObjectId(), organization: ORG, meta: { token: "T", phoneNumberId: "PN1", whatsapp: true } });
  const saved = [];
  const r1 = stub(Integration, { findOne: async () => integ });
  const r2 = stub(Message.prototype, { save: async function () { saved.push(this); return this; } });
  const r3 = stub(Conversation, { updateOne: async () => ({}) });
  try {
    const conv = { _id: new Types.ObjectId(), channel: "whatsapp", externalId: "919800000001", windowEndsAt: new Date(Date.now() - 1000) };
    const m = await inbox.sendReply(ORG, conv, { text: "hi" });
    assert.equal(m.status, "failed");
    assert.match(m.error, /template/);
    assert.equal(saved.length, 1);
  } finally {
    r1();
    r2();
    r3();
  }
});

/* ---------------- ingest (upsert + idempotency) ---------------- */
test("an incoming WhatsApp message creates the conversation once, opens the window and counts unread; repeats are ignored", async () => {
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Integration = require("../src/models/Integration");
  const convs = [];
  const msgs = [];
  const updates = [];
  const restore = [
    stub(Conversation, {
      findOne: async (q) => convs.find((c) => c.channel === q.channel && c.externalId === q.externalId) || null,
      create: async (d) => (convs.push({ _id: new Types.ObjectId(), ...d }), convs[convs.length - 1]),
      updateOne: async (q, u) => updates.push(u),
      findById: async () => null,
    }),
    stub(Message, { findOne: (q) => ({ lean: async () => msgs.find((m) => m.externalId === q.externalId) || null }), create: async (d) => (msgs.push({ _id: new Types.ObjectId(), ...d }), msgs[msgs.length - 1]) }),
    stub(Integration, { findOne: async () => null }),
  ];
  try {
    const ev = W.parsePayload(WA_TEXT)[0];
    const m = await inbox.ingest(ORG, ev, { integration: Integration.hydrate({ organization: ORG, meta: {} }) });
    assert.ok(m);
    assert.equal(convs.length, 1);
    assert.equal(convs[0].contact.phone, "919876543210");
    assert.equal(convs[0].contact.name, "Sheena Nelson");
    const u = updates.find((x) => x.$inc);
    assert.equal(u.$inc.unread, 1);
    assert.equal(u.$set.windowEndsAt.toISOString(), new Date(ev.at.getTime() + 86400000).toISOString());
    assert.equal(u.$set.lastMessagePreview, "Where is my order #201114?");
    assert.equal(await inbox.ingest(ORG, ev), null, "same wamid again: ignored");
    assert.equal(msgs.length, 1);
    // A comment and a Messenger DM become their own conversations.
    await inbox.ingest(ORG, W.parsePayload(FB_FEED)[0], { integration: Integration.hydrate({ organization: ORG, meta: {} }) });
    await inbox.ingest(ORG, W.parsePayload(MESSENGER)[0], { integration: Integration.hydrate({ organization: ORG, meta: {} }) });
    assert.deepEqual(convs.map((c) => c.channel), ["whatsapp", "fb_comment", "messenger"]);
    assert.equal(convs[1].post.permalink, "https://www.facebook.com/x/posts/1");
    assert.equal(msgs[1].kind, "comment");
  } finally {
    restore.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 20)); // let background work finish
  }
});

/* ---------------- phone matching ---------------- */
test("phone matching on the last 10 digits; WhatsApp numbers get 91", () => {
  assert.equal(phone.last10("+91 98765-43210"), "9876543210");
  assert.equal(phone.last10("09876543210"), "9876543210");
  assert.equal(phone.last10("12345"), "");
  assert.equal(phone.toWa("9876543210"), "919876543210");
  assert.equal(phone.toWa("09876543210"), "919876543210");
  assert.equal(phone.toWa("+91 98765 43210"), "919876543210");
  assert.equal(phone.toWa("+1 650 555 1234"), "16505551234");
  assert.equal(phone.toWa("123"), "");
  assert.equal(phone.samePhone("919876543210", "+91-98765 43210"), true);
  assert.equal(phone.cleanEmail("Ravi <RAVI@Example.com>"), "ravi@example.com");
  const { orderMatches } = require("../src/utils/marketing/match");
  const o = { customer: { phone: "", email: "Ravi@example.com" }, shippingAddress: { phone: "098765 43210" } };
  assert.equal(orderMatches(o, { phone: "919876543210" }), true);
  assert.equal(orderMatches(o, { email: "ravi@example.com" }), true);
  assert.equal(orderMatches(o, { phone: "919876543211" }), false);
});

/* ---------------- order updates ---------------- */
const now = Date.parse("2026-11-09T10:00:00Z");
const ord = (x = {}) => ({ _id: new Types.ObjectId(), organization: ORG, name: "#201114", orderNumber: 201114, orderDate: new Date(now - 3600000), status: "new", paymentMode: "cod", total: 1499, codAmount: 1499, customer: { name: "Ravi Kumar", phone: "+91 98765 43210" }, shippingAddress: {}, shipment: {}, ...x });

test("order-update events: new orders (recent only), COD confirmation, shipped (booked or picked), out for delivery, delivered, RTO", () => {
  assert.deepEqual(OU.eventsFor({ isNew: true }, ord(), { now }), ["order_placed", "cod_confirmation"]);
  assert.deepEqual(OU.eventsFor({ isNew: true }, ord({ paymentMode: "prepaid" }), { now }), ["order_placed"]);
  assert.deepEqual(OU.eventsFor({ isNew: true }, ord({ orderDate: new Date(now - 5 * 86400000) }), { now }), [], "first sync of old orders: nothing");
  assert.deepEqual(OU.eventsFor({ isNew: true }, ord({ status: "shipped" }), { now }), []);
  assert.deepEqual(OU.eventsFor({ isNew: true }, ord({ channel: "amazon" }), { now }), [], "never Amazon buyers");
  const booked = ord({ status: "ready_to_ship", shipment: { awb: "123" } });
  assert.deepEqual(OU.eventsFor({ prevStatus: "packed", status: "ready_to_ship" }, booked, { shippedOn: "booked", now }), ["shipped"]);
  assert.deepEqual(OU.eventsFor({ prevStatus: "packed", status: "ready_to_ship" }, booked, { shippedOn: "picked", now }), []);
  assert.deepEqual(OU.eventsFor({ prevStatus: "ready_to_ship", status: "shipped" }, ord({ status: "shipped" }), { shippedOn: "picked", now }), ["shipped"]);
  assert.deepEqual(OU.eventsFor({ prevStatus: "ready_to_ship", status: "shipped" }, ord({ status: "shipped" }), { shippedOn: "booked", now }), [], "already sent at booking");
  assert.deepEqual(OU.eventsFor({ prevStatus: "new", status: "shipped" }, ord({ status: "shipped" }), { shippedOn: "booked", now }), ["shipped"], "fulfilled in Shopify directly");
  assert.deepEqual(OU.eventsFor({ prevStatus: "shipped", status: "shipped", prevTrack: "in_transit", track: "out_for_delivery" }, ord({ status: "shipped" }), { now }), ["out_for_delivery"]);
  assert.deepEqual(OU.eventsFor({ prevStatus: "shipped", status: "delivered" }, ord({ status: "delivered" }), { now }), ["delivered"]);
  assert.deepEqual(OU.eventsFor({ prevStatus: "shipped", status: "rto" }, ord({ status: "rto" }), { now }), ["rto"]);
  assert.deepEqual(OU.eventsFor({ prevStatus: "shipped", status: "delivered" }, ord({ status: "delivered", orderDate: new Date(now - 40 * 86400000) }), { now }), [], "old orders are left alone");
});

test("order-update variables", () => {
  const v = OU.varsOf(ord({ shipment: { courierName: "Delhivery", awb: "AWB1", trackingUrl: "https://t/AWB1" } }), "Metal Table");
  assert.equal(v.customer_name, "Ravi");
  assert.equal(v.order_no, "#201114");
  assert.equal(v.amount, "₹1,499");
  assert.equal(v.payment_mode, "Cash on Delivery");
  assert.deepEqual([v.courier, v.awb, v.tracking_url, v.store_name], ["Delhivery", "AWB1", "https://t/AWB1", "Metal Table"]);
});

test("COD template: Confirm / Cancel payloads go on the quick-reply buttons", () => {
  const b = wa.templateBody({ name: "cod_confirm", language: "en", body: ["Ravi", "#1", "₹10"], quickReplies: ["COD_CONFIRM:x", "COD_CANCEL:x"], quickReplyIndex: [0, 1], urlButton: "AWB1", urlButtonIndex: 2 });
  assert.deepEqual(b.language, { code: "en" });
  assert.deepEqual(b.components[0], { type: "body", parameters: [{ type: "text", text: "Ravi" }, { type: "text", text: "#1" }, { type: "text", text: "₹10" }] });
  assert.deepEqual(b.components[1], { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "COD_CONFIRM:x" }] });
  assert.equal(b.components[2].index, "1");
  assert.deepEqual(b.components[3], { type: "button", sub_type: "url", index: "2", parameters: [{ type: "text", text: "AWB1" }] });
  assert.deepEqual(OU.parseCodPayload("COD_CANCEL:64b0000000000000000000f1"), { action: "cancel_requested", orderId: "64b0000000000000000000f1" });
  assert.equal(OU.parseCodPayload("COD_CANCEL:nope"), null);
});

test("dispatch: sends the template once; skips with no phone, opted out, already sent", async () => {
  const srv = await mockServer((c) => (c.method === "POST" && /\/PN1\/messages$/.test(c.url) ? { json: { messaging_product: "whatsapp", contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.OUT.${c.body.to}` }] } } : null));
  process.env.META_GRAPH_BASE = srv.url;
  const MC = require("../src/models/MarketingConfig");
  const Integration = require("../src/models/Integration");
  const ShopifyStore = require("../src/models/ShopifyStore");
  const OrderMessage = require("../src/models/OrderMessage");
  const OptOut = require("../src/models/OptOut");
  const WaTemplate = require("../src/models/WaTemplate");
  const Organization = require("../src/models/Organization");
  const logs = [];
  const cfg = MC.hydrate({ _id: new Types.ObjectId(), organization: ORG, orderUpdates: { cod_confirmation: { enabled: true, template: "cod_confirm", language: "en", params: ["customer_name", "order_no", "cod_amount"] } } });
  const lean = (v) => ({ lean: async () => v });
  const restore = [
    stub(MC, { findOne: async () => cfg }),
    stub(Integration, { findOne: async () => Integration.hydrate({ organization: ORG, meta: { token: "T", phoneNumberId: "PN1", whatsapp: true } }) }),
    stub(ShopifyStore, { findOne: () => lean({ sharedWith: [] }) }),
    stub(OrderMessage, { find: () => lean(logs.filter((l) => l.status !== "x")), create: async (d) => (logs.push(d), d) }),
    stub(OptOut, { exists: async (q) => q.value === "9999999999" }),
    stub(WaTemplate, { findOne: () => lean({ buttons: [{ type: "QUICK_REPLY", text: "Confirm" }, { type: "QUICK_REPLY", text: "Cancel" }] }) }),
    stub(Organization, { findById: () => lean({ name: "Metal Table" }) }),
    stub(inbox, { recordOutgoing: async () => ({}) }),
  ];
  try {
    const o = ord();
    const r = await OU.dispatch(o, "cod_confirmation");
    assert.equal(r.sent, "wamid.OUT.919876543210");
    const sent = srv.calls[0].body;
    assert.equal(sent.type, "template");
    assert.equal(sent.to, "919876543210");
    assert.equal(sent.template.name, "cod_confirm");
    assert.deepEqual(sent.template.components[0].parameters.map((p) => p.text), ["Ravi", "#201114", "₹1,499"]);
    assert.equal(sent.template.components[1].parameters[0].payload, `COD_CONFIRM:${o._id}`);
    assert.equal(logs[0].status, "sent");
    assert.deepEqual(await OU.dispatch(o, "cod_confirmation"), { skipped: "already sent" });
    logs.length = 0;
    assert.deepEqual(await OU.dispatch(ord({ customer: { name: "X" }, shippingAddress: {} }), "cod_confirmation"), { skipped: "no phone" });
    assert.equal(logs[0].status, "skipped");
    logs.length = 0;
    assert.deepEqual(await OU.dispatch(ord({ customer: { phone: "9999999999" } }), "cod_confirmation"), { skipped: "opted out" });
    assert.deepEqual(await OU.dispatch(ord(), "delivered"), { skipped: "not set up" }, "event switched off");
    assert.equal(srv.calls.length, 1);
  } finally {
    restore.forEach((r) => r());
    delete process.env.META_GRAPH_BASE;
    await srv.close();
  }
});

/* ---------------- audiences ---------------- */
test("audience filters, consent and opt-outs", () => {
  const day = 86400000;
  const orders = [
    { channel: "shopify", status: "delivered", orderDate: new Date(now - 10 * day), total: 2000, paymentMode: "cod", tags: ["VIP"], customer: { name: "Ravi Kumar", phone: "+919876543210", email: "ravi@x.com" }, shippingAddress: { state: "27", city: "Pune" }, lines: [{ sku: "TBL-1", title: "Metal Table" }] },
    { channel: "shopify", status: "delivered", orderDate: new Date(now - 100 * day), total: 500, paymentMode: "prepaid", customer: { name: "Ravi", phone: "09876543210" }, shippingAddress: { state: "27", city: "pune" }, lines: [{ sku: "CHR-1", title: "Chair" }] },
    { channel: "shopify", status: "delivered", orderDate: new Date(now - 200 * day), total: 900, paymentMode: "prepaid", customer: { name: "Asha", phone: "9811111111", email: "asha@x.com" }, shippingAddress: { state: "07", city: "Delhi" }, lines: [{ sku: "CHR-1", title: "Chair" }] },
    { channel: "amazon", status: "delivered", orderDate: new Date(now - 1 * day), total: 900, customer: { name: "Amazon buyer", phone: "9822222222" }, shippingAddress: {}, lines: [] },
    { channel: "shopify", status: "cancelled", orderDate: new Date(now - 1 * day), total: 900, customer: { name: "Cancelled", phone: "9833333333" }, shippingAddress: {}, lines: [] },
  ];
  const cs = AU.contactsFromOrders(orders, "whatsapp");
  assert.equal(cs.length, 2, "Amazon and cancelled orders don't count; Ravi's two orders merge");
  const ravi = cs.find((c) => c.phone10 === "9876543210");
  assert.deepEqual([ravi.orders, ravi.spend, ravi.to], [2, 2500, "919876543210"]);
  const m = (a) => cs.filter((c) => AU.matches(c, a, now)).map((c) => c.name);
  assert.deepEqual(m({ lastDays: 30 }), ["Ravi Kumar"]);
  assert.deepEqual(m({ notSinceDays: 90 }), ["Asha"]);
  assert.deepEqual(m({ states: ["07"] }), ["Asha"]);
  assert.deepEqual(m({ cities: ["PUNE"] }), ["Ravi Kumar"]);
  assert.deepEqual(m({ skus: ["chr-1"] }).length, 2);
  assert.deepEqual(m({ products: ["metal"] }), ["Ravi Kumar"]);
  assert.deepEqual(m({ payment: "cod" }), ["Ravi Kumar"]);
  assert.deepEqual(m({ minOrders: 2 }), ["Ravi Kumar"]);
  assert.deepEqual(m({ minSpend: 1000 }), ["Ravi Kumar"]);
  assert.deepEqual(m({ maxSpend: 1000 }), ["Asha"]);
  assert.deepEqual(m({ tags: ["vip"] }), ["Ravi Kumar"]);
  const consents = { byPhone: new Map([["9876543210", { smsState: "SUBSCRIBED" }], ["9811111111", { smsState: "UNSUBSCRIBED" }]]), byEmail: new Map() };
  const none = { whatsapp: new Set(), email: new Set() };
  assert.equal(AU.allowed(ravi, "whatsapp", { consent: "subscribed", consents, optOuts: none }).ok, true);
  const asha = cs.find((c) => c.name === "Asha");
  assert.equal(AU.allowed(asha, "whatsapp", { consent: "any", consents, optOuts: none }).ok, false, "unsubscribed in Shopify");
  assert.equal(AU.allowed(ravi, "whatsapp", { consent: "subscribed", consents, optOuts: { whatsapp: new Set(["9876543210"]), email: new Set() } }).why, "opted out");
  const noRecord = { ...ravi, phone10: "9000000000" };
  assert.equal(AU.allowed(noRecord, "whatsapp", { consent: "subscribed", consents, optOuts: none }).ok, false);
  assert.equal(AU.allowed(noRecord, "whatsapp", { consent: "any", consents, optOuts: none }).ok, true);
  const em = AU.contactsFromOrders(orders, "email");
  assert.deepEqual(em.map((c) => c.to).sort(), ["asha@x.com", "ravi@x.com"]);
});

test("campaign placeholders, WhatsApp tier limits, unsubscribe tokens", () => {
  const C = require("../src/utils/marketing/campaigns");
  assert.equal(C.fill("Hi {{name}}, {{ missing }}!", { name: "Ravi" }), "Hi Ravi, !");
  assert.equal(C.tierLimit("TIER_1K"), 1000);
  assert.equal(C.tierLimit("TIER_UNLIMITED"), Infinity);
  assert.equal(C.tierLimit(""), 250);
  const O = require("../src/utils/marketing/optout");
  const tok = O.unsubscribeToken(String(ORG), "Ravi@X.com");
  assert.deepEqual(O.readUnsubscribeToken(tok), { org: String(ORG), email: "ravi@x.com" });
  assert.equal(O.readUnsubscribeToken(tok.slice(0, -2) + "xx"), null);
  assert.equal(O.norm("whatsapp", "+91 98765 43210"), "9876543210");
});

/* ---------------- auto-replies ---------------- */
test("auto-reply throttling: once per 10 minutes, and not while a person is handling the chat", () => {
  const t = Date.parse("2026-11-09T10:00:00Z");
  assert.equal(AR.blockedReason({}, t), "");
  assert.equal(AR.blockedReason({ lastAutoReplyAt: new Date(t - 9 * 60000) }, t), "throttled");
  assert.equal(AR.blockedReason({ lastAutoReplyAt: new Date(t - 11 * 60000) }, t), "");
  assert.equal(AR.blockedReason({ humanRepliedAt: new Date(t - 3600000) }, t), "human");
  assert.equal(AR.blockedReason({ humanRepliedAt: new Date(t - 13 * 3600000) }, t), "");
});

test("keyword rules, business hours (IST) and order-status questions", () => {
  const r = { active: true, channels: ["whatsapp"], match: "contains", keywords: ["price", "kitna"], hours: "any" };
  assert.equal(AR.ruleMatches(r, "What's the PRICE of this?", "whatsapp", true), true);
  assert.equal(AR.ruleMatches(r, "priceless", "whatsapp", true), false, "whole words");
  assert.equal(AR.ruleMatches(r, "price?", "instagram", true), false, "other channel");
  assert.equal(AR.ruleMatches({ ...r, match: "exact", keywords: ["hi"] }, "Hi!", "whatsapp", true), true);
  assert.equal(AR.ruleMatches({ ...r, match: "exact", keywords: ["hi"] }, "hi there", "whatsapp", true), false);
  assert.equal(AR.ruleMatches({ ...r, hours: "closed" }, "price", "whatsapp", true), false);
  assert.equal(AR.ruleMatches({ ...r, active: false }, "price", "whatsapp", true), false);
  const hours = { enabled: true, days: [{ day: 1, open: "10:00", close: "19:00" }] };
  assert.equal(AR.isOpen(hours, new Date("2026-11-09T04:30:00Z")), true, "Monday 10:00 IST");
  assert.equal(AR.isOpen(hours, new Date("2026-11-09T04:29:00Z")), false, "Monday 09:59 IST");
  assert.equal(AR.isOpen(hours, new Date("2026-11-09T13:30:00Z")), false, "Monday 19:00 IST");
  assert.equal(AR.isOpen(hours, new Date("2026-11-08T06:00:00Z")), false, "Sunday");
  assert.equal(AR.isOpen({ enabled: false }), true);
  assert.equal(AR.looksLikeOrderQuery("Where is my order?"), true);
  assert.equal(AR.looksLikeOrderQuery("mera parcel kab aayega"), true);
  assert.equal(AR.looksLikeOrderQuery("#201114"), true);
  assert.equal(AR.looksLikeOrderQuery("do you have blue colour"), false);
});

test("auto-reply handler: rule reply once, then throttled; stops after a human reply", async () => {
  const AutoReplyRule = require("../src/models/AutoReplyRule");
  const sent = [];
  const restore = [stub(AutoReplyRule, { find: () => ({ lean: async () => [{ active: true, channels: [], match: "contains", keywords: ["price"], hours: "any", reply: { kind: "text", text: "Prices are on our website" } }] }) }), stub(inbox, { sendReply: async (org, conv, o) => (sent.push(o), o) })];
  const cfg = { businessHours: { enabled: false }, away: { enabled: false }, orderStatusReply: { enabled: false }, ai: { enabled: false } };
  try {
    const conv = { _id: new Types.ObjectId(), channel: "whatsapp", contact: {} };
    await AR.handle(ORG, conv, { direction: "in", text: "price please" }, { cfg });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "Prices are on our website");
    assert.equal(sent[0].auto, "rule");
    await AR.handle(ORG, { ...conv, lastAutoReplyAt: new Date() }, { direction: "in", text: "price?" }, { cfg });
    await AR.handle(ORG, { ...conv, humanRepliedAt: new Date() }, { direction: "in", text: "price?" }, { cfg });
    assert.equal(sent.length, 1);
  } finally {
    restore.forEach((r) => r());
  }
});

test("AI prompt carries the orders and the thread", () => {
  const p = require("../src/utils/marketing/ai").buildPrompt({ orgName: "Metal Table", channel: "whatsapp", contactName: "Ravi", messages: [{ direction: "in", text: "where is it" }], orders: [{ name: "#1", total: 999, paymentMode: "cod", status: "shipped", orderDate: new Date(), shipment: { courierName: "DTDC", awb: "D1" }, lines: [{ quantity: 1, title: "Stool" }] }] });
  assert.match(p, /#1 .*₹999 COD, status shipped, DTDC AWB D1/);
  assert.match(p, /Customer: where is it/);
});

/* ---------------- Gmail ---------------- */
const b64u = (s) => Buffer.from(s).toString("base64url");
const GMAIL_MSG = {
  id: "18c1",
  threadId: "18c0",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: "1762682400000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: '"Ravi Kumar" <Ravi@Example.com>' }, { name: "To", value: "help@ordexago.com" }, { name: "Subject", value: "Re: Order #201114" }, { name: "Message-ID", value: "<CAB123@mail.gmail.com>" }, { name: "References", value: "<OLD1@x>" }, { name: "Date", value: "Sun, 9 Nov 2026 10:00:00 +0000" }],
    parts: [
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64u("Please send the invoice.\n\nOn Sat, 8 Nov 2026, Help <help@ordexago.com> wrote:\n> Your order has shipped") } }, { mimeType: "text/html", body: { data: b64u("<p>Please send the invoice.</p>") } }] },
      { mimeType: "application/pdf", filename: "photo.pdf", body: { attachmentId: "ATT1", size: 1200 } },
    ],
  },
};

test("Gmail message parsing: sender, thread, headers, quoted text removed, attachments", () => {
  const ev = G.parseMessage(GMAIL_MSG, "help@ordexago.com");
  assert.equal(ev.type, "message");
  assert.equal(ev.channel, "email");
  assert.equal(ev.from, "18c0", "conversation = Gmail thread");
  assert.equal(ev.externalId, "18c1");
  assert.deepEqual(ev.contact, { name: "Ravi Kumar", email: "ravi@example.com" });
  assert.equal(ev.text, "Please send the invoice.");
  assert.equal(ev.email.messageId, "<CAB123@mail.gmail.com>");
  assert.equal(ev.attachments[0].attachmentId, "ATT1");
  assert.equal(ev.at.toISOString(), new Date(1762682400000).toISOString());
  const own = G.parseMessage({ ...GMAIL_MSG, payload: { ...GMAIL_MSG.payload, headers: [{ name: "From", value: "OrdexaGo <help@ordexago.com>" }] } }, "help@ordexago.com");
  assert.equal(own.type, "echo");
  assert.equal(G.parseMessage({ ...GMAIL_MSG, labelIds: ["SPAM"] }), null);
  assert.equal(G.stripHtml("<p>Hi&nbsp;<b>there</b></p><br>x"), "Hi there\n\nx".replace("\n\n", "\n\n"));
});

test("Gmail reply MIME keeps the thread (In-Reply-To / References) and encodes the subject", () => {
  const raw = G.buildMime({ from: "help@ordexago.com", to: "ravi@example.com", subject: "Re: ऑर्डर", inReplyTo: "<CAB123@mail.gmail.com>", references: "<OLD1@x>", text: "Here you go" });
  assert.match(raw, /In-Reply-To: <CAB123@mail\.gmail\.com>/);
  assert.match(raw, /References: <OLD1@x> <CAB123@mail\.gmail\.com>/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, new RegExp(Buffer.from("Here you go").toString("base64")));
});

test("Gmail polling: history since the last historyId; new INBOX messages are ingested", async () => {
  const srv = await mockServer((c) => {
    if (c.url.startsWith("/token")) return { json: { access_token: "AT", expires_in: 3600 } };
    if (c.url.startsWith("/gmail/v1/users/me/history")) return { json: { history: [{ messagesAdded: [{ message: { id: "18c1", threadId: "18c0", labelIds: ["INBOX"] } }] }], historyId: "999" } };
    if (c.url.startsWith("/gmail/v1/users/me/messages/18c1/attachments/ATT1")) return { json: { data: b64u("%PDF-1.4") } };
    if (c.url.startsWith("/gmail/v1/users/me/messages/18c1")) return { json: GMAIL_MSG };
    return null;
  });
  process.env.GMAIL_API_BASE = srv.url;
  process.env.GOOGLE_TOKEN_URL = `${srv.url}/token`;
  const Integration = require("../src/models/Integration");
  const media = require("../src/utils/marketing/media");
  const sets = [];
  const ingested = [];
  const restore = [stub(Integration, { updateOne: async (q, u) => sets.push(u.$set) }), stub(inbox, { ingest: async (org, ev) => (ingested.push(ev), {}) }), stub(media, { storeMedia: async (org, buf, o) => ({ fileId: "F1", url: "/api/inbox/media/F1", size: buf.length, ...o }) })];
  try {
    const i = Integration.hydrate({ _id: new Types.ObjectId(), organization: ORG, google: { clientId: "cid", clientSecret: "cs", refreshToken: "RT", historyId: "100", email: "help@ordexago.com" } });
    const r = await G.poll(i);
    assert.deepEqual(r, { added: 1 });
    const h = srv.calls.find((c) => c.url.includes("/history"));
    assert.match(h.url, /startHistoryId=100/);
    assert.match(h.url, /labelId=INBOX/);
    assert.equal(h.headers.authorization, "Bearer AT");
    assert.equal(ingested[0].text, "Please send the invoice.");
    assert.equal(ingested[0].media[0].name, "photo.pdf");
    assert.equal(sets.at(-1)["google.historyId"], "999");
  } finally {
    restore.forEach((r) => r());
    delete process.env.GMAIL_API_BASE;
    delete process.env.GOOGLE_TOKEN_URL;
    await srv.close();
  }
});

test("Gmail OAuth URL asks for offline gmail.modify + gmail.send", () => {
  const u = new URL(G.authUrl({ google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "x" } }, "STATE"));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.match(u.searchParams.get("scope"), /gmail\.modify/);
  assert.match(u.searchParams.get("scope"), /gmail\.send/);
  assert.match(u.searchParams.get("redirect_uri"), /\/api\/integrations\/google\/callback$/);
  assert.equal(u.searchParams.get("state"), "STATE");
});

/* ---------------- Graph errors ---------------- */
test("Graph errors are explained; rate limits are retryable", async () => {
  const srv = await mockServer(() => ({ status: 400, json: { error: { message: "(#131047) Re-engagement message", type: "OAuthException", code: 131047, fbtrace_id: "x" } } }));
  process.env.META_GRAPH_BASE = srv.url;
  try {
    await assert.rejects(wa.sendText({ meta: { token: "T", phoneNumberId: "PN" } }, "91", "hi"), /24 hours/);
    const { retryable, GraphError } = require("../src/utils/marketing/graph");
    assert.equal(retryable(new GraphError("x", { code: 130429 })), true);
    assert.equal(retryable(new GraphError("x", { code: 131047, status: 400 })), false);
    assert.equal(retryable(new GraphError("x", { status: 503 })), true);
    assert.match(srv.calls[0].url, /^\/v26\.0\/PN\/messages$/);
  } finally {
    delete process.env.META_GRAPH_BASE;
    await srv.close();
  }
});
