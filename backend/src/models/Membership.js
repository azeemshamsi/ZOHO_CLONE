const mongoose = require("mongoose");

// A user's access to a company. One person can belong to several companies, with a role in each.
const membershipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    role: { type: String, default: "admin" }, // built-in key, or "custom:<roleId>"
    status: { type: String, enum: ["active", "invited", "inactive"], default: "active" },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);
membershipSchema.index({ user: 1, organization: 1 }, { unique: true });
membershipSchema.index({ organization: 1 });
module.exports = mongoose.model("Membership", membershipSchema);
