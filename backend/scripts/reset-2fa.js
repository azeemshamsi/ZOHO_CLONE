#!/usr/bin/env node
/**
 * Emergency: turn off two-step login for one user (e.g. the superadmin lost their phone and recovery codes).
 * Run on the server:  cd /opt/ordexago/backend && node scripts/reset-2fa.js azeem@zikrziba.com
 * The user sets up two-step login again at their next sign-in. The reset is written to the security log.
 */
require("../src/config/env");
const mongoose = require("mongoose");
const connect = require("../src/config/database");

(async () => {
  const email = String(process.argv[2] || "").toLowerCase().trim();
  if (!email) {
    console.error("Usage: node scripts/reset-2fa.js <email>");
    process.exit(1);
  }
  await connect();
  const User = require("../src/models/User");
  const AuditLog = require("../src/models/AuditLog");
  const u = await User.findOne({ email });
  if (!u) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  u.totp = { enabled: false, secret: "", pendingSecret: "", recoveryCodes: [], lastStep: -1 };
  u.tokenVersion = (u.tokenVersion || 0) + 1;
  u.lockedUntil = null;
  await u.save();
  await AuditLog.create({ organization: u.organization, user: u._id, email, action: "2fa_reset", target: email, meta: { via: "server script" }, at: new Date() });
  console.log(`Two-step login reset for ${email}. They'll set it up again at their next sign-in.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
