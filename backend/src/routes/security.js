/**
 * Security: the audit log (Settings → Security). Admins of the company and the superadmin only.
 * Mounted at /api/security. The log is read-only here — there are no routes to change or delete entries.
 */
const router = require("express").Router();
const mongoose = require("mongoose");
const { ah } = require("../utils/http");
const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const audit = require("../utils/audit");

const isAdmin = (req) => req.user?.superadmin || req.membership?.role === "admin";
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).send({ message: "Only admins can open the security settings" }));
router.adminOnly = adminOnly;
router.isAdmin = isAdmin;

const ACTIONS = [
  "login", "login_failed", "login_blocked_locked", "account_locked", "logout", "invite_accepted",
  "password_changed", "password_reset_requested", "password_reset",
  "user_invited", "user_added", "user_role_changed", "user_status_changed", "user_removed", "role_created", "role_updated", "role_deleted",
  "amazon_order_view", "amazon_label_download", "amazon_order_action", "order_export", "data_export", "file_download",
  "delete", "settings_changed", "credentials_changed",
  "device_blocked", "device_approval_requested", "device_approved", "device_revoked", "device_renamed",
  "2fa_enabled", "2fa_reset", "2fa_recovery_used", "2fa_failed", "backup_failed",
];

// Entries matching the filters (newest first). Text search and user filter are applied here, not in the query.
async function entries(req, max) {
  const q = req.query;
  const filter = {};
  if (!(req.user.superadmin && q.scope === "all")) filter.organization = new mongoose.Types.ObjectId(String(req.org));
  const at = {};
  if (q.from) at.$gte = new Date(`${q.from}T00:00:00+05:30`);
  if (q.to) at.$lte = new Date(`${q.to}T23:59:59.999+05:30`);
  if (Object.keys(at).length) filter.at = at;
  if (q.action) filter.action = String(q.action);
  const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(max).lean();
  const ids = [...new Set(rows.map((r) => r.user && String(r.user)).filter(Boolean))];
  const users = new Map((ids.length ? await User.find({ _id: { $in: ids } }, { name: 1, email: 1 }).lean() : []).map((u) => [String(u._id), u]));
  let out = rows.map((r) => ({ ...r, userName: users.get(String(r.user))?.name || "", userEmail: users.get(String(r.user))?.email || r.email || "" }));
  if (q.user) out = out.filter((r) => String(r.user) === String(q.user) || r.userEmail === String(q.user).toLowerCase());
  const text = String(q.q || "").trim().toLowerCase();
  if (text) out = out.filter((r) => [r.action, r.target, r.ip, r.userName, r.userEmail, r.deviceId, r.userAgent, JSON.stringify(r.meta || {})].join(" ").toLowerCase().includes(text));
  return out;
}

router.get(
  "/log",
  adminOnly,
  ah(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const all = await entries(req, 5000);
    res.send({ rows: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit, actions: ACTIONS, capped: all.length >= 5000 });
  })
);

