const mongoose = require("mongoose");

// A return the business has filed on the portal (marked here with its ARN), or an uploaded GSTR-2B.
const gstFilingSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    form: { type: String, required: true }, // GSTR-1, GSTR-3B, GSTR-9, IFF, PMT-06, TDS payment, …
    period: { type: String, required: true }, // "2026-07", "2025-26", …
    arn: { type: String, default: "" },
    filedOn: { type: Date },
    amountPaid: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    summary: { type: mongoose.Schema.Types.Mixed }, // the figures at the time of filing
    by: { type: String, default: "" },
  },
  { timestamps: true }
);
gstFilingSchema.index({ organization: 1, form: 1, period: 1 }, { unique: true });
module.exports = mongoose.model("GstFiling", gstFilingSchema);
