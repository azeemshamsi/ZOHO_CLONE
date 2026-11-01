const mongoose = require("mongoose");

// Planned amounts per account for one financial year (April–March), split by period.
const budgetSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true },
    fiscalYear: { type: Number, required: true }, // 2026 = 1 Apr 2026 – 31 Mar 2027
    period: { type: String, enum: ["monthly", "quarterly", "yearly"], default: "monthly" },
    lines: [{ _id: false, account: { type: String, required: true }, amounts: { type: [Number], default: [] } }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Budget", budgetSchema);
