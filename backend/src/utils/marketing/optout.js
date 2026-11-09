// The company's opt-out list (WhatsApp STOP, email unsubscribe links, staff). Checked before every send.
const crypto = require("crypto");
const OptOut = require("../../models/OptOut");
const { last10, cleanEmail } = require("./phone");

const norm = (channel, v) => (channel === "whatsapp" ? last10(v) : cleanEmail(v));

async function optOut(org, channel, value, source = "staff", note = "") {
  const v = norm(channel, value);
  if (!v) return null;
  const has = await OptOut.findOne({ organization: org, channel, value: v });
  if (has) return has;
  return OptOut.create({ organization: org, channel, value: v, source, note }).catch(() => OptOut.findOne({ organization: org, channel, value: v }));
}
async function optIn(org, channel, value) {
  const v = norm(channel, value);
  if (v) await OptOut.deleteOne({ organization: org, channel, value: v });
}
async function isOptedOut(org, channel, value) {
  const v = norm(channel, value);
  if (!v) return false;
  return !!(await OptOut.exists({ organization: org, channel, value: v }));
}
// All opt-outs of a company as Sets (for audiences).
async function optOutSets(org) {
  const all = await OptOut.find({ organization: org }, { channel: 1, value: 1 }).lean();
  return { whatsapp: new Set(all.filter((x) => x.channel === "whatsapp").map((x) => x.value)), email: new Set(all.filter((x) => x.channel === "email").map((x) => x.value)) };
}

/* ---------- email unsubscribe links: /api/unsubscribe/<org>.<base64url email>.<sig> ---------- */
const key = () => crypto.createHash("sha256").update(`unsubscribe:${require("../../config/env").JWT_SECRET}`).digest();
function unsubscribeToken(org, email) {
  const e = Buffer.from(cleanEmail(email)).toString("base64url");
  const sig = crypto.createHmac("sha256", key()).update(`${org}.${e}`).digest("base64url").slice(0, 22);
  return `${org}.${e}.${sig}`;
}
function readUnsubscribeToken(tok) {
  const [org, e, sig] = String(tok || "").split(".");
  if (!org || !e || !sig) return null;
  const want = crypto.createHmac("sha256", key()).update(`${org}.${e}`).digest("base64url").slice(0, 22);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return { org, email: Buffer.from(e, "base64url").toString("utf8") };
}
const unsubscribeUrl = (org, email) => `${require("../../config/env").APP_URL}/api/unsubscribe/${unsubscribeToken(org, email)}`;

module.exports = { optOut, optIn, isOptedOut, optOutSets, unsubscribeToken, readUnsubscribeToken, unsubscribeUrl, norm };
