/**
 * Campaign audiences from store orders (and/or Customers): one contact per WhatsApp number (last 10 digits) or
 * email, with their order history, filtered and checked against consent and the opt-out list.
 * Amazon orders are never used (Amazon doesn't allow marketing to its buyers).
 *
 * a: { source: orders|customers|both, lastDays, notSinceDays, states[], cities[], skus[], products[], payment,
 *      minOrders, maxOrders, minSpend, maxSpend, tags[], consent: subscribed|any }
 */
const ShopifyOrder = require("../../models/ShopifyOrder");
const Customer = require("../../models/Customer");
const MarketingConsent = require("../../models/MarketingConsent");
const { last10, toWa, cleanEmail } = require("./phone");
const { optOutSets } = require("./optout");
const { storeOrgFor } = require("./match");

const ORDER_FIELDS = { channel: 1, status: 1, orderDate: 1, total: 1, paymentMode: 1, tags: 1, customer: 1, "shippingAddress.phone": 1, "shippingAddress.state": 1, "shippingAddress.city": 1, "shippingAddress.name": 1, "lines.sku": 1, "lines.title": 1 };

// Orders → contacts keyed by "w:<10 digits>" (WhatsApp) or "e:<email>".
function contactsFromOrders(orders, channel) {
  const map = new Map();
  for (const o of orders) {
    if (o.channel === "amazon" || o.status === "cancelled") continue;
    const key = channel === "whatsapp" ? last10(o.customer?.phone) || last10(o.shippingAddress?.phone) : cleanEmail(o.customer?.email);
    if (!key) continue;
    let c = map.get(key);
    if (!c) {
      c = { key, to: channel === "whatsapp" ? toWa(o.customer?.phone) || toWa(o.shippingAddress?.phone) : key, name: o.customer?.name || o.shippingAddress?.name || "", phone10: channel === "whatsapp" ? key : last10(o.customer?.phone), email: channel === "email" ? key : cleanEmail(o.customer?.email), orders: 0, spend: 0, first: null, last: null, states: new Set(), cities: new Set(), skus: new Set(), titles: [], modes: new Set(), tags: new Set() };
      map.set(key, c);
    }
    c.orders++;
    c.spend += Number(o.total) || 0;
    const d = o.orderDate ? new Date(o.orderDate) : null;
    if (d && (!c.last || d > c.last)) c.last = d;
    if (d && (!c.first || d < c.first)) c.first = d;
    if (o.shippingAddress?.state) c.states.add(o.shippingAddress.state);
    if (o.shippingAddress?.city) c.cities.add(String(o.shippingAddress.city).trim().toLowerCase());
    for (const l of o.lines || []) {
      if (l.sku) c.skus.add(String(l.sku).toLowerCase());
      if (l.title) c.titles.push(String(l.title).toLowerCase());
    }
    c.modes.add(o.paymentMode === "cod" ? "cod" : "prepaid");
    for (const t of o.tags || []) c.tags.add(String(t).toLowerCase());
  }
  return [...map.values()];
}

const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

function matches(c, a, now = Date.now()) {
  const day = 86400000;
  if (a.lastDays && (!c.last || c.last.getTime() < now - a.lastDays * day)) return false;
  if (a.notSinceDays && c.last && c.last.getTime() >= now - a.notSinceDays * day) return false;
  const states = list(a.states);
  if (states.length && ![...c.states].some((s) => states.includes(String(s).toLowerCase()))) return false;
  const cities = list(a.cities);
  if (cities.length && ![...c.cities].some((s) => cities.includes(s))) return false;
  const skus = list(a.skus);
  if (skus.length && !skus.some((s) => c.skus.has(s))) return false;
  const products = list(a.products);
  if (products.length && !products.some((p) => c.titles.some((t) => t.includes(p)))) return false;
  if (a.payment && !c.modes.has(a.payment)) return false;
  if (a.minOrders && c.orders < a.minOrders) return false;
  if (a.maxOrders && c.orders > a.maxOrders) return false;
  if (a.minSpend && c.spend < a.minSpend) return false;
  if (a.maxSpend && c.spend > a.maxSpend) return false;
  const tags = list(a.tags);
  if (tags.length && !tags.some((t) => [...c.tags].some((x) => x === t))) return false;
  return true;
}

// Consent: "subscribed" = Shopify says SUBSCRIBED (email marketing for email, SMS marketing for WhatsApp);
// "any" = everyone except those who unsubscribed in Shopify. Opt-outs are always excluded.
function allowed(c, channel, { consent = "subscribed", consents, optOuts }) {
  if (channel === "whatsapp" ? optOuts.whatsapp.has(c.phone10 || last10(c.to)) : optOuts.email.has(c.email || c.to)) return { ok: false, why: "opted out" };
  const rec = channel === "whatsapp" ? consents.byPhone.get(c.phone10) : consents.byEmail.get(c.email);
  const st = channel === "whatsapp" ? rec?.smsState : rec?.emailState;
  if (st === "UNSUBSCRIBED" || st === "REDACTED" || st === "INVALID") return { ok: false, why: "unsubscribed in Shopify" };
  if (consent === "subscribed" && st !== "SUBSCRIBED") return { ok: false, why: "no marketing consent" };
  return { ok: true };
}

