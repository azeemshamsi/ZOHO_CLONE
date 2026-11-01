const jwt = require("jsonwebtoken");
const env = require("../config/env");
const User = require("../models/User");

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).send({ message: "Please log in" });
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    const user = await User.findById(payload._id);
    if (!user || user.status !== "active") return res.status(401).send({ message: "Please log in" });
    req.user = user;
    req.org = user.organization;
    next();
  } catch (e) {
    return res.status(401).send({ message: "Session expired, please log in again" });
  }
};
