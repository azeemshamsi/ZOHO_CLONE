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
    status: { type: String, enum: ["unmatched", "matched", "categorized", "excluded"], default: "unmatched" },
    // The MGI transaction this line was matched to (or created from it).
    match: {
      type: { type: String },
      id: { type: mongoose.Schema.Types.ObjectId },
      number: { type: String },
      key: { type: String },
    },
    batch: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankStatementLine", bankStatementLineSchema);
