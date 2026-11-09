/**
 * A company's messaging connections, and which company a Meta webhook event belongs to.
 */
const crypto = require("crypto");
const Integration = require("../../models/Integration");
const MarketingConfig = require("../../models/MarketingConfig");
const { graph } = require("./graph");

async function integrationOf(org, { create = false } = {}) {
  let i = await Integration.findOne({ organization: org });
  if (!i && create) {
    i = await Integration.create({ organization: org, meta: { verifyToken: crypto.randomBytes(24).toString("hex") } }).catch(() => Integration.findOne({ organization: org }));
  }
  if (i && create && !i.meta?.verifyToken) {
    i.meta.verifyToken = crypto.randomBytes(24).toString("hex");
    await i.save();
  }
  return i;
}

async function configOf(org) {
  let c = await MarketingConfig.findOne({ organization: org });
  if (!c) c = await MarketingConfig.create({ organization: org }).catch(() => MarketingConfig.findOne({ organization: org }));
  return c;
}

// Which channels can be used right now.
function channelsOf(i) {
  const m = i?.meta || {};
  const g = i?.google || {};
  const tok = !!m.token;
  return {
    whatsapp: tok && !!m.phoneNumberId && m.whatsapp !== false && !!m.whatsapp,
    messenger: tok && !!m.pageId && !!m.messenger,
    instagram: tok && !!m.igId && !!m.pageId && !!m.instagram,
    fb_comment: tok && !!m.pageId && !!m.fbComments,
    ig_comment: tok && !!m.igId && !!m.igComments,
    email: !!g.refreshToken && g.enabled !== false,
  };
}
const canWhatsApp = (i) => channelsOf(i).whatsapp;

/* ---------- webhook routing (cached for a minute) ---------- */
let routes = { at: 0, byPhone: new Map(), byPage: new Map(), byIg: new Map(), byWaba: new Map(), verify: [] };
async function loadRoutes(force = false) {
  if (!force && Date.now() - routes.at < 60000) return routes;
  const r = { at: Date.now(), byPhone: new Map(), byPage: new Map(), byIg: new Map(), byWaba: new Map(), verify: [] };
  for (const i of await Integration.find({})) {
    const m = i.meta || {};
    const org = String(i.organization);
    if (m.phoneNumberId) r.byPhone.set(String(m.phoneNumberId), org);
    if (m.wabaId) r.byWaba.set(String(m.wabaId), org);
    if (m.pageId) r.byPage.set(String(m.pageId), org);
    if (m.igId) r.byIg.set(String(m.igId), org);
    if (m.verifyToken) r.verify.push(m.verifyToken);
  }
  routes = r;
  return r;
}
const forgetRoutes = () => {
  routes.at = 0;
};

// The company for a normalised event: { channel, phoneNumberId, wabaId, pageId, igId }.
function orgForEvent(r, ev) {
  if (ev.phoneNumberId && r.byPhone.has(String(ev.phoneNumberId))) return r.byPhone.get(String(ev.phoneNumberId));
  if (ev.wabaId && r.byWaba.has(String(ev.wabaId))) return r.byWaba.get(String(ev.wabaId));
  if (ev.igId && r.byIg.has(String(ev.igId))) return r.byIg.get(String(ev.igId));
  if (ev.pageId && r.byPage.has(String(ev.pageId))) return r.byPage.get(String(ev.pageId));
  // Instagram messaging over the Page: the entry id may be the Page or the IG account.
  if (ev.pageId && r.byIg.has(String(ev.pageId))) return r.byIg.get(String(ev.pageId));
  return null;
}

// A Page access token (needed for Messenger, Page comments and Instagram messaging), read with the System User token.
async function pageToken(i) {
  const m = i.meta;
  if (m.pageToken) return m.pageToken;
  if (!m.token || !m.pageId) throw new Error("Add the Facebook Page ID and the System User token first");
  const j = await graph(m.token, "GET", m.pageId, { query: { fields: "access_token,name" } });
  if (!j.access_token) throw new Error("Couldn't get a Page access token: give the System User the Page as an asset (Business Settings → System users → Assign assets)");
  m.pageToken = j.access_token;
  if (j.name) m.pageName = j.name;
  await Integration.updateOne({ _id: i._id }, { $set: { "meta.pageToken": require("../secrets").encrypt(j.access_token), "meta.pageName": j.name || m.pageName || "" } });
  return j.access_token;
}

module.exports = { integrationOf, configOf, channelsOf, canWhatsApp, loadRoutes, forgetRoutes, orgForEvent, pageToken };
