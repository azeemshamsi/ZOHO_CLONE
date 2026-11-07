/**
 * Security audit log + alerts.
 *
 *   log(req, action, { target, meta, organization, user, email })  — append an entry (never throws)
 *   amazonAccess(req, action, target, meta)  — log access to Amazon buyer data, alert outside 08:00–21:00 IST
 *                                               and on unusual volume
 *   alert(org, subject, text, key)            — email the superadmin(s) and the company's admins (throttled)
 *   trail                                     — Express middleware: logs deletions, settings/credential changes
 *                                               and file downloads automatically once the response is sent
 *
 * Never logs passwords, tokens or buyer names/addresses/phones: `meta` is cleaned of such keys.
 */
const AuditLog = require("../models/AuditLog");

const RETAIN_DAYS = 400;
const SENSITIVE_KEY = /pass|token|secret|api_?key|otp|totp|recovery|buyer|address|phone|mobile|customer|recipient|shipping|^code$|^codes$|^name$|credential/i;

// Copy of `meta` without sensitive keys; strings shortened, arrays and depth limited.
function clean(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v._bsontype === "ObjectId") return String(v);
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 25).map((x) => clean(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k)) continue;
      const c = clean(x, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

const ipOf = (req) => String(req?.ip || req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
function info(req) {
  if (!req || !req.get) return { ip: "", deviceId: "", userAgent: "" };
  return { ip: ipOf(req), deviceId: String(req.get("x-device-id") || "").slice(0, 64), userAgent: String(req.get("user-agent") || "").slice(0, 300) };
}

async function log(req, action, opts = {}) {
  try {
    if (req?.res?.locals) req.res.locals.audited = true;
    const doc = {
      organization: opts.organization !== undefined ? opts.organization || undefined : req?.org,
      user: opts.user !== undefined ? opts.user || undefined : req?.user?._id,
      email: String(opts.email !== undefined ? opts.email || "" : req?.user?.email || "").toLowerCase().slice(0, 200),
      action,
      target: String(opts.target || "").slice(0, 300),
      ...info(req),
      meta: clean(opts.meta || {}) || {},
      at: new Date(),
    };
    return await AuditLog.create(doc);
  } catch (e) {
    console.error(`[audit] could not log ${action}: ${e.message}`);
    return null;
  }
}

/* ---------------- alerts ---------------- */
const sentAt = new Map(); // throttle key → time
const THROTTLE = 30 * 60 * 1000;

async function recipients(org) {
  const User = require("../models/User");
  const Membership = require("../models/Membership");
  const out = new Set();
  for (const u of await User.find({ superadmin: true }, { email: 1 }).lean()) if (u.email) out.add(u.email.toLowerCase());
  if (org) {
    const ms = await Membership.find({ organization: org, role: "admin", status: "active" }, { user: 1 }).lean();
    const ids = ms.map((m) => m.user).filter(Boolean);
    if (ids.length) for (const u of await User.find({ _id: { $in: ids } }, { email: 1, status: 1 }).lean()) if (u.email && u.status !== "invited") out.add(u.email.toLowerCase());
  }
  return [...out];
}

// Email the superadmin(s) and the company's admins. Same `key` → at most one email per 30 minutes.
async function alert(org, subject, text, key = subject) {
  try {
    const k = `${org || "-"}|${key}`;
    const now = Date.now();
    if (sentAt.has(k) && now - sentAt.get(k) < THROTTLE) return false;
    sentAt.set(k, now);
    if (sentAt.size > 5000) for (const [kk, t] of sentAt) if (now - t > THROTTLE) sentAt.delete(kk);
    const to = await recipients(org);
    const { sendSystemMail } = require("./mailer");
    const body = `${text}\n\nTime: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST\nSee Settings → Security in OrdexaGo for the full log.\n\n— OrdexaGo security alerts`;
    for (const email of to) await sendSystemMail(email, `[OrdexaGo security] ${subject}`, body).catch((e) => console.error(`[audit] alert to ${email} failed: ${e.message}`));
    return true;
  } catch (e) {
    console.error(`[audit] alert failed: ${e.message}`);
    return false;
  }
}

/* ---------------- Amazon buyer data access ---------------- */
const istHour = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).getUTCHours();
// Amazon data may be opened 08:00–21:00 IST without an alert.
const outsideHours = (d = new Date()) => {
  const h = istHour(d);
  return h < 8 || h >= 21;
};

// Hourly counts of Amazon order views + label downloads per company (in memory, last 25 hours).
const volume = new Map(); // org → Map(hourIndex → count)
const MIN_ALERT = 30;
function bump(org, now = Date.now(), n = 1) {
  const k = String(org || "-");
  const hour = Math.floor(now / 3600000);
  let m = volume.get(k);
  if (!m) volume.set(k, (m = new Map()));
  m.set(hour, (m.get(hour) || 0) + Math.max(1, n || 1));
  for (const h of m.keys()) if (h < hour - 24) m.delete(h);
  let past = 0;
  for (let h = hour - 24; h < hour; h++) past += m.get(h) || 0;
  const avg = past / 24;
  const threshold = Math.max(MIN_ALERT, 2 * avg);
  const count = m.get(hour);
  return { count, avg, threshold, over: count >= threshold, hour };
}
const volumeAlerted = new Map();

async function amazonAccess(req, action, target = "", meta = {}) {
  const entry = await log(req, action, { target, meta });
  const who = `${req.user?.name || ""} <${req.user?.email || ""}>`;
  if (outsideHours()) alert(req.org, "Amazon order data opened outside working hours", `${who} accessed Amazon order data (${action.replace(/_/g, " ")}${target ? `: ${target}` : ""}) outside 08:00–21:00 IST.\nIP: ${ipOf(req)}`, `ooh:${req.user?._id}:${istHour()}`);
  const v = bump(req.org, Date.now(), action === "amazon_label_download" ? meta.count || 1 : 1);
  if (v.over && volumeAlerted.get(String(req.org)) !== v.hour) {
    volumeAlerted.set(String(req.org), v.hour);
    alert(req.org, "Unusual volume of Amazon order access", `${v.count} Amazon order views / label downloads in this hour (trailing hourly average ${v.avg.toFixed(1)}; alert threshold ${Math.round(v.threshold)}). Latest by ${who}.`, `vol:${v.hour}`);
  }
  return entry;
}

/* ---------------- automatic trail ---------------- */
const SETTINGS_PATHS = [/^\/api\/organization(\/|$)/, /^\/api\/amazon-orders\/account$/, /^\/api\/shopify\/(store|couriers|rules|locations)(\/|$)/, /^\/api\/gst\/(gsp|settings)(\/|$)/, /^\/api\/(branches|warehouses|currencies)(\/|$)/, /^\/api\/companies\/?$/, /^\/api\/superadmin(\/|$)/];
const SECRET_KEY = /secret|token|pass(word)?$|^pass|api_?key|geminikey|credentials/i;
// Names of the secret fields that were filled in (values never logged).
function secretFields(body, prefix = "", out = []) {
  if (!body || typeof body !== "object" || out.length > 20) return out;
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === "object") secretFields(v, `${prefix}${k}.`, out);
    else if (SECRET_KEY.test(k) && v !== "" && v != null && v !== false) out.push(prefix + k);
  }
  return out;
}

