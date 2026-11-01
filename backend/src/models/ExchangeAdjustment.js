const mongoose = require("mongoose");

// Year-end (or any date) revaluation of open foreign-currency invoices and bills.
// Posted on `date` and reversed the next day, so later payments still realise the full difference.
const exchangeAdjustmentSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    date: { type: Date, required: true },
    currency: { type: String, required: true },
    rate: { type: Number, required: true },
    notes: { type: String, default: "" },
    lines: [{ _id: false, kind: String, id: mongoose.Schema.Types.ObjectId, number: String, party: String, balance: Number, bookRate: Number, gain: Number }],
    total: { type: Number, default: 0 }, // net gain (+) / loss (−)
  },
  { timestamps: true }
);
module.exports = mongoose.model("ExchangeAdjustment", exchangeAdjustmentSchema);