router.get(
  "/log.csv",
  adminOnly,
  ah(async (req, res) => {
    const all = await entries(req, 50000);
    const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const out = [["Time (IST)", "User", "Email", "Action", "Target", "IP", "Device", "Browser", "Details"].map(csv).join(",")];
    for (const r of all) out.push([new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), r.userName, r.userEmail, r.action, r.target, r.ip, r.deviceId, r.userAgent, JSON.stringify(r.meta || {})].map(csv).join(","));
    await audit.log(req, "data_export", { target: "security log CSV", meta: { rows: all.length, filters: { from: req.query.from, to: req.query.to, action: req.query.action } } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="security-log.csv"`);
    res.send("﻿" + out.join("\r\n"));
  })
);

/* ---------------- devices ---------------- */
const Joi = require("joi");
const { validate, HttpError } = require("../utils/http");
const Device = require("../models/Device");
const devices = require("../utils/devices");

// This browser: is it approved? (any signed-in user)
router.get(
  "/devices/mine",
  ah(async (req, res) => {
    const d = await devices.touch(req);
    res.send({ deviceId: devices.deviceIdOf(req), approved: devices.isAdmin(req) || !!d?.approved, admin: devices.isAdmin(req), requested: !!d?.requestedAt, name: d?.name || "" });
  })
);

// Ask the admins to approve this browser.
router.post(
  "/devices/request",
  ah(async (req, res) => {
    const { name } = validate(Joi.object({ name: Joi.string().trim().max(60).allow("") }), req.body || {});
    if (!devices.deviceIdOf(req)) throw new HttpError(400, "This browser has no device id — reload the page and try again");
    const d = await devices.touch(req, { admin: false });
    if (!d) throw new HttpError(400, "Couldn't record this device");
    if (d.approved) return res.send({ approved: true });
    await Device.updateOne({ _id: d._id }, { $set: { requestedAt: new Date(), ...(name ? { name } : {}) } });
    await audit.log(req, "device_approval_requested", { target: name || d.deviceId, meta: { deviceId: d.deviceId } });
    audit.alert(req.org, `Device approval requested by ${req.user.email}`, `${req.user.name} <${req.user.email}> asked to approve a device for Amazon order data${name ? ` ("${name}")` : ""}.\nBrowser: ${d.userAgent}\nIP: ${audit.info(req).ip}\n\nApprove or ignore it in Settings → Security → Devices.`, `devreq:${d._id}`);
    res.send({ requested: true });
  })
);

router.get(
  "/devices",
  adminOnly,
  ah(async (req, res) => {
    const list = await Device.find({ organization: req.org }).sort({ lastSeen: -1 }).limit(1000).lean();
    const ids = [...new Set(list.map((d) => String(d.user)))];
    const users = new Map((ids.length ? await User.find({ _id: { $in: ids } }, { name: 1, email: 1 }).lean() : []).map((u) => [String(u._id), u]));
    const Membership = require("../models/Membership");
    const ms = new Map((await Membership.find({ organization: req.org }, { user: 1, role: 1 }).lean()).map((m) => [String(m.user), m.role]));
    const rows = list
      .filter((d) => users.has(String(d.user)))
      .map((d) => ({ ...d, userName: users.get(String(d.user)).name, userEmail: users.get(String(d.user)).email, userIsAdmin: ms.get(String(d.user)) === "admin", current: d.deviceId === devices.deviceIdOf(req) && String(d.user) === String(req.user._id) }));
    rows.sort((a, b) => (b.requestedAt && !b.approved ? 1 : 0) - (a.requestedAt && !a.approved ? 1 : 0));
    res.send(rows);
  })
);

router.put(
  "/devices/:id",
  adminOnly,
  ah(async (req, res) => {
    const d0 = validate(Joi.object({ name: Joi.string().trim().max(60).allow(""), approved: Joi.boolean() }), req.body);
    const d = await Device.findOne({ _id: req.params.id, organization: req.org });
    if (!d) throw new HttpError(404, "Device not found");
    const owner = await User.findById(d.user, { email: 1 }).lean();
    if (d0.name !== undefined && d0.name !== d.name) {
      d.name = d0.name;
      audit.log(req, "device_renamed", { target: owner?.email || "", meta: { deviceId: d.deviceId, to: d0.name } });
    }
    if (d0.approved !== undefined && d0.approved !== d.approved) {
      d.approved = d0.approved;
      d.approvedBy = d0.approved ? req.user._id : undefined;
      d.approvedAt = d0.approved ? new Date() : undefined;
      if (!d0.approved) d.requestedAt = undefined;
      audit.log(req, d0.approved ? "device_approved" : "device_revoked", { target: owner?.email || "", meta: { deviceId: d.deviceId, label: d.name } });
    }
    await d.save();
    res.send(d);
  })
);

router.ACTIONS = ACTIONS;
module.exports = router;
