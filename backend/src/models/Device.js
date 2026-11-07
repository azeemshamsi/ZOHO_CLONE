const mongoose = require("mongoose");

// A browser a user signs in from (random id kept in the browser's localStorage, sent as X-Device-Id).
// Non-admin users can open Amazon buyer data (order details, labels, Easy Ship, exports) only from an approved device.
const deviceSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    deviceId: { type: String, required: true },
    name: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    approved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    requestedAt: { type: Date }, // the user asked for approval
    lastSeen: { type: Date },
  },
  { timestamps: true }
);
deviceSchema.index({ organization: 1, user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("Device", deviceSchema);
