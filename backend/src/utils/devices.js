/**
 * Approved devices. Each browser has a random id (X-Device-Id). Non-admin users may open Amazon buyer data —
 * order details, labels, Easy Ship actions, exports that include Amazon orders — only from a device an admin
 * approved. Admins and the superadmin aren't restricted; their first device is approved automatically.
 */
const Device = require("../models/Device");
const audit = require("./audit");
const { HttpError } = require("./http");

const BLOCKED = "This device isn't approved for Amazon order data — ask your admin to approve it";
const isAdmin = (req) => !!(req.user?.superadmin || req.membership?.role === "admin");
const deviceIdOf = (req) => {
  const id = String(req.get?.("x-device-id") || "").trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : "";
};

// Record the device the user is on (sign-in, app start). Returns the device, or null without a device id.
async function touch(req, { user = req.user, org = req.org, admin = isAdmin(req) } = {}) {
  const deviceId = deviceIdOf(req);
  if (!deviceId || !user || !org) return null;
  try {
    const { ip, userAgent } = audit.info(req);
    let d = await Device.findOne({ organization: org, user: user._id, deviceId });
    if (!d) {
      const auto = admin && !(await Device.exists({ organization: org, user: user._id, approved: true }));
      d = await Device.create({ organization: org, user: user._id, deviceId, userAgent, ip, lastSeen: new Date(), approved: auto, approvedAt: auto ? new Date() : undefined });
      if (auto) audit.log(req, "device_approved", { organization: org, user: user._id, target: deviceId, meta: { auto: true } });
      return d;
    }
    if (!d.lastSeen || Date.now() - d.lastSeen.getTime() > 10 * 60000 || d.userAgent !== userAgent) {
      await Device.updateOne({ _id: d._id }, { $set: { lastSeen: new Date(), userAgent, ip } });
    }
    return d;
  } catch (e) {
    console.error(`[devices] touch failed: ${e.message}`);
    return null;
  }
}

// Throws 403 unless the request may open Amazon buyer data from this device.
async function requireApproved(req, what = "Amazon order data") {
  if (isAdmin(req)) return true;
  const deviceId = deviceIdOf(req);
  const d = deviceId ? await Device.findOne({ organization: req.org, user: req.user._id, deviceId }) : null;
  if (d && d.approved) return true;
  if (deviceId && !d) await touch(req, { admin: false });
  audit.log(req, "device_blocked", { target: what, meta: { deviceId, known: !!d } });
  audit.alert(req.org, `Blocked: ${req.user.email} tried to open Amazon data from an unapproved device`, `${req.user.name} <${req.user.email}> tried to open ${what} from a device that isn't approved.\nDevice: ${deviceId || "(none)"}\nIP: ${audit.info(req).ip}\nBrowser: ${audit.info(req).userAgent}\n\nApprove it in Settings → Security → Devices if this is expected.`, `devblock:${req.user._id}:${deviceId}`);
  throw new HttpError(403, BLOCKED, { code: "device_not_approved", deviceId, requested: !!d?.requestedAt });
}

// Device check, then the access log + alerts.
async function amazonData(req, action, target, meta) {
  await requireApproved(req, `${action.replace(/_/g, " ")}${target ? ` (${target})` : ""}`);
  return audit.amazonAccess(req, action, target, meta);
}

module.exports = { touch, requireApproved, amazonData, isAdmin, deviceIdOf, BLOCKED };
