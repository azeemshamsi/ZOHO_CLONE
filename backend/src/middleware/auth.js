const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const env = require("../config/env");
const User = require("../models/User");
const Membership = require("../models/Membership");
const { resolveRole } = require("../utils/roles");

// Which company the request is for: the X-Org header (company switcher), else the user's last company.
async function membershipFor(user, wanted) {
  if (wanted && mongoose.isValidObjectId(wanted)) {
    const m = await Membership.findOne({ user: user._id, organization: wanted, status: "active" });
    if (m) return m;
  }
  let m = await Membership.findOne({ user: user._id, organization: user.organization });
  if (!m) m = await Membership.create({ user: user._id, organization: user.organization, role: user.role || "admin", status: user.status === "inactive" ? "inactive" : "active" }).catch(() => Membership.findOne({ user: user._id, organization: user.organization }));
  if (m && m.status === "active") return m;
  return Membership.findOne({ user: user._id, status: "active" });
}

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).send({ message: "Please log in" });
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    const user = await User.findById(payload._id);
    if (!user || user.status === "invited") return res.status(401).send({ message: "Please log in" });
    const m = await membershipFor(user, req.get("x-org"));
    if (!m) return res.status(401).send({ message: "Your access has been removed. Ask an admin." });
    const r = await resolveRole(m.role, m.organization);
    user.role = m.role; // in memory only: the role in this company
    req.user = user;
    req.org = m.organization;
    req.membership = m;
    req.perms = r.perms;
    req.roleInfo = r;
    next();
  } catch (e) {
    return res.status(401).send({ message: "Session expired, please log in again" });
  }
};
module.exports.membershipFor = membershipFor;
