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
    },
    batch: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankStatementLine", bankStatementLineSchema);
