const mongoose = require("mongoose");

// One line from an imported bank statement.
const bankStatementLineSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    account: { type: String, required: true, index: true }, // bank/cash account code
    date: { type: Date, required: true },
    description: { type: String, default: "" },
    reference: { type: String, default: "" },
    deposit: { type: Number, default: 0 },
    withdrawal: { type: Number, default: 0 },
    balance: { type: Number, default: null }, // running balance from the bank file, if it had one
    seq: { type: Number, default: 0 }, // position in the imported file (keeps same-day order)
    status: { type: String, enum: ["unmatched", "matched", "categorized", "excluded"], default: "unmatched" },
    // The OrdexaGo transaction this line was matched to (or created from it).
    match: {
      type: { type: String },
      id: { type: mongoose.Schema.Types.ObjectId },
      number: { type: String },
      key: { type: String },
      rule: { type: String }, // name of the transaction rule that categorised it
      party: { type: String }, // customer / vendor it was recorded against
    },
    batch: { type: String, default: "" },
    // Added from a bank's transaction alert email (before the statement): replaced by the statement's own line
    // details when the statement comes in (source becomes "statement"); flagged if the statement doesn't have it.
    source: { type: String, default: "statement" }, // statement | alert
    alertId: { type: String }, // the alert email's Message-ID (no line twice from one email)
    alertText: { type: String }, // the alert's wording, kept after the statement replaces the description
    notInStatement: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankStatementLine", bankStatementLineSchema);
