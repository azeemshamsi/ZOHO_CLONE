const mongoose = require("mongoose");

// A GSTR-2B (or 2A) statement uploaded for reconciliation, and the decisions taken on each line.
const gstr2bSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    period: { type: String, required: true }, // "2026-07"
    fileName: { type: String, default: "" },
    docs: { type: [mongoose.Schema.Types.Mixed], default: [] },
    accepted: { type: [String], default: [] }, // "gstin|number" the user accepted despite differences
    by: { type: String, default: "" },
  },
  { timestamps: true }
);
gstr2bSchema.index({ organization: 1, period: 1 }, { unique: true });
module.exports = mongoose.model("Gstr2b", gstr2bSchema);
