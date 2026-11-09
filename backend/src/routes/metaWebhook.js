/**
 * Meta webhook for every company: https://<APP_URL>/api/webhooks/meta  (public; mounted with express.raw)
 *   GET  — verification: hub.mode=subscribe, hub.verify_token = a company's verify token → hub.challenge
 *   POST — X-Hub-Signature-256 checked with the App Secret of the company the event belongs to (by phone number
 *          ID / Page ID / IG ID). Answers 200 at once; events are processed afterwards, idempotent by message id.
 */
const router = require("express").Router();
const crypto = require("crypto");
const Integration = require("../models/Integration");
const { verifySignature, parsePayload } = require("../utils/marketing/webhook");
const { loadRoutes, orgForEvent } = require("../utils/marketing/integration");

const safeEq = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode !== "subscribe" || !token) return res.status(400).send("Bad request");
  const r = await loadRoutes(true).catch(() => ({ verify: [] }));
  const ok = r.verify.some((t) => safeEq(t, token)) || (process.env.META_VERIFY_TOKEN && safeEq(process.env.META_VERIFY_TOKEN, token));
  if (!ok) return res.status(403).send("Verify token doesn't match");
  res.type("text/plain").send(challenge.replace(/[^\w.-]/g, "").slice(0, 200));
});

// Route + verify; returns [{ org, integration, events }] for the companies whose App Secret signed this body.
async function accept(raw, signature) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, groups: [] };
  }
  const events = parsePayload(body);
  const r = await loadRoutes();
  const byOrg = new Map();
  for (const ev of events) {
    const org = orgForEvent(r, ev);
    if (!org) continue;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(ev);
  }
  const groups = [];
  let anyChecked = false;
  for (const [org, evs] of byOrg) {
    const i = await Integration.findOne({ organization: org });
    const secret = i?.meta?.appSecret || process.env.META_APP_SECRET || "";
    anyChecked = anyChecked || !!secret;
    if (verifySignature(raw, signature, secret)) groups.push({ org, integration: i, events: evs });
  }
  if (!byOrg.size) {
    // Nothing for any company (e.g. Meta's test event): accept only if signed with a known secret.
    const env = process.env.META_APP_SECRET;
    const secrets = (await Integration.find({})).map((i) => i.meta?.appSecret).filter(Boolean);
    if (env) secrets.push(env);
    return { status: secrets.some((s) => verifySignature(raw, signature, s)) ? 200 : 401, groups: [] };
  }
  return { status: groups.length ? 200 : anyChecked ? 401 : 401, groups };
}

async function process_(groups) {
  const { ingest } = require("../utils/marketing/inbox");
  for (const g of groups) {
    await Integration.updateOne({ _id: g.integration._id }, { $set: { "meta.lastWebhookAt": new Date() } }).catch(() => {});
    for (const ev of g.events) await ingest(g.org, ev, { integration: g.integration }).catch((e) => console.error(`[meta webhook] ${ev.channel} ${ev.type}: ${e.message}`));
  }
}

router.post("/", async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  try {
    const { status, groups } = await accept(raw, req.get("x-hub-signature-256"));
    res.sendStatus(status);
    if (groups.length) setImmediate(() => process_(groups).catch((e) => console.error(`[meta webhook] ${e.message}`)));
  } catch (e) {
    console.error(`[meta webhook] ${e.message}`);
    if (!res.headersSent) res.sendStatus(500);
  }
});

module.exports = router;
module.exports.accept = accept;
module.exports.process_ = process_;
