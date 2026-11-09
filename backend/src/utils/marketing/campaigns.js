/**
 * Broadcast campaigns: WhatsApp marketing templates or emails, sent in throttled batches with retries.
 * Runs every 30 seconds (scheduler.js). WhatsApp: at most `ratePerMinute`, and no more new people per 24 hours
 * than the number's messaging tier (TIER_250 / 1K / 10K / 100K) allows — the rest waits.
 */
const Campaign = require("../../models/Campaign");
const CampaignRecipient = require("../../models/CampaignRecipient");
const { integrationOf, canWhatsApp } = require("./integration");
const { retryable } = require("./graph");

const MAX_ATTEMPTS = 3;
const TIERS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: Infinity };
const tierLimit = (t) => TIERS[String(t || "").toUpperCase()] ?? 250;

const fill = (s, vars) => String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] ?? "") + "");

async function bumpTotals(campaignId) {
  const rs = await CampaignRecipient.find({ campaign: campaignId }, { status: 1 }).lean();
  const t = { recipients: rs.length, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, skipped: 0 };
  for (const r of rs) {
    if (r.status === "failed") t.failed++;
    else if (r.status === "skipped") t.skipped++;
    else if (r.status !== "queued") {
      t.sent++;
      if (["delivered", "read", "replied"].includes(r.status)) t.delivered++;
      if (["read", "replied"].includes(r.status)) t.read++;
      if (r.status === "replied") t.replied++;
    }
  }
  await Campaign.updateOne({ _id: campaignId }, { $set: { totals: t } });
  return t;
}

async function markReplied(org, waFrom) {
  const since = Date.now() - 7 * 86400000;
  const rs = (await CampaignRecipient.find({ to: String(waFrom) }, { status: 1, organization: 1, sentAt: 1, campaign: 1 }).lean()).filter((r) => String(r.organization) === String(org) && ["sent", "delivered", "read"].includes(r.status) && r.sentAt && new Date(r.sentAt).getTime() > since);
  for (const r of rs) {
    await CampaignRecipient.updateOne({ _id: r._id }, { $set: { status: "replied" } });
    await bumpTotals(r.campaign);
  }
}

// Put the audience on the campaign (once).
async function materialise(c) {
  if (await CampaignRecipient.exists({ campaign: c._id })) return;
  const { build } = require("./audience");
  const a = await build(c.organization, c.channel, c.audience || {});
  for (let i = 0; i < a.contacts.length; i += 500) await CampaignRecipient.insertMany(a.contacts.slice(i, i + 500).map((x) => ({ organization: c.organization, campaign: c._id, to: x.to, name: x.name, vars: x.vars, status: "queued" })));
  await bumpTotals(c._id);
}

