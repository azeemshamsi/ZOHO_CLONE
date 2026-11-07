const mongoose = require("mongoose");

// Amazon's own figures for one month (from its MTR reports), kept when they're imported or checked, so the GSTR-1
// check can compare document by document without uploading the MTR again. Not accounting data.
// docs: [{ k: "invoice" | "creditNote", n: number, d: date, b2b, pos, t: taxable (signed), l: [{ h: hsn, r: rate, t, s: sku }] }]
const schema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    gstin: { type: String, required: true },
    month: { type: String, required: true }, // YYYY-MM
    docs: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { timestamps: true }
);
schema.index({ organization: 1, gstin: 1, month: 1 }, { unique: true });

module.exports = mongoose.model("AmazonMonth", schema);