async function consentMaps(storeOrg) {
  const all = await MarketingConsent.find({ organization: storeOrg }, { email: 1, phone10: 1, emailState: 1, smsState: 1 }).lean();
  return { byEmail: new Map(all.filter((x) => x.email).map((x) => [x.email, x])), byPhone: new Map(all.filter((x) => x.phone10).map((x) => [x.phone10, x])), count: all.length };
}

async function build(org, channel, a = {}, { now = Date.now() } = {}) {
  const storeOrg = await storeOrgFor(org);
  let contacts = [];
  if ((a.source || "orders") !== "customers") {
    const orders = await ShopifyOrder.find({ organization: storeOrg }, ORDER_FIELDS).lean();
    contacts = contactsFromOrders(orders, channel);
  }
  if (a.source === "customers" || a.source === "both") {
    const have = new Set(contacts.map((c) => c.key));
    for (const cu of await Customer.find({ organization: org, active: { $ne: false } }, { displayName: 1, email: 1, phone: 1 }).lean()) {
      const key = channel === "whatsapp" ? last10(cu.phone) : cleanEmail(cu.email);
      if (!key || have.has(key)) continue;
      have.add(key);
      contacts.push({ key, to: channel === "whatsapp" ? toWa(cu.phone) : key, name: cu.displayName, phone10: last10(cu.phone), email: cleanEmail(cu.email), orders: 0, spend: 0, first: null, last: null, states: new Set(), cities: new Set(), skus: new Set(), titles: [], modes: new Set(), tags: new Set() });
    }
  }
  const [consents, optOuts] = await Promise.all([consentMaps(storeOrg), optOutSets(org)]);
  const out = [];
  const excluded = { consent: 0, optedOut: 0 };
  for (const c of contacts) {
    if (!c.to || !matches(c, a, now)) continue;
    const ok = allowed(c, channel, { consent: a.consent || "subscribed", consents, optOuts });
    if (!ok.ok) {
      if (ok.why === "opted out") excluded.optedOut++;
      else excluded.consent++;
      continue;
    }
    out.push({ to: c.to, name: c.name, vars: { name: (c.name || "").split(/\s+/)[0] || "there", full_name: c.name || "", orders: c.orders, spend: Math.round(c.spend), last_order: c.last ? c.last.toISOString().slice(0, 10) : "", city: [...c.cities][0] || "" } });
  }
  return { count: out.length, contacts: out, excluded, consentRecords: consents.count, matchedBeforeConsent: out.length + excluded.consent + excluded.optedOut };
}

/* ---------- Shopify marketing consent sync (hourly; best effort, never touches the order sync) ---------- */
async function syncConsent(store) {
  const { gql } = require("../shopify/client");
  const Q = `query($first:Int!,$after:String,$query:String){ customers(first:$first, after:$after, query:$query, sortKey: UPDATED_AT){ pageInfo{hasNextPage endCursor} nodes{ id email phone updatedAt emailMarketingConsent{ marketingState } smsMarketingConsent{ marketingState } } } }`;
  const since = store.consentSyncedAt ? new Date(new Date(store.consentSyncedAt).getTime() - 3600000) : null;
  let after = null;
  let n = 0;
  const started = new Date();
  for (let page = 0; page < 400; page++) {
    const d = await gql(store, Q, { first: 100, after, query: since ? `updated_at:>='${since.toISOString()}'` : null });
    for (const c of d.customers?.nodes || []) {
      const doc = { email: cleanEmail(c.email), phone10: last10(c.phone), emailState: c.emailMarketingConsent?.marketingState || "", smsState: c.smsMarketingConsent?.marketingState || "", updatedAt: new Date(c.updatedAt) };
      await MarketingConsent.updateOne({ organization: store.organization, shopifyCustomerId: c.id }, { $set: doc }, { upsert: true });
      n++;
    }
    if (!d.customers?.pageInfo?.hasNextPage) break;
    after = d.customers.pageInfo.endCursor;
  }
  const ShopifyStore = require("../../models/ShopifyStore");
  await ShopifyStore.collection.updateOne({ _id: store._id }, { $set: { consentSyncedAt: started } });
  return n;
}

async function syncAllConsent() {
  const ShopifyStore = require("../../models/ShopifyStore");
  const Integration = require("../../models/Integration");
  const orgs = new Set((await Integration.find({}, { organization: 1 }).lean()).map((i) => String(i.organization)));
  for (const s of await ShopifyStore.find({ connected: true })) {
    // Only stores of companies (or companies it's shared with) that use marketing.
    if (![s.organization, ...(s.sharedWith || [])].some((o) => orgs.has(String(o)))) continue;
    const raw = await ShopifyStore.collection.findOne({ _id: s._id }, { projection: { consentSyncedAt: 1 } });
    s.consentSyncedAt = raw?.consentSyncedAt;
    await syncConsent(s).catch((e) => console.error(`[marketing] Shopify consent sync (${s.shop}) failed: ${e.message}`));
  }
}

module.exports = { build, contactsFromOrders, matches, allowed, consentMaps, syncConsent, syncAllConsent };
