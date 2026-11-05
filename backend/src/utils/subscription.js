/**
 * Subscriptions: every company belongs to a Subscriber (a business that pays OrdexaGo). Its plan sets the
 * limits (companies, users, Shopify stores) and validTill + graceDays decide access:
 *   active → full access; grace (after validTill, within graceDays) → full access with a warning;
 *   expired / suspended → login and every request refused (the superadmin is never blocked).
 */
const Subscriber = require("../models/Subscriber");
const Organization = require("../models/Organization");
const { HttpError } = require("./http");

const DAY = 86400000;
const IST = 5.5 * 3600000;

// validTill is a date: access lasts to the end of that day in India.
const endOf = (d) => new Date(new Date(d).setUTCHours(0, 0, 0, 0) + DAY - IST);

function stateOf(sub, now = new Date()) {
  if (!sub || sub.owner) return { state: "unlimited", blocked: false };
  const base = { validTill: sub.validTill || null, graceDays: sub.graceDays || 0, plan: sub.plan?.name || "" };
  if (sub.status === "suspended") return { ...base, state: "suspended", blocked: true, message: "Your OrdexaGo account has been suspended. Contact OrdexaGo (help@ordexago.com)." };
  if (!sub.validTill) return { ...base, state: "active", blocked: false };
  const end = endOf(sub.validTill);
  if (now <= end) return { ...base, state: "active", blocked: false, daysLeft: Math.ceil((end - now) / DAY) };
  const graceEnd = new Date(end.getTime() + (sub.graceDays || 0) * DAY);
  if (now <= graceEnd) return { ...base, state: "grace", blocked: false, graceLeft: Math.ceil((graceEnd - now) / DAY), message: `Your OrdexaGo subscription expired. Renew within ${Math.ceil((graceEnd - now) / DAY)} day(s) to keep access.` };
  return { ...base, state: "expired", blocked: true, message: "Your OrdexaGo subscription has expired. Contact OrdexaGo (help@ordexago.com) to renew." };
}

// Subscriber of a company, cached briefly (checked on every request).
const cache = new Map();
async function subscriberOfOrg(orgId) {
  const k = String(orgId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 30000) return hit.sub;
  const org = await Organization.findById(orgId, { subscriber: 1 }).lean();
  const sub = org?.subscriber ? await Subscriber.findById(org.subscriber).populate("plan").lean() : null;
  cache.set(k, { sub, at: Date.now() });
  return sub;
}
const clearCache = () => cache.clear();

// Refuse a blocked subscription (superadmins pass).
async function assertAccess(user, orgId) {
  if (user?.superadmin) return { state: "unlimited", blocked: false };
  const st = stateOf(await subscriberOfOrg(orgId));
  if (st.blocked) throw new HttpError(402, st.message);
  return st;
}

// What a subscriber uses now.
async function usageOf(subId) {
  const Membership = require("../models/Membership");
  const ShopifyStore = require("../models/ShopifyStore");
  const orgs = (await Organization.find({ subscriber: subId }, { _id: 1 }).lean()).map((o) => o._id);
  const ms = orgs.length ? await Membership.find({ organization: { $in: orgs } }, { user: 1, status: 1 }).lean() : [];
  const users = new Set(ms.filter((m) => m.status !== "inactive").map((m) => String(m.user)));
  const stores = orgs.length ? await ShopifyStore.countDocuments({ organization: { $in: orgs } }) : 0;
  return { companies: orgs.length, users: users.size, shopifyStores: stores, orgIds: orgs, userIds: users };
}

const LIMIT = { companies: ["maxCompanies", "companies"], users: ["maxUsers", "users"], shopifyStores: ["maxShopifyStores", "Shopify stores"] };
// Throws when adding one more `what` to the company's subscriber would pass the plan's limit.
// userId: for users, someone already counted (in another company of the same subscriber) doesn't add one.
async function checkLimit(orgId, what, { userId } = {}) {
  const sub = await subscriberOfOrg(orgId);
  if (!sub || sub.owner || !sub.plan) return;
  const [field, label] = LIMIT[what];
  const max = sub.plan[field];
  if (max === null || max === undefined || max === "") return;
  const u = await usageOf(sub._id);
  if (what === "users" && userId && u.userIds.has(String(userId))) return;
  if (u[what] + 1 > max) throw new HttpError(403, `Your plan (${sub.plan.name}) allows ${max} ${label}. Contact OrdexaGo to upgrade.`);
}

module.exports = { stateOf, subscriberOfOrg, clearCache, assertAccess, usageOf, checkLimit, endOf };
