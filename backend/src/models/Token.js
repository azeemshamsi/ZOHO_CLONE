const mongoose = require("mongoose");

// One-time tokens for email verification and password reset. Expire after 1 hour.
const tokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  purpose: { type: String, enum: ["verify", "reset"], required: true },
  token: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

module.exports = mongoose.model("Token", tokenSchema);
