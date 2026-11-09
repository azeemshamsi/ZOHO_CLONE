/**
 * Who must use two-step login: the superadmin, company admins, and anyone whose role can open store orders or
 * shipping (Amazon / Shopify buyer data), or the Inbox / Marketing.
 */
// Inbox and Marketing show buyers' messages, phones and orders too.
const STORE = ["store_orders", "store_shipping", "inbox", "marketing"];

// For one company: the membership and its resolved permissions.
const requiredIn = (user, role, perms = {}) => !!user?.superadmin || role === "admin" || STORE.some((k) => (perms[k] || "none") !== "none");

// In any company the user belongs to.
async function required(user) {
  if (user.superadmin) return true;
  const Membership = require("../models/Membership");
  const { resolveRole } = require("./roles");
  for (const m of await Membership.find({ user: user._id, status: "active" }).lean()) {
    if (m.role === "admin") return true;
    const r = await resolveRole(m.role, m.organization, m.extraRoles);
    if (requiredIn(user, m.role, r.perms)) return true;
  }
  return false;
}

module.exports = { required, requiredIn };
