/**
 * Marketing → Integrations (module "marketing"): Meta (WhatsApp, Messenger, Instagram, comments) and Gmail.
 * Secrets go in, never come out (only "saved" flags). The Google OAuth callback is public (see publicRouter).
 */
const router = require("express").Router();
const crypto = require("crypto");
const Joi = require("joi");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const Integration = require("../models/Integration");
const { ah, validate, HttpError } = require("../utils/http");
const { integrationOf, forgetRoutes, pageToken } = require("../utils/marketing/integration");
const { graph } = require("../utils/marketing/graph");
const gmail = require("../utils/marketing/gmail");
const audit = require("../utils/audit");

const CALLBACK = () => `${env.APP_URL}/api/webhooks/meta`;

async function view(req) {
  const i = await integrationOf(req.org, { create: true });
  const out = i.toJSON();
  out.meta.verifyToken = i.meta.verifyToken; // shown so it can be pasted into the Meta app
  out.callbackUrl = CALLBACK();
  out.google.redirectUri = gmail.redirectUri();
  out.google.envClient = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  out.graphVersion = require("../utils/marketing/graph").VERSION();
  return out;
}

router.get("/", ah(async (req, res) => res.send(await view(req))));

const metaJoi = Joi.object({
  appId: Joi.string().allow("").pattern(/^\d*$/).message("App ID is a number"),
  appSecret: Joi.string().allow("").max(200),
  token: Joi.string().allow("").max(1000),
  wabaId: Joi.string().allow("").pattern(/^\d*$/).message("WABA ID is a number"),
  phoneNumberId: Joi.string().allow("").pattern(/^\d*$/).message("Phone number ID is a number"),
  pageId: Joi.string().allow("").pattern(/^\d*$/).message("Page ID is a number"),
  igId: Joi.string().allow("").pattern(/^\d*$/).message("Instagram account ID is a number"),
  whatsapp: Joi.boolean(),
  messenger: Joi.boolean(),
  instagram: Joi.boolean(),
  fbComments: Joi.boolean(),
  igComments: Joi.boolean(),
});

router.put(
  "/meta",
  ah(async (req, res) => {
    const d = validate(metaJoi, req.body);
    const i = await integrationOf(req.org, { create: true });
    const m = i.meta;
    const pageChanged = (d.pageId !== undefined && d.pageId !== m.pageId) || (d.token && d.token !== m.token);
    for (const k of ["appId", "wabaId", "phoneNumberId", "pageId", "igId", "whatsapp", "messenger", "instagram", "fbComments", "igComments"]) if (d[k] !== undefined) m[k] = d[k];
    if (d.appSecret) m.appSecret = d.appSecret.trim();
    if (d.token) m.token = d.token.trim();
    if (pageChanged) m.pageToken = "";
    i.markModified("meta");
    await i.save();
    forgetRoutes();
    res.send(await view(req)); // the audit trail logs "credentials_changed" (and alerts) when a secret was entered
  })
);

router.post(
  "/meta/verify-token",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    i.meta.verifyToken = crypto.randomBytes(24).toString("hex");
    i.markModified("meta");
    await i.save();
    forgetRoutes();
    await audit.log(req, "meta_verify_token_changed", { target: "integrations" });
    res.send(await view(req));
  })
);

