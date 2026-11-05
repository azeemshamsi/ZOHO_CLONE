const mongoose = require("mongoose");

// A master ledger: a named group of sales (or purchase) ledgers, like a Tally group ("Invoice Sale").
const ledgerGroupSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    kind: { type: String, enum: ["sales", "purchase"], required: true },
    name: { type: String, required: true, trim: true },
    members: { type: [String], default: [] }, // account codes
  },
  { timestamps: true }
);

module.exports = mongoose.model("LedgerGroup", ledgerGroupSchema);