function auto(req, res) {
  if (res.locals.audited || res.statusCode >= 400 || !req.user) return;
  const path = (req.originalUrl || "").split("?")[0];
  if (req.method === "DELETE") return log(req, "delete", { target: path });
  if (["POST", "PUT", "PATCH"].includes(req.method) && SETTINGS_PATHS.some((rx) => rx.test(path)) && !/\/test$/.test(path)) {
    const secrets = secretFields(req.body);
    const fields = Object.keys(req.body || {}).filter((k) => !SENSITIVE_KEY.test(k)).slice(0, 30);
    if (secrets.length) {
      log(req, "credentials_changed", { target: path, meta: { fields, secretFields: secrets } });
      alert(req.org, "Credentials changed", `${req.user.name} <${req.user.email}> changed stored credentials (${secrets.join(", ")}) at ${path}.\nIP: ${ipOf(req)}`, `cred:${path}`);
    } else log(req, "settings_changed", { target: path, meta: { fields } });
    return;
  }
  if (req.method === "GET" && /attachment/i.test(String(res.get("content-disposition") || "")) && !/\/templates\//.test(path)) log(req, /^\/api\/attachments/.test(path) ? "file_download" : "data_export", { target: path });
}

function trail(req, res, next) {
  res.on("finish", () => {
    try {
      auto(req, res);
    } catch (e) {
      console.error(`[audit] trail: ${e.message}`);
    }
  });
  next();
}

/* ---------------- retention ---------------- */
let lastPurge = 0;
async function purgeOld(now = Date.now()) {
  if (now - lastPurge < 23 * 3600 * 1000) return 0;
  lastPurge = now;
  const r = await AuditLog.collection.deleteMany({ at: { $lt: new Date(now - RETAIN_DAYS * 86400000) } });
  if (r.deletedCount) console.log(`Security log: ${r.deletedCount} entries older than ${RETAIN_DAYS} days removed`);
  return r.deletedCount || 0;
}

module.exports = { log, alert, amazonAccess, trail, purgeOld, clean, info, outsideHours, istHour, bump, secretFields, recipients, RETAIN_DAYS, _volume: volume, _sentAt: sentAt };