// Calls Graph for each piece and reports what works.
router.post(
  "/meta/test",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    const m = i.meta;
    if (!m.token) throw new HttpError(400, "Paste the System User access token first");
    const results = [];
    const step = async (name, fn) => {
      try {
        results.push({ name, ok: true, detail: (await fn()) || "OK" });
      } catch (e) {
        results.push({ name, ok: false, detail: e.message });
      }
    };
    await step("Access token", async () => {
      const me = await graph(m.token, "GET", "me", { query: { fields: "id,name" } });
      return `Valid — ${me.name || me.id}`;
    });
    if (m.appId && m.appSecret)
      await step("App ID + App Secret", async () => {
        const dbg = await graph(`${m.appId}|${m.appSecret}`, "GET", "debug_token", { query: { input_token: m.token } });
        const d = dbg.data || {};
        if (!d.is_valid) throw new Error("Meta says the token isn't valid for this app");
        const missing = ["whatsapp_business_messaging", "whatsapp_business_management", "pages_messaging", "pages_manage_metadata", "pages_read_engagement", "pages_manage_engagement", "instagram_basic", "instagram_manage_messages", "instagram_manage_comments"].filter((p) => !(d.scopes || []).includes(p));
        return `Token belongs to app ${d.app_id}${d.expires_at ? `, expires ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)}` : ", never expires"}${missing.length ? ` — missing permissions: ${missing.join(", ")}` : " — all permissions present"}`;
      });
    if (m.wabaId) await step("WhatsApp Business Account", async () => `${(await graph(m.token, "GET", m.wabaId, { query: { fields: "id,name" } })).name || m.wabaId}`);
    if (m.phoneNumberId)
      await step("WhatsApp phone number", async () => {
        let p;
        try {
          p = await graph(m.token, "GET", m.phoneNumberId, { query: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status" } });
        } catch {
          p = await graph(m.token, "GET", m.phoneNumberId, { query: { fields: "display_phone_number,verified_name,quality_rating" } });
        }
        m.displayPhone = p.display_phone_number || "";
        m.verifiedName = p.verified_name || "";
        m.qualityRating = p.quality_rating || "";
        if (p.messaging_limit_tier) m.messagingLimit = p.messaging_limit_tier;
        return `${p.display_phone_number} (${p.verified_name || "name pending"}) — quality ${p.quality_rating || "?"}${p.messaging_limit_tier ? `, limit ${p.messaging_limit_tier}` : ""}`;
      });
    if (m.pageId)
      await step("Facebook Page", async () => {
        m.pageToken = "";
        await pageToken(i);
        return `${i.meta.pageName || m.pageId} — Page token OK`;
      });
    if (m.igId)
      await step("Instagram account", async () => {
        const ig = await graph(m.token, "GET", m.igId, { query: { fields: "username,name" } });
        m.igUsername = ig.username || "";
        return `@${ig.username || m.igId}`;
      });
    if (m.wabaId)
      await step("WhatsApp webhook subscription", async () => {
        const s = await graph(m.token, "GET", `${m.wabaId}/subscribed_apps`);
        const apps = (s.data || []).map((a) => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id || a.id);
        if (!apps.length) throw new Error("No app is subscribed to the WABA yet — press “Subscribe webhooks”");
        return `Subscribed: ${apps.join(", ")}`;
      });
    if (m.pageId && m.pageToken)
      await step("Page webhook subscription", async () => {
        const s = await graph(m.pageToken, "GET", `${m.pageId}/subscribed_apps`);
        const a = (s.data || [])[0];
        if (!a) throw new Error("This app isn't subscribed to the Page yet — press “Subscribe webhooks”");
        return `Subscribed fields: ${(a.subscribed_fields || []).join(", ") || "none"}`;
      });
    m.lastTest = { at: new Date(), results };
    i.markModified("meta");
    await i.save();
    await audit.log(req, "meta_connection_tested", { target: "integrations", meta: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } });
    res.send({ results, integration: await view(req) });
  })
);

// Subscribe the app to the WABA's and the Page's webhooks (Instagram fields are ticked in the app dashboard).
router.post(
  "/meta/subscribe",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    const m = i.meta;
    if (!m.token) throw new HttpError(400, "Paste the System User access token first");
    const out = [];
    if (m.wabaId) {
      try {
        await graph(m.token, "POST", `${m.wabaId}/subscribed_apps`);
        out.push({ name: "WhatsApp (WABA)", ok: true, detail: "Subscribed" });
      } catch (e) {
        out.push({ name: "WhatsApp (WABA)", ok: false, detail: e.message });
      }
    }
    if (m.pageId) {
      try {
        const tok = await pageToken(i);
        await graph(tok, "POST", `${m.pageId}/subscribed_apps`, { query: { subscribed_fields: "messages,messaging_postbacks,message_deliveries,message_reads,message_echoes,feed" } });
        out.push({ name: "Facebook Page (Messenger, comments, Instagram DMs)", ok: true, detail: "Subscribed" });
      } catch (e) {
        out.push({ name: "Facebook Page", ok: false, detail: e.message });
      }
    }
    await audit.log(req, "meta_webhooks_subscribed", { target: "integrations", meta: { results: out.map((r) => `${r.name}: ${r.ok ? "ok" : "failed"}`) } });
    res.send({ results: out });
  })
);