async function sendOne(c, r, { i, org }) {
  const vars = { ...(r.vars || {}), store_name: org?.name || "" };
  if (c.channel === "whatsapp") {
    const wa = require("./whatsapp");
    const w = c.whatsapp || {};
    const tpl = { name: w.template, language: w.language || "en", body: (w.params || []).map((p) => fill(p, vars)), header: w.headerMediaUrl ? { image: { link: w.headerMediaUrl } } : w.headerParam ? fill(w.headerParam, vars) : undefined };
    return wa.sendTemplate(i, r.to, tpl);
  }
  const { unsubscribeUrl } = require("./optout");
  const { sendOrgMail } = require("../mailer");
  const unsub = unsubscribeUrl(c.organization, r.to);
  const addr = org?.address || {};
  const address = [org?.name, addr.street, addr.city, addr.pincode, addr.country].filter(Boolean).join(", ");
  const body = fill(c.email?.body, vars);
  const text = `${body}\n\n—\n${address}\nUnsubscribe: ${unsub}`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">${esc(body).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div><hr style="border:0;border-top:1px solid #ddd;margin:24px 0 8px"><div style="font-family:Arial,sans-serif;font-size:12px;color:#777">${esc(address)}<br><a href="${unsub}" style="color:#777">Unsubscribe</a></div>`;
  await sendOrgMail(org, { to: r.to, subject: fill(c.email?.subject, vars), text, html, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  return "";
}

async function sentLast24h(org) {
  const since = new Date(Date.now() - 86400000);
  const rs = await CampaignRecipient.find({ organization: org, sentAt: { $gte: since } }, { to: 1 }).lean();
  return new Set(rs.map((r) => r.to)).size;
}

async function runCampaign(c, now = new Date()) {
  const Organization = require("../../models/Organization");
  const org = await Organization.findById(c.organization);
  const i = c.channel === "whatsapp" ? await integrationOf(c.organization) : null;
  if (c.channel === "whatsapp" && !canWhatsApp(i)) {
    await Campaign.updateOne({ _id: c._id }, { $set: { status: "paused", error: "WhatsApp isn't connected" } });
    return;
  }
  let budget = Math.max(1, Math.ceil((c.ratePerMinute || 60) / 2)); // per 30-second tick
  if (c.channel === "whatsapp") budget = Math.min(budget, Math.max(0, tierLimit(i.meta.messagingLimit) - (await sentLast24h(c.organization))));
  if (budget <= 0) return Campaign.updateOne({ _id: c._id }, { $set: { error: "Waiting: the WhatsApp number's 24-hour messaging limit is reached; sending continues automatically" } });
  const queued = (await CampaignRecipient.find({ campaign: c._id, status: "queued" }).limit(budget * 3)).filter((r) => !r.nextTryAt || r.nextTryAt <= now).slice(0, budget);
  const { isOptedOut } = require("./optout");
  for (const r of queued) {
    if (await isOptedOut(c.organization, c.channel, r.to)) {
      r.status = "skipped";
      r.error = "Opted out";
      await r.save();
      continue;
    }
    try {
      r.externalId = await sendOne(c, r, { i, org });
      r.status = "sent";
      r.sentAt = new Date();
      r.error = "";
    } catch (e) {
      r.attempts = (r.attempts || 0) + 1;
      r.error = e.message;
      if (retryable(e) && r.attempts < MAX_ATTEMPTS) r.nextTryAt = new Date(Date.now() + r.attempts * 2 * 60000);
      else r.status = "failed";
    }
    await r.save();
  }
  const left = await CampaignRecipient.countDocuments({ campaign: c._id, status: "queued" });
  await bumpTotals(c._id);
  if (!left) await Campaign.updateOne({ _id: c._id }, { $set: { status: "done", finishedAt: new Date(), error: "" } });
  else await Campaign.updateOne({ _id: c._id }, { $set: { error: "" } });
}

let busy = false;
async function tick(now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    for (const c of await Campaign.find({ status: "scheduled" })) {
      if (c.scheduledAt && c.scheduledAt > now) continue;
      await materialise(c);
      await Campaign.updateOne({ _id: c._id }, { $set: { status: "running", startedAt: new Date() } });
    }
    for (const c of await Campaign.find({ status: "running" })) await runCampaign(c, now).catch((e) => Campaign.updateOne({ _id: c._id }, { $set: { error: e.message } }));
  } finally {
    busy = false;
  }
}

async function testSend(c, to, user) {
  const Organization = require("../../models/Organization");
  const org = await Organization.findById(c.organization);
  const i = c.channel === "whatsapp" ? await integrationOf(c.organization) : null;
  if (c.channel === "whatsapp" && !canWhatsApp(i)) throw new Error("WhatsApp isn't connected (Marketing → Integrations)");
  const { toWa, cleanEmail } = require("./phone");
  const dest = c.channel === "whatsapp" ? toWa(to) : cleanEmail(to);
  if (!dest) throw new Error(c.channel === "whatsapp" ? "Enter a WhatsApp number" : "Enter an email address");
  const id = await sendOne(c, { to: dest, vars: { name: (user?.name || "there").split(/\s+/)[0], full_name: user?.name || "", orders: 3, spend: 4999, last_order: new Date().toISOString().slice(0, 10), city: "Mumbai" } }, { i, org });
  await Campaign.updateOne({ _id: c._id }, { $set: { testSentAt: new Date() } });
  return id;
}

module.exports = { tick, runCampaign, materialise, bumpTotals, markReplied, testSend, tierLimit, fill, sendOne };