router.delete(
  "/meta",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    Object.assign(i.meta, { token: "", appSecret: "", pageToken: "", whatsapp: false, messenger: false, instagram: false, fbComments: false, igComments: false, lastTest: null });
    i.markModified("meta");
    await i.save();
    forgetRoutes();
    await audit.log(req, "meta_disconnected", { target: "integrations" });
    res.send(await view(req));
  })
);

/* ---------- Gmail ---------- */
router.put(
  "/google",
  ah(async (req, res) => {
    const d = validate(Joi.object({ clientId: Joi.string().allow("").max(300), clientSecret: Joi.string().allow("").max(300), enabled: Joi.boolean() }), req.body);
    const i = await integrationOf(req.org, { create: true });
    if (d.clientId !== undefined) i.google.clientId = d.clientId.trim();
    if (d.clientSecret) i.google.clientSecret = d.clientSecret.trim();
    if (d.enabled !== undefined) i.google.enabled = d.enabled;
    i.markModified("google");
    await i.save();
    res.send(await view(req));
  })
);

const stateKey = () => crypto.createHash("sha256").update(`google-oauth:${env.JWT_SECRET}`).digest("hex");
router.get(
  "/google/auth-url",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    const state = jwt.sign({ org: String(req.org), user: String(req.user._id), n: crypto.randomBytes(8).toString("hex") }, stateKey(), { expiresIn: "15m" });
    res.send({ url: gmail.authUrl(i, state) });
  })
);

router.post(
  "/google/poll",
  ah(async (req, res) => {
    const i = await integrationOf(req.org);
    if (!i?.google?.refreshToken) throw new HttpError(400, "Connect Gmail first");
    res.send(await gmail.poll(i));
  })
);

router.delete(
  "/google",
  ah(async (req, res) => {
    const i = await integrationOf(req.org, { create: true });
    const tok = i.google.refreshToken;
    if (tok) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok)}`, { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => {});
    Object.assign(i.google, { refreshToken: "", accessToken: "", accessExpires: null, historyId: "", email: "", connectedAt: null, error: "" });
    i.markModified("google");
    await i.save();
    await audit.log(req, "gmail_disconnected", { target: "integrations" });
    res.send(await view(req));
  })
);

/* ---------- public: Google redirects the browser here (no OrdexaGo session header) ---------- */
const publicRouter = require("express").Router();
publicRouter.get("/google/callback", async (req, res) => {
  const back = (q) => res.redirect(`${env.APP_URL}/marketing/integrations?${q}`);
  try {
    if (req.query.error) return back(`google=error&reason=${encodeURIComponent(String(req.query.error).slice(0, 100))}`);
    let st;
    try {
      st = jwt.verify(String(req.query.state || ""), stateKey());
    } catch {
      return back("google=error&reason=expired");
    }
    const i = await integrationOf(st.org, { create: true });
    const t = await gmail.exchangeCode(i, String(req.query.code || ""));
    if (!t.refresh_token) return back("google=error&reason=no_refresh_token");
    i.google.refreshToken = t.refresh_token;
    i.google.accessToken = t.access_token;
    i.google.accessExpires = new Date(Date.now() + (t.expires_in || 3600) * 1000);
    i.google.enabled = true;
    i.google.historyId = "";
    i.google.error = "";
    i.markModified("google");
    await i.save();
    const prof = await gmail.api(i, "GET", "profile");
    i.google.email = prof.emailAddress || "";
    i.google.connectedAt = new Date();
    i.markModified("google");
    await i.save();
    await audit.log(req, "gmail_connected", { organization: st.org, user: st.user, email: "", target: "integrations", meta: { mailbox: prof.emailAddress } });
    back("google=connected");
  } catch (e) {
    console.error(`[gmail] OAuth callback failed: ${e.message}`);
    back(`google=error&reason=${encodeURIComponent(e.message.slice(0, 120))}`);
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
